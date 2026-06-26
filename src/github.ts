// GitHub 実コードを読むためのクライアント（素の fetch のみ・Node/bun 共通）。
// mdcollab の src/github/client.ts を移植し、行範囲指定（トークン節約）と
// 参照リポの allowlist を足した。ドキュメントは陳腐化しうるので「真実はコード」を支える土台。

const API = "https://api.github.com";
const MAX_FILE = 32 * 1024; // 1 ファイル 32KB 上限（tool_result 肥大＝トークン爆発を防ぐ）
const MAX_TREE = 800; // ファイル一覧（小規模リポ/サブディレクトリ）の件数上限
const MAX_OVERVIEW_DIRS = 60; // モノレポ概要で出すディレクトリ数の上限
const MAX_MANIFESTS = 200; // モノレポ概要で出す manifest（パッケージの目印）数の上限
const MAX_RANGE_LINES = 400; // 行範囲指定時の最大行数
const SEARCH_RESULTS = 20; // コード検索の取得件数（モノレポで上位に埋もれないよう 10→20）

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

    async searchCode(repo, query, path) {
      if (!token) return "（コード検索には GITHUB_TOKEN が必要です。list_repo_tree + read_repo_file を使ってください）";
      try {
        // path 指定時は path: 修飾子で範囲を絞る（モノレポで該当パッケージ配下だけ探す）。
        const scope = path ? ` path:${path.replace(/^\/+|\/+$/g, "")}` : "";
        const q = encodeURIComponent(`${query} repo:${repo}${scope}`);
        const res = await fetch(`${API}/search/code?q=${q}&per_page=${SEARCH_RESULTS}`, {
          headers: { ...headers(token), Accept: "application/vnd.github.text-match+json" },
        });
        if (!res.ok) return `（${repo} のコード検索に失敗: HTTP ${res.status}）`;
        const j = (await res.json()) as { total_count?: number; items?: { path?: string }[] };
        const paths = (j.items ?? []).map((i) => i.path).filter(Boolean);
        if (paths.length === 0) return `（"${query}"${path ? `（path:${path}）` : ""} に一致するファイルは見つかりませんでした）`;
        const more =
          (j.total_count ?? paths.length) > paths.length
            ? `\n（全 ${j.total_count} 件中 上位 ${paths.length} 件。絞りたい時は path で範囲指定）`
            : "";
        return `一致したファイル（read_repo_file で中身を読む）:\n${paths.join("\n")}${more}`;
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
