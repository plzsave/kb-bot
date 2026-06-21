// GitHub の closed issue とそのコメントを取得する「書き込み側バッチ」用クライアント。
// agent がコードを読む src/github.ts とは関心が違う（allowlist 検証も不要）ので分離する。
// 一覧 payload だけでフィルタできるよう、issue list の生フィールドをそのまま型に持つ。

const API = "https://api.github.com";
const PER_PAGE = 100;

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  comments: number; // コメント"数"（本文は別途取得）
  closed_at: string | null;
  updated_at: string;
  html_url: string;
  pull_request?: unknown; // 存在すれば PR（issue ではない）
}

export interface IssueComment {
  body: string;
  user: { login: string } | null;
  created_at: string;
}

export interface FullIssue {
  issue: RawIssue;
  comments: IssueComment[];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// レート制限を尊重して fetch する。残数 0 は reset まで、二次制限(403/429)は Retry-After 待機。
async function ghFetch(url: string, token: string | undefined, log: (m: string) => void): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: headers(token) });
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      if (remaining === 0) {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        const wait = Math.max(1000, reset - Date.now());
        log(`  レート制限: ${Math.ceil(wait / 1000)}s 待機`);
        await sleep(wait);
        continue;
      }
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        log(`  二次レート制限: ${retryAfter}s 待機`);
        await sleep(retryAfter * 1000);
        continue;
      }
    }
    return res;
  }
  throw new Error(`GitHub API: レート制限の再試行上限に達しました (${url})`);
}

// Link ヘッダの rel="next" を返す（無ければ undefined）。
function nextLink(res: Response): string | undefined {
  const link = res.headers.get("link");
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

/** closed issue を取得する。since(ISO) 以降に更新されたものに絞れる。PR は除外。max で件数上限。 */
export async function listClosedIssues(
  repo: string,
  token: string | undefined,
  opts: { since?: string; max?: number; log?: (m: string) => void } = {},
): Promise<RawIssue[]> {
  const log = opts.log ?? (() => {});
  const params = new URLSearchParams({
    state: "closed",
    sort: "updated",
    direction: "asc",
    per_page: String(PER_PAGE),
  });
  if (opts.since) params.set("since", opts.since);
  let url: string | undefined = `${API}/repos/${repo}/issues?${params}`;
  const out: RawIssue[] = [];
  while (url) {
    const res = await ghFetch(url, token, log);
    if (!res.ok) throw new Error(`issue 一覧取得に失敗: ${repo} HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as RawIssue[];
    for (const it of page) {
      if (it.pull_request) continue; // PR は除外
      out.push(it);
      if (opts.max && out.length >= opts.max) return out;
    }
    url = nextLink(res);
  }
  return out;
}

/** issue のコメント本文を投稿順に取得する（N+1。フィルタ通過分だけ呼ぶこと）。 */
export async function fetchComments(
  repo: string,
  number: number,
  token: string | undefined,
  log: (m: string) => void = () => {},
): Promise<IssueComment[]> {
  let url: string | undefined = `${API}/repos/${repo}/issues/${number}/comments?per_page=${PER_PAGE}`;
  const out: IssueComment[] = [];
  while (url) {
    const res = await ghFetch(url, token, log);
    if (!res.ok) throw new Error(`コメント取得に失敗: ${repo}#${number} HTTP ${res.status}`);
    out.push(...((await res.json()) as IssueComment[]));
    url = nextLink(res);
  }
  return out;
}
