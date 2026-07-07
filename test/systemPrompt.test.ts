import { test, expect } from "bun:test";
import { buildSystem, buildInitialPrompt } from "../src/chat/core.ts";
import { createSystemExtraResolver } from "../src/chat/systemExtra.ts";
import type { S3Client } from "../src/s3.ts";
import type { GitHub } from "../src/github.ts";

test("buildSystem: ベースは英語で自動判別を指示する", () => {
  const s = buildSystem();
  expect(s).toContain("SAME language as the user's question");
  expect(s).toContain("[Safety]");
  // 旧来の日本語固定指示は残っていない
  expect(s).not.toContain("日本語で答えます");
});

test("buildSystem: 未発見時に『次の一歩』を促す指示が入り、[Safety]/[Output style] は保持される", () => {
  const s = buildSystem();
  // 未発見時に行き止まらせず次の一歩を促す（軸 D, Req 1.1）。
  expect(s).toContain("next step");
  // 既存の推測禁止（do not guess）は維持（Req 1.2）。
  expect(s).toContain("do not guess");
  // [Safety]/[Output style] の既存キーフレーズが弱まっていないこと（Req 1.4）。
  expect(s).toContain("[Safety]");
  expect(s).toContain("REFERENCE MATERIAL");
  expect(s).toContain("[Output style]");
  expect(s).toContain("conclusion first");
});

test("buildSystem: GitHub 有効時はコード優先の追記が付く", () => {
  const gh = { repos: ["o/r1", "o/r2"] } as unknown as GitHub;
  const s = buildSystem(gh);
  expect(s).toContain("source of truth");
  expect(s).toContain("o/r1, o/r2");
});

test("buildSystem: GitHub 有効時は『見つからない前にコードを確認』を必須化する", () => {
  const gh = { repos: ["o/r1"] } as unknown as GitHub;
  const s = buildSystem(gh);
  // 未発見宣言前のコード確認を促す（Req 1.1/1.2）。
  expect(s).toContain("before giving up");
  expect(s).toContain("search_repo_code");
  expect(s).toContain("read_repo_file");
  // docs miss だけでは諦めない旨（Req 1.2）。
  expect(s).toContain("docs miss alone is not enough");
});

test("buildSystem: GitHub 無効時は『コード確認の必須化』を出さない（無効時は不適用, Req 1.4）", () => {
  const s = buildSystem(); // GitHub なし
  expect(s).not.toContain("before giving up");
  expect(s).not.toContain("search_repo_code");
});

test("buildSystem: GitHub 有効時は『docs が答えていても回答前にコードで裏取り』を必須化する（drift 主因対策）", () => {
  const gh = { repos: ["o/r1"] } as unknown as GitHub;
  const s = buildSystem(gh);
  // docs が自信満々に答えていても、挙動/仕様/設定値の質問はコード裏取りしてから答える。
  expect(s).toContain("[Verify docs against code before answering]");
  expect(s).toContain("even when they state an answer confidently");
  // docs だけで答えてよいのはコードに対応物が無い人間の手順・規則のみ。
  expect(s).toContain("no counterpart in code");
});

test("buildSystem: GitHub 無効時は『裏取り必須化』を出さない", () => {
  const s = buildSystem(); // GitHub なし
  expect(s).not.toContain("[Verify docs against code before answering]");
});

test("buildInitialPrompt: GitHub 有効時は質問の後ろに裏取りリマインダを置く（drift 主因対策の実効部）", () => {
  const p = buildInitialPrompt([], "TTL は？", true);
  expect(p).toContain("# 質問\nTTL は？");
  // 質問より後（モデルが最後に読む位置）に来ること。system 内の指示だけでは効かなかった実測に基づく。
  const qi = p.indexOf("# 質問");
  const vi = p.indexOf("# Before answering");
  expect(vi).toBeGreaterThan(qi);
  expect(p).toContain("even if they state an answer confidently");
  expect(p).toContain("search_repo_code");
});

