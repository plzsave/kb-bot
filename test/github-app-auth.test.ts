import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppJwt, createAppTokenSource, loadGitHubTokenSource } from "../src/github-app-auth.ts";

// テスト用 RSA 鍵（2048bit・使い捨て）。署名の妥当性ではなく JWT の形式と claim を検証する。
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

test("buildAppJwt: RS256 の 3 セグメント JWT で claim が仕様どおり", () => {
  const nowSec = 1_700_000_000;
  const jwt = buildAppJwt("12345", privateKeyPem, nowSec);
  const parts = jwt.split(".");
  expect(parts.length).toBe(3);
  expect(decodeSegment(parts[0]!)).toEqual({ alg: "RS256", typ: "JWT" });
  const payload = decodeSegment(parts[1]!);
  expect(payload.iss).toBe("12345");
  expect(payload.iat).toBe(nowSec - 60); // 時計ずれ対策で 60 秒過去
  expect(payload.exp).toBe(nowSec + 540); // 上限 10 分に対し余裕を見て 9 分
  expect(parts[2]!.length).toBeGreaterThan(0);
  // base64url であること（+ / = を含まない）
  for (const p of parts) expect(p).not.toMatch(/[+/=]/);
});

// installation token API のフェイク。呼び出し回数を数え、固定の token/expires_at を返す。
function fakeTokenApi(expiresAtMs: number) {
  const state = { calls: 0 };
  const fetchFn = (async (_url: unknown, _init?: unknown) => {
    state.calls++;
    return new Response(
      JSON.stringify({ token: `tok-${state.calls}`, expires_at: new Date(expiresAtMs).toISOString() }),
      {
        status: 201,
      },
    );
  }) as typeof fetch;
  return { state, fetchFn };
}

const T0 = Date.parse("2026-01-01T00:00:00Z");
const HOUR = 60 * 60 * 1000;

test("createAppTokenSource: 初回は POST 1回でトークンを得る", async () => {
  const { state, fetchFn } = fakeTokenApi(T0 + HOUR);
  const source = createAppTokenSource({ appId: "1", privateKeyPem, installationId: "99", fetchFn, nowFn: () => T0 });
  expect(await source()).toBe("tok-1");
  expect(state.calls).toBe(1);
});

test("createAppTokenSource: 期限内の再呼び出しはキャッシュを返し fetch は増えない", async () => {
  const { state, fetchFn } = fakeTokenApi(T0 + HOUR);
  let now = T0;
  const source = createAppTokenSource({ appId: "1", privateKeyPem, installationId: "99", fetchFn, nowFn: () => now });
  await source();
  now = T0 + 30 * 60 * 1000; // 30 分後（期限 5 分前より手前）
  expect(await source()).toBe("tok-1");
  expect(state.calls).toBe(1);
});

test("createAppTokenSource: 期限 5 分前を切ると再取得する", async () => {
  const { state, fetchFn } = fakeTokenApi(T0 + HOUR);
  let now = T0;
  const source = createAppTokenSource({ appId: "1", privateKeyPem, installationId: "99", fetchFn, nowFn: () => now });
  await source();
  now = T0 + HOUR - 4 * 60 * 1000; // 期限 4 分前＝マージン内
  expect(await source()).toBe("tok-2");
  expect(state.calls).toBe(2);
});

test("createAppTokenSource: 並行呼び出しでも取得は 1 回（in-flight 共有）", async () => {
  const { state, fetchFn } = fakeTokenApi(T0 + HOUR);
  const source = createAppTokenSource({ appId: "1", privateKeyPem, installationId: "99", fetchFn, nowFn: () => T0 });
  const [a, b] = await Promise.all([source(), source()]);
  expect(a).toBe("tok-1");
  expect(b).toBe("tok-1");
  expect(state.calls).toBe(1);
});

test("createAppTokenSource: HTTP 失敗は例外（メッセージにトークン/PEM を含まない）", async () => {
  const fetchFn = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  const source = createAppTokenSource({ appId: "1", privateKeyPem, installationId: "99", fetchFn, nowFn: () => T0 });
  try {
    await source();
    expect.unreachable("例外になるはず");
  } catch (e) {
    const msg = (e as Error).message;
    expect(msg).toContain("401");
    expect(msg).not.toContain("PRIVATE KEY");
  }
});

// --- loadGitHubTokenSource: env の分岐 ---
// process.env を書き換えるため、各テストで退避・復元する。
const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_TOKEN",
] as const;

function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("loadGitHubTokenSource: App の 3 変数が揃えば App 方式を返す", () => {
  const pemPath = join(mkdtempSync(join(tmpdir(), "kb-bot-app-")), "app.pem");
  writeFileSync(pemPath, privateKeyPem);
  withEnv({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "99", GITHUB_APP_PRIVATE_KEY_PATH: pemPath }, () => {
    expect(loadGitHubTokenSource()).toBeDefined();
  });
});

test("loadGitHubTokenSource: App と PAT 両方あれば App が優先される", () => {
  // 実在しない PEM パス → App 分岐なら readFileSync で即例外になる。
  // PAT へフォールバックせず例外になること＝App 側が選ばれた証明（ネットワーク不要で分岐を確定できる）。
  withEnv(
    {
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "99",
      GITHUB_APP_PRIVATE_KEY_PATH: "/nonexistent/app.pem",
      GITHUB_TOKEN: "pat",
    },
    () => {
      expect(() => loadGitHubTokenSource()).toThrow();
    },
  );
});

test("loadGitHubTokenSource: PAT のみなら静的トークンを返す", async () => {
  let source: ReturnType<typeof loadGitHubTokenSource>;
  withEnv({ GITHUB_TOKEN: "pat-only" }, () => {
    source = loadGitHubTokenSource();
  });
  expect(await source!()).toBe("pat-only");
});

test("loadGitHubTokenSource: どちらも無ければ undefined（無認証）", () => {
  withEnv({}, () => {
    expect(loadGitHubTokenSource()).toBeUndefined();
  });
});
