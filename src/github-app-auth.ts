// GitHub App の installation token 供給源（issue #59）。
// PAT は期限切れのたびに手動ローテーションが要るが、App は無期限の秘密鍵から短命トークン（約1h）を
// 実行時に都度発行できる＝ローテーション作業自体を構造的に無くす。素の fetch ＋ node:crypto のみで、
// 外部依存は追加しない（GitHub クライアントの「素の fetch のみ」方針を守る）。

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
// installation token の期限（約1h）より 5 分早く再取得する。境界ぎわのトークンを配って
// リクエスト途中で 401 になる事故を避ける＝呼び出し側にリトライを持たせずに済む。
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * トークン供給源。静的 PAT も App の短命トークンも同じ形に揃える
 * （利用側は「毎回 await して使う」だけで、更新の有無を知らなくてよい）。
 */
export type TokenSource = () => Promise<string | undefined>;

function base64url(input: string | Buffer): string {
  return Buffer.from(input as Buffer | string).toString("base64url");
}

/**
 * GitHub App 認証用の RS256 JWT を組み立てる純関数（時刻は引数注入＝テスト可能）。
 * iat を 60 秒過去にするのは GitHub との時計ずれ対策（公式推奨）。exp の上限は 10 分なので
 * 余裕を見て 9 分にする（超過すると 401）。
 */
export function buildAppJwt(appId: string, privateKeyPem: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * installation token を取得・キャッシュし、期限 5 分前を切ったら再取得する TokenSource を作る。
 * fetch/時計は注入可能（ネットワークに出ないテストのため）。並行呼び出しは取得中の Promise を
 * 共有して二重取得しない。失敗は例外で伝える（トークン・PEM は絶対にメッセージへ含めない）。
 */
export function createAppTokenSource(opts: {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}): TokenSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const nowFn = opts.nowFn ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const refresh = async (): Promise<string> => {
    const jwt = buildAppJwt(opts.appId, opts.privateKeyPem, Math.floor(nowFn() / 1000));
    const res = await fetchFn(`${API}/app/installations/${opts.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kb-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub App installation token の取得に失敗 (HTTP ${res.status})`);
    }
    const j = (await res.json()) as { token?: string; expires_at?: string };
    const expiresAtMs = j.expires_at ? Date.parse(j.expires_at) : Number.NaN;
    if (!j.token || Number.isNaN(expiresAtMs)) {
      throw new Error("GitHub App installation token の応答形式が不正です");
    }
    cached = { token: j.token, expiresAtMs };
    return j.token;
  };

  return async () => {
    if (cached && nowFn() < cached.expiresAtMs - REFRESH_MARGIN_MS) return cached.token;
    // 取得中の Promise を共有（並行呼び出しで POST を二重に飛ばさない）。失敗時は解放して次回再試行。
    inFlight ??= refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

/**
 * 環境変数から TokenSource を組み立てる入口（process.env を読むのはここだけ）。
 * 優先順位: App の 3 変数が揃っていれば App ＞ GITHUB_TOKEN（PAT）＞ 無認証（undefined）。
 * PEM は env 直書きだと改行の扱いで壊れやすいため、ファイルパス方式を正とする。
 */
export function loadGitHubTokenSource(): TokenSource | undefined {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const set = [appId, installationId, keyPath].filter(Boolean).length;
  if (set === 3) {
    let privateKeyPem: string;
    try {
      privateKeyPem = readFileSync(keyPath!, "utf8");
    } catch (e) {
      // App 認証は明示オプトインなので設定不備は fail-fast（無言で無認証へ落とすと private リポの
      // 404 が「リポが無い」に見えて原因究明が長引く）。何が読めないかだけ明確に伝える。
      throw new Error(
        `GITHUB_APP_PRIVATE_KEY_PATH の PEM を読めません: ${keyPath}（${(e as Error).message}）。` +
          "compose 利用時はマウント（compose.yaml のコメント参照）を確認してください",
      );
    }
    return createAppTokenSource({ appId: appId!, privateKeyPem, installationId: installationId! });
  }
  // 一部だけ設定された App 変数は設定ミスの可能性が高い。黙ってフォールバックせず警告する
  // （起動は止めない: PAT/無認証でも機能自体は動くため）。
  if (set > 0) {
    console.warn("⚠ GITHUB_APP_* が一部のみ設定されています（3つ揃うと App 認証が有効）。PAT/無認証で続行します");
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) return async () => token;
  return undefined;
}
