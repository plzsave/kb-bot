// GitHub 実コードを読むためのクライアント（素の fetch のみ・Node/bun 共通）。
// mdcollab の src/github/client.ts を移植し、行範囲指定（トークン節約）と
// 参照リポの allowlist を足した。ドキュメントは陳腐化しうるので「真実はコード」を支える土台。

const API = "https://api.github.com";
const MAX_FILE = 32 * 1024; // 1 ファイル 32KB 上限（tool_result 肥大＝トークン爆発を防ぐ）
const MAX_TREE = 800; // ファイル一覧（小規模リポ/サブディレクトリ）の件数上限
const MAX_OVERVIEW_DIRS = 60; // モノレポ概要で出すディレクトリ数の上限
const MAX_MANIFESTS = 200; // モノレポ概要で出す manifest（パッケージの目印）数の上限
const MAX_RANGE_LINES = 400; // 行範囲指定時の最大行数
const SEARCH_RESULTS = 20; // コード検索で返す path:line 行の総数上限（モノレポで上位に埋もれないよう）
const MAX_GREP_FILES = 300; // grep のため取得する候補ファイル数の上限。単一リポ〜中規模を全走査できる水準に。
// 超大規模（モノレポ）ではこの cap を超える＝パス名一致を優先した上位のみ走査。取りこぼしは path 引数で絞って回避。
const GREP_CONCURRENCY = 24; // blob 並列取得数（逐次だと大きいリポで遅い）
const MAX_GREP_BLOB = 256 * 1024; // grep 対象にする 1 ファイルの最大バイト（巨大生成物/lockを除外）
const MAX_MATCHES_PER_FILE = 3; // 1 ファイルから返す一致行の上限（結果をファイル横断で散らす）

// grep 対象にするテキスト系拡張子。バイナリ・巨大生成物・lock/min を除外して無駄な取得を避ける。
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|bash|zsh|sql|md|mdx|json|jsonc|toml|ya?ml|txt|html?|css|scss|sass|less|vue|svelte|gradle|xml|ini|cfg|conf|proto|graphql|gql|dockerfile)$/i;
const NON_TEXT =
  /(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/i;

/** grep 対象にするテキストファイルか（拡張子で判定・lock/min は除外）。純関数。 */
export function isTextPath(path: string): boolean {
  if (NON_TEXT.test(path)) return false;
  return TEXT_EXT.test(path);
}

/** 検索語を空白区切りで語に分割（小文字化・トリム・重複除去）。識別子（TTL_MS 等）は分割しない。純関数。 */
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * fetch 対象の候補ファイルを選定して並べる純関数。全ファイルを取りに行くと遅い/レート制限に当たるため、
 * (1) テキスト系のみに絞り、(2) パス名に検索語を多く含むものを優先（cache.ts＝キャッシュ質問など
 * ファイル名の直感が効く場面を安く当てる）、(3) 一致0のファイルも後ろに残す（内容一致を拾うため）。
 * 安定ソート（同スコアは元順）で決定的。cap 件に切り詰める。副作用なし・入力不変。
 */
export function selectSearchCandidates(paths: string[], terms: string[], cap = MAX_GREP_FILES): string[] {
  const textish = paths.filter(isTextPath);
  if (terms.length === 0) return textish.slice(0, cap);
  const score = (p: string) => {
    const lp = p.toLowerCase();
    return terms.reduce((n, t) => n + (lp.includes(t) ? 1 : 0), 0);
  };
  const indexed = textish.map((p, i) => ({ p, i, s: score(p) }));
  indexed.sort((a, b) => b.s - a.s || a.i - b.i); // スコア降順・同スコアは元順（安定）
  return indexed.slice(0, cap).map((x) => x.p);
}

export interface GrepMatch {
  path: string;
  line: number; // 1 始まり
  text: string;
}

/**
 * 候補ファイル（path + 内容）を grep して path:line 一致を返す純関数（ネットワーク非依存＝テスト可能）。
 * まず「同一行に全語（AND）」で厳密一致を探し、総数 0 なら「いずれかの語（OR）」に緩めて必ず何かを返す
 * （空を返すと LLM が『コードに無い』と誤解して stale doc にフォールバックするため。broadened で明示）。
 * files の順序（＝候補ランク順）を保ち、各ファイル内は行番号順。maxPerFile でファイル横断に散らし、
 * maxTotal で全体を打ち切る。副作用なし・入力不変。
 */
export function grepFiles(
  files: { path: string; content: string }[],
  terms: string[],
  opts: { maxTotal?: number; maxPerFile?: number } = {},
): { matches: GrepMatch[]; broadened: boolean } {
  const maxTotal = opts.maxTotal ?? SEARCH_RESULTS;
  const maxPerFile = opts.maxPerFile ?? MAX_MATCHES_PER_FILE;
  if (terms.length === 0) return { matches: [], broadened: false };

  const scan = (all: boolean): GrepMatch[] => {
    const out: GrepMatch[] = [];
    for (const f of files) {
      let perFile = 0;
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i]!.toLowerCase();
        const hit = all ? terms.every((t) => lower.includes(t)) : terms.some((t) => lower.includes(t));
        if (!hit) continue;
        out.push({ path: f.path, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
        if (++perFile >= maxPerFile) break;
        if (out.length >= maxTotal) return out;
      }
      if (out.length >= maxTotal) break;
    }
    return out;
  };

  const strict = scan(true);
  if (strict.length > 0) return { matches: strict, broadened: false };
  return { matches: scan(false), broadened: true };
}

// パッケージ/プロジェクトの根を示すファイル名。モノレポで「どこに何があるか」の地図になる。
const MANIFEST =
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|setup\.py|Gemfile|composer\.json|[^/]+\.csproj)$/i;