test("buildInitialPrompt: GitHub 無効時はリマインダを出さない（コードツールが無いので指示しない）", () => {
  const p = buildInitialPrompt([], "TTL は？", false);
  expect(p).toContain("# 質問\nTTL は？");
  expect(p).not.toContain("# Before answering");
  expect(p).not.toContain("search_repo_code");
});

test("buildSystem: Slack/Discord で崩れる markdown 表を使わない指示が入る", () => {
  const s = buildSystem();
  expect(s).toContain("Markdown tables");
  expect(s).toContain("bullet");
  // 既存の [Output style] 文言は保持。
  expect(s).toContain("conclusion first");
});

test("buildSystem: コード確認追記後も [Safety]/[Output style]/#31 next-step/言語自動判別を保持する（Req 1.5）", () => {
  const gh = { repos: ["o/r1"] } as unknown as GitHub;
  const s = buildSystem(gh);
  expect(s).toContain("REFERENCE MATERIAL"); // [Safety]
  expect(s).toContain("conclusion first"); // [Output style]
  expect(s).toContain("next step"); // #31 next-step
  expect(s).toContain("SAME language as the user's question"); // 言語自動判別
});

test("buildSystem: extra はベースを保ったまま末尾に連結される", () => {
  const s = buildSystem(undefined, "  Explain things more simply.  ");
  expect(s).toContain("[Safety]"); // ベースの安全指示は維持
  expect(s).toContain("[Operator instructions]");
  expect(s).toContain("Explain things more simply."); // trim 済みで連結
  // 空/空白のみなら追記ブロックは出ない
  expect(buildSystem()).not.toContain("[Operator instructions]");
  expect(buildSystem(undefined, "   ")).not.toContain("[Operator instructions]");
});

test("resolver: インライン指定は S3 を見ず最優先", async () => {
  let calls = 0;
  const s3 = { get: async () => (calls++, "from-s3") } as unknown as S3Client;
  const r = createSystemExtraResolver({ inline: "  inline text  ", s3, key: "k" });
  expect(await r()).toBe("inline text");
  expect(calls).toBe(0);
});

test("resolver: S3 取得は TTL 内でキャッシュされる", async () => {
  let calls = 0;
  const s3 = { get: async () => (calls++, `v${calls}`) } as unknown as S3Client;
  const r = createSystemExtraResolver({ s3, key: "k", ttlMs: 10_000 });
  expect(await r()).toBe("v1");
  expect(await r()).toBe("v1"); // キャッシュヒット＝再取得しない
  expect(calls).toBe(1);
});

test("resolver: TTL=0 は毎回取得する", async () => {
  let calls = 0;
  const s3 = { get: async () => (calls++, `v${calls}`) } as unknown as S3Client;
  const r = createSystemExtraResolver({ s3, key: "k", ttlMs: 0 });
  expect(await r()).toBe("v1");
  expect(await r()).toBe("v2");
  expect(calls).toBe(2);
});

test("resolver: 404 は『追加なし』、その他失敗は前回値を維持", async () => {
  let mode: "ok" | "404" | "neterr" = "ok";
  const s3 = {
    get: async () => {
      if (mode === "404") throw new Error("S3 get failed: 404 (k)");
      if (mode === "neterr") throw new Error("network down");
      return "good";
    },
  } as unknown as S3Client;
  const r = createSystemExtraResolver({ s3, key: "k", ttlMs: 0 });
  expect(await r()).toBe("good"); // 初回成功
  mode = "neterr";
  expect(await r()).toBe("good"); // 一時失敗は前回値維持
  mode = "404";
  expect(await r()).toBe(""); // 404 は明確に「追加なし」
});

test("resolver: 取得先が無ければ常に空", async () => {
  const r = createSystemExtraResolver({ key: "k" }); // s3 なし
  expect(await r()).toBe("");
});
