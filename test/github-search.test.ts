import { expect, test } from "bun:test";
import { isTextPath, searchTerms, selectSearchCandidates, grepFiles } from "../src/github.ts";

// searchCode（tree+grep）の中核ロジックの決定的ゲート。
// レガシー /search/code は fine-grained PAT で常に 0 件（実測確定）だったため、コード検索を
// tree→blob 取得→ローカル grep に置き換えた。ネットワーク I/O は searchCode 側に閉じ、
// 語分割・候補選定・grep/フォールバックは純関数として切り出してここで固定する（層1哲学）。

test("searchTerms は空白区切りで小文字化・重複除去し、識別子は割らない", () => {
  expect(searchTerms("Cache TTL")).toEqual(["cache", "ttl"]);
  expect(searchTerms("  TTL_MS   TTL_MS ")).toEqual(["ttl_ms"]); // 識別子は分割しない・重複除去
  expect(searchTerms("   ")).toEqual([]);
});

test("isTextPath はテキスト系のみ true・lock/min/バイナリは false", () => {
  expect(isTextPath("src/cache.ts")).toBe(true);
  expect(isTextPath("README.md")).toBe(true);
  expect(isTextPath("bun.lock")).toBe(false);
  expect(isTextPath("package-lock.json")).toBe(false);
  expect(isTextPath("dist/app.min.js")).toBe(false);
  expect(isTextPath("assets/logo.png")).toBe(false);
});

test("selectSearchCandidates はパス名一致を優先しつつ非一致も残す（安定順）", () => {
  const paths = ["src/agent/agent.ts", "src/cache.ts", "src/index.ts", "docs/cache-guide.md", "logo.png"];
  const out = selectSearchCandidates(paths, ["cache"], 10);
  // パス名に "cache" を含む 2 件が先頭（元順を保つ）、残りが後続。png は除外。
  expect(out.slice(0, 2)).toEqual(["src/cache.ts", "docs/cache-guide.md"]);
  expect(out).not.toContain("logo.png");
  expect(out).toContain("src/index.ts");
});

test("selectSearchCandidates は cap で切り詰める", () => {
  const paths = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
  expect(selectSearchCandidates(paths, ["x"], 30).length).toBe(30);
});

test("selectSearchCandidates は語ゼロならテキスト系をそのまま（cap まで）", () => {
  expect(selectSearchCandidates(["a.ts", "b.png", "c.md"], [], 10)).toEqual(["a.ts", "c.md"]);
});

const FILES = [
  { path: "src/cache.ts", content: "// 回答キャッシュ\nconst TTL_MS = 24 * 3_600_000;\nexport function get() {}" },
  { path: "src/index.ts", content: "import { get } from './cache.ts'\nconsole.log('start')" },
];

test("grepFiles は全語 AND の同一行一致を path:line で返す（厳密）", () => {
  const { matches, broadened } = grepFiles(FILES, ["ttl_ms"], {});
  expect(broadened).toBe(false);
  expect(matches).toEqual([{ path: "src/cache.ts", line: 2, text: "const TTL_MS = 24 * 3_600_000;" }]);
});

test("grepFiles は AND で 0 件なら OR に緩めて broadened=true で返す", () => {
  // "ttl_ms" と "start" は同一行に共存しない → AND 0 件 → OR で両方拾う
  const { matches, broadened } = grepFiles(FILES, ["ttl_ms", "start"], {});
  expect(broadened).toBe(true);
  expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/cache.ts:2", "src/index.ts:2"]);
});

test("grepFiles は候補順を保ち、各ファイル内は行番号順", () => {
  const files = [
    { path: "b.ts", content: "x\nfoo\nfoo" },
    { path: "a.ts", content: "foo" },
  ];
  const { matches } = grepFiles(files, ["foo"], {});
  // 入力順（b→a）を保つ。b 内は行番号順。
  expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["b.ts:2", "b.ts:3", "a.ts:1"]);
});

test("grepFiles は maxPerFile でファイル横断に散らす", () => {
  const files = [{ path: "a.ts", content: "foo\nfoo\nfoo\nfoo" }];
  const { matches } = grepFiles(files, ["foo"], { maxPerFile: 2 });
  expect(matches.length).toBe(2);
});

test("grepFiles は maxTotal で全体を打ち切る", () => {
  const files = [
    { path: "a.ts", content: "foo\nfoo" },
    { path: "b.ts", content: "foo\nfoo" },
  ];
  const { matches } = grepFiles(files, ["foo"], { maxTotal: 3, maxPerFile: 10 });
  expect(matches.length).toBe(3);
});

test("grepFiles は語ゼロなら空", () => {
  expect(grepFiles(FILES, [], {}).matches).toEqual([]);
});

// ---- blob キャッシュ（sha 内容アドレス・LRU）とレート制限判定 ----
import { Database } from "bun:sqlite";
import { ensureBlobCache, cacheGetBlobs, cachePutBlob, pruneBlobCache, isRateLimitResponse } from "../src/github.ts";

function memDb(): Database {
  const db = new Database(":memory:");
  ensureBlobCache(db);
  return db;
}

test("blobCache: put → get で内容が返り、未登録 sha は返らない", () => {
  const db = memDb();
  cachePutBlob(db, "sha1", "const a = 1;");
  const got = cacheGetBlobs(db, ["sha1", "sha-missing"]);
  expect(got.get("sha1")).toBe("const a = 1;");
  expect(got.has("sha-missing")).toBe(false);
});

test("blobCache: 同一 sha の put は上書き（内容アドレスなので実際は同内容）", () => {
  const db = memDb();
  cachePutBlob(db, "sha1", "v1");
  cachePutBlob(db, "sha1", "v1");
  expect(cacheGetBlobs(db, ["sha1"]).get("sha1")).toBe("v1");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM gh_blob_cache").get() as { n: number }).n;
  expect(n).toBe(1);
});

test("blobCache: prune は last_used が古い順に削除し、ヒットで last_used が更新される（LRU）", () => {
  const db = memDb();
  cachePutBlob(db, "old", "x".repeat(100), 1000);
  cachePutBlob(db, "mid", "y".repeat(100), 2000);
  cachePutBlob(db, "new", "z".repeat(100), 3000);
  // old をヒットさせて最新化 → 最古は mid になる
  cacheGetBlobs(db, ["old"], 4000);
  // 合計 300 バイト → 上限 250 に縮める＝最古 1 件（mid）だけ落ちる
  expect(pruneBlobCache(db, 250)).toBe(1);
  const rest = cacheGetBlobs(db, ["old", "mid", "new"], 5000);
  expect(rest.has("old")).toBe(true);
  expect(rest.has("mid")).toBe(false);
  expect(rest.has("new")).toBe(true);
});

test("blobCache: 上限内なら prune は何も消さない", () => {
  const db = memDb();
  cachePutBlob(db, "a", "hello");
  expect(pruneBlobCache(db, 1024)).toBe(0);
});

test("isRateLimitResponse: 403+remaining=0 / 429+retry-after は true、通常 403/404 は false", () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
  expect(isRateLimitResponse(403, h({ "x-ratelimit-remaining": "0" }))).toBe(true);
  expect(isRateLimitResponse(429, h({ "retry-after": "60" }))).toBe(true);
  expect(isRateLimitResponse(403, h({ "x-ratelimit-remaining": "4999" }))).toBe(false); // 権限系 403
  expect(isRateLimitResponse(404, h({ "x-ratelimit-remaining": "0" }))).toBe(false);
});