export interface GitHub {
  /** allowlist 内のリポか検証して正規化。NG は { error } を返す。 */
  resolveRepo(repo?: string): { repo: string } | { error: string };
  /** subdir 指定でその配下に絞る。未指定かつ大規模なら概要（地図）を返す。 */
  listTree(repo: string, subdir?: string): Promise<string>;
  readFile(repo: string, path: string, startLine?: number, endLine?: number): Promise<string>;
  /** path 指定で検索範囲をサブディレクトリに絞る（モノレポで該当パッケージだけ探す）。 */
  searchCode(repo: string, query: string, path?: string): Promise<string>;
  repos: string[];
}

/**
 * ツリー（blob パス一覧）を LLM 向け文字列に整形する純関数（ネットワーク非依存＝単体テスト可能）。
 * - subdir 指定: その配下のファイルだけ列挙（モノレポで該当パッケージに絞る）。
 * - 未指定で小規模（MAX_TREE 以下）: 全ファイルを列挙（従来挙動）。
 * - 未指定で大規模（モノレポ）: トップ階層の概要＋manifest の場所を返し、subdir での深掘りを促す。
 *   全ファイルを並べると MAX_TREE 件で切れて目的のパッケージが地図から消えるのを防ぐ。
 */
export function renderTree(paths: string[], subdir?: string): string {
  if (paths.length === 0) return "（ファイルが見つかりません）";

  if (subdir) {
    const prefix = subdir.replace(/^\/+|\/+$/g, "") + "/";
    const inDir = paths.filter((p) => p.startsWith(prefix));
    if (inDir.length === 0) return `（${subdir} 配下にファイルが見つかりません）`;
    const shown = inDir.slice(0, MAX_TREE).join("\n");
    return inDir.length > MAX_TREE
      ? `${shown}\n（…${MAX_TREE} 件で切り詰め。subdir をさらに絞ってください）`
      : shown;
  }

  if (paths.length <= MAX_TREE) return paths.join("\n");

  // 大規模（モノレポ）→ 地図にして subdir 深掘りへ誘導
  const counts = new Map<string, number>();
  for (const p of paths) {
    const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root files)";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const dirs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_OVERVIEW_DIRS)
    .map(([dir, n]) => (dir === "(root files)" ? `(root files)  (${n})` : `${dir}/  (${n})`))
    .join("\n");
  const manifests = paths.filter((p) => MANIFEST.test(p)).slice(0, MAX_MANIFESTS);

  return [
    `（${paths.length} ファイルと大きいため概要を表示。subdir を指定して深掘りしてください）`,
    "",
    "## トップ階層（ディレクトリ / ファイル数）",
    dirs,
    "",
    "## パッケージの目印（manifest の場所）",
    manifests.length ? manifests.join("\n") : "（manifest が見つかりません）",
  ].join("\n");
}

function headers(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kb-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// 秘匿ファイルの取得を拒否（本文に「.env を読んで貼れ」等を仕込まれる経路を塞ぐ）。
function rejectSecret(path: string): string | null {
  for (const seg of path.trim().toLowerCase().split("/").filter(Boolean)) {
    if (seg === ".env" || seg.startsWith(".env.")) return "環境変数ファイル（.env）は取得できません";
    if (seg.endsWith(".pem") || seg.endsWith(".key")) return "鍵ファイル（.pem/.key）は取得できません";
    if (seg.startsWith("secrets")) return "秘密情報ファイル（secrets*）は取得できません";
    if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(seg)) return "SSH 秘密鍵は取得できません";
  }
  return null;
}

