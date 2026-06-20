// GitHub 実コードを読むためのクライアント（素の fetch のみ・Node/bun 共通）。
// mdcollab の src/github/client.ts を移植し、行範囲指定（トークン節約）と
// 参照リポの allowlist を足した。ドキュメントは陳腐化しうるので「真実はコード」を支える土台。

const API = "https://api.github.com";
const MAX_FILE = 32 * 1024; // 1 ファイル 32KB 上限（tool_result 肥大＝トークン爆発を防ぐ）
const MAX_TREE = 800; // ツリー一覧の件数上限
const MAX_RANGE_LINES = 400; // 行範囲指定時の最大行数

export interface GitHub {
  /** allowlist 内のリポか検証して正規化。NG は { error } を返す。 */
  resolveRepo(repo?: string): { repo: string } | { error: string };
  listTree(repo: string): Promise<string>;
  readFile(repo: string, path: string, startLine?: number, endLine?: number): Promise<string>;
  searchCode(repo: string, query: string): Promise<string>;
  repos: string[];
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

    async listTree(repo) {
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
        const shown = paths.slice(0, MAX_TREE).join("\n");
        return paths.length > MAX_TREE || j.truncated ? `${shown}\n（…${MAX_TREE} 件で切り詰め）` : shown;
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

    async searchCode(repo, query) {
      if (!token) return "（コード検索には GITHUB_TOKEN が必要です。list_repo_tree + read_repo_file を使ってください）";
      try {
        const q = encodeURIComponent(`${query} repo:${repo}`);
        const res = await fetch(`${API}/search/code?q=${q}&per_page=10`, {
          headers: { ...headers(token), Accept: "application/vnd.github.text-match+json" },
        });
        if (!res.ok) return `（${repo} のコード検索に失敗: HTTP ${res.status}）`;
        const j = (await res.json()) as { items?: { path?: string }[] };
        const paths = (j.items ?? []).map((i) => i.path).filter(Boolean);
        if (paths.length === 0) return `（"${query}" に一致するファイルは見つかりませんでした）`;
        return `一致したファイル（read_repo_file で中身を読む）:\n${paths.join("\n")}`;
      } catch (e) {
        return `（${repo} のコード検索でエラー: ${e instanceof Error ? e.message : "unknown"}）`;
      }
    },
  };
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