// path 検証：空・絶対パス・URL・親ディレクトリ参照・秘匿ファイルを拒否（パストラバーサル/SSRF/秘密持ち出し防止）。
export function rejectPath(path: string): string | null {
  if (typeof path !== "string" || path.trim() === "") return "path が空です";
  const p = path.trim();
  if (p.startsWith("/")) return "絶対パスは指定できません";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return "URL は指定できません";
  if (p.split("/").some((seg) => seg === "..")) return "親ディレクトリ（..）は参照できません";
  return rejectSecret(p);
}

function decodeBase64(b64: string): string {
  return Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf8");
}

function withLineNumbers(text: string, from: number): string {
  return text
    .split("\n")
    .map((l, i) => `${String(from + i).padStart(5)}| ${l}`)
    .join("\n");
}

// tree の blob を sha 指定で並列取得しテキスト化する（raw.githubusercontent はプライベート不可のため
// blob API を使う＝トークンでプライベートリポも読める）。候補順を保った {path, content} を返す。
// 取得失敗・非base64はスキップ（部分結果でも grep する＝空振りより有用）。副作用はネットワークのみ。
async function fetchTextBlobs(
  token: string | undefined,
  repo: string,
  items: { path: string; sha: string }[],
  concurrency = GREP_CONCURRENCY,
): Promise<{ path: string; content: string }[]> {
  const byPath = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++]!;
      try {
        const res = await fetch(`${API}/repos/${repo}/git/blobs/${it.sha}`, { headers: headers(token) });
        if (!res.ok) continue;
        const j = (await res.json()) as { content?: string; encoding?: string };
        if (j.content == null || j.encoding !== "base64") continue;
        byPath.set(it.path, decodeBase64(j.content));
      } catch {
        /* 個別失敗はスキップ（部分結果で grep） */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  // 候補順（selectSearchCandidates の並び）を保って返す。並列取得の完了順に依存しない＝決定的。
  return items.filter((it) => byPath.has(it.path)).map((it) => ({ path: it.path, content: byPath.get(it.path)! }));
}

export function createGitHub(token: string | undefined, repos: string[]): GitHub {
  const allow = new Set(repos.map((r) => r.toLowerCase()));

  return {
    repos,

    resolveRepo(repo) {
      if (!repo) {
        if (repos.length === 1) return { repo: repos[0]! };
        return { error: `repo を指定してください（参照可能: ${repos.join(", ")}）` };
      }
      const norm = repo.trim();
      if (!allow.has(norm.toLowerCase())) {
        return { error: `リポ ${norm} は参照できません（許可: ${repos.join(", ")}）` };
      }
      return { repo: norm };
    },

    async listTree(repo, subdir) {
      try {
        const metaRes = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
        if (!metaRes.ok) return `（${repo} のメタ取得に失敗: HTTP ${metaRes.status}）`;
        const meta = (await metaRes.json()) as { default_branch?: string };
        const branch = meta.default_branch ?? "main";
        const res = await fetch(`${API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
          headers: headers(token),
        });
        if (!res.ok) return `（${repo} のツリー取得に失敗: HTTP ${res.status}）`;
        const j = (await res.json()) as { tree?: { path?: string; type?: string }[]; truncated?: boolean };
        const paths = (j.tree ?? []).filter((t) => t.type === "blob" && t.path).map((t) => t.path as string);
        if (paths.length === 0) return `（${repo} にファイルが見つかりません）`;
        const view = renderTree(paths, subdir);
        return j.truncated
          ? `${view}\n（注: GitHub 側でツリーが切り詰められています。一部ファイルが欠落している可能性）`
          : view;
      } catch (e) {
        return `（${repo} のツリー取得でエラー: ${e instanceof Error ? e.message : "unknown"}）`;
      }
    },

    async readFile(repo, path, startLine, endLine) {
      const reason = rejectPath(path);
      if (reason) return `（ファイル取得拒否: ${reason}）`;
      try {
        const url = `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
        const res = await fetch(url, { headers: headers(token) });
        if (!res.ok) return `（${repo} の ${path} 取得に失敗: HTTP ${res.status}）`;
        const j = (await res.json()) as { content?: string; encoding?: string; type?: string };
        if (j.type !== "file" || j.content == null || j.encoding !== "base64") {
          return `（${repo} の ${path} はテキストファイルとして取得できません）`;
        }
        const text = decodeBase64(j.content);

        // 行範囲が指定されたら該当行だけ＋行番号付きで返す（引用しやすく・トークン節約）。
        if (startLine != null) {
          const lines = text.split("\n");
          const from = Math.max(1, Math.floor(startLine));
          const to = Math.min(lines.length, Math.floor(endLine ?? from + MAX_RANGE_LINES - 1), from + MAX_RANGE_LINES - 1);
          const slice = lines.slice(from - 1, to).join("\n");
          return `# ${path} (L${from}-L${to} / 全${lines.length}行)\n${withLineNumbers(slice, from)}`;
        }
        if (text.length > MAX_FILE) {
          return `# ${path}（先頭32KBのみ。続きは行範囲で指定）\n${text.slice(0, MAX_FILE)}`;
        }
        return `# ${path}\n${withLineNumbers(text, 1)}`;
      } catch (e) {
        return `（${repo} の ${path} 取得でエラー: ${e instanceof Error ? e.message : "unknown"}）`;
      }
    },

    // コード検索は GitHub の /search/code に依存しない自前 grep で行う。理由: レガシー code search API は
    // fine-grained PAT では常に 0 件を返し（エラーでなく静かに空）、小規模リポは classic でもインデックス
    // 欠落しうる。tree（既定ブランチ）→ 候補ファイルを blob で並列取得 → ローカル grep なら、トークン種別にも
    // GitHub のインデックスにも依存せず path:line で当てられる。read_repo_file で使う root（tree+blob）と同じ権限。
    async searchCode(repo, query, path) {
      const terms = searchTerms(query);
      if (terms.length === 0) return "（検索語が空でした）";
      try {
        const metaRes = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
        if (!metaRes.ok) return `（${repo} のメタ取得に失敗: HTTP ${metaRes.status}）`;
        const branch = ((await metaRes.json()) as { default_branch?: string }).default_branch ?? "main";
        const treeRes = await fetch(`${API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
          headers: headers(token),
        });
        if (!treeRes.ok) return `（${repo} のツリー取得に失敗: HTTP ${treeRes.status}）`;
        const tree = (await treeRes.json()) as {
          tree?: { path?: string; type?: string; sha?: string; size?: number }[];
          truncated?: boolean;
        };

        // path 指定時はその配下に絞る（モノレポで該当パッケージだけ探す）。秘匿ファイル・巨大ファイルは除外。
        const prefix = path ? path.replace(/^\/+|\/+$/g, "") + "/" : "";
        const blobs = (tree.tree ?? []).filter(
          (n): n is { path: string; type: string; sha: string; size?: number } =>
            n.type === "blob" &&
            typeof n.path === "string" &&
            typeof n.sha === "string" &&
            (!prefix || n.path.startsWith(prefix)) &&
            !rejectPath(n.path) &&
            (n.size == null || n.size <= MAX_GREP_BLOB),
        );

        // 候補を選定（テキスト系＋パス名一致を優先）してから blob を並列取得＝取得数を cap で抑える。
        const candidatePaths = selectSearchCandidates(
          blobs.map((b) => b.path),
          terms,
        );
        const shaByPath = new Map(blobs.map((b) => [b.path, b.sha]));
        const items = candidatePaths.map((p) => ({ path: p, sha: shaByPath.get(p)! }));
        const files = await fetchTextBlobs(token, repo, items);

        const { matches, broadened } = grepFiles(files, terms, { maxTotal: SEARCH_RESULTS });
        const scopeNote = path ? `（path:${path}）` : "";
        if (matches.length === 0) {
          return `（"${query}"${scopeNote} に一致する行は見つかりませんでした。list_repo_tree で構成を確認し read_repo_file で読むこともできます）`;
        }
        const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
        const head = broadened
          ? `一致（いずれかの語・厳密一致なし。read_repo_file で確認）:`
          : `一致した箇所（read_repo_file で該当ファイルを読む）:`;
        const truncNote = tree.truncated ? "\n（注: ツリーが GitHub 側で切り詰め。一部ファイル未走査の可能性）" : "";
        return `${head}\n${lines}${truncNote}`;
      } catch (e) {
        return `（${repo} のコード検索でエラー: ${e instanceof Error ? e.message : "unknown"}）`;
      }
    },
  };
}

/**
 * リポの HEAD（既定ブランチ）に path が存在するか。kb-prune の code_drift 判定用。
 * true=存在 / false=404 / null=判定不能（権限・ネットワーク等。誤検知を避け null は flag しない）。
 */
export async function repoFileExists(
  token: string | undefined,
  repo: string,
  path: string,
): Promise<boolean | null> {
  if (rejectPath(path)) return null; // 不正パスは判定対象外
  try {
    const url = `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
    const res = await fetch(url, { headers: headers(token) });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    return null;
  }
}

/** 環境変数から GitHub を構成。KB_GITHUB_REPOS 未設定なら undefined（機能オフ）。 */
export function loadGitHub(): GitHub | undefined {
  const reposRaw = process.env.KB_GITHUB_REPOS?.trim();
  if (!reposRaw) return undefined;
  const repos = reposRaw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (repos.length === 0) return undefined;
  return createGitHub(process.env.GITHUB_TOKEN?.trim() || undefined, repos);
}
