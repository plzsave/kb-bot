import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, replaceDoc, search, buildMatchQuery, countChunks, dropWeakHits, pruneDocsNotIn, queryCoverage, isSubstantiveTopHit, type SearchHit } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";
import { isStaleKey, isReservedKey } from "../src/kb/ingest.ts";

// openDb はパス指定だが ":memory:" でインメモリ DB を開ける（資格情報・ファイル不要）。
function memDb(): Database {
  return openDb(":memory:");
}

test("buildMatchQuery は内容語をフレーズ化して OR で結ぶ", () => {
  const q = buildMatchQuery("認証はどうやる？");
  expect(q).toContain('"認証"');
  expect(q).toContain(" OR ");
});

test("buildMatchQuery は内容語ゼロなら null", () => {
  expect(buildMatchQuery("の、。")).toBeNull();
});

// --- 関連性シグナル（内容語カバレッジ・純粋関数, Req 1.1/1.2/1.3/1.5） ---

function hit(text: string): SearchHit {
  return { docKey: "d.md", heading: "", ord: 0, text, score: -1 };
}

test("queryCoverage は内容語をすべて含む本文で高く、無関係本文で低い（Req 1.3）", () => {
  const q = "回答キャッシュ の 有効期限 は？";
  // 「回答」「キャッシュ」「有効」「期限」を含む本文 → 高カバレッジ。
  const full = queryCoverage(q, "回答 キャッシュ の 有効 期限 は 24 時間 です");
  expect(full).toBeGreaterThanOrEqual(0.5);
  // 1 語しか含まない無関係本文 → 低カバレッジ。
  const weak = queryCoverage(q, "課題 の 進捗 と 対応 コスト について");
  expect(weak).toBeLessThan(0.5);
});

test("queryCoverage は内容語ゼロのクエリで 0（分母0, Req 1.3）", () => {
  expect(queryCoverage("の、。", "何らかの本文")).toBe(0);
});

test("isSubstantiveTopHit は空 hits で false（従来の空振りを包含, Req 1.1）", () => {
  expect(isSubstantiveTopHit("回答 キャッシュ 有効 期限", [])).toBe(false);
});

test("isSubstantiveTopHit は関連 top hit で true・無関係 top hit で false（Req 1.1/1.2）", () => {
  const q = "回答 キャッシュ の 有効 期限";
  expect(isSubstantiveTopHit(q, [hit("回答 キャッシュ の 有効 期限 は 24 時間")])).toBe(true);
  expect(isSubstantiveTopHit(q, [hit("課題 の 進捗 と 対応 コスト")])).toBe(false);
});

test("isSubstantiveTopHit はしきい値 0.34 近傍で borderline docs を据置・真の空振りを昇格に分ける", () => {
  // 質問の内容語 5 個のうち 2 個含む本文 → cov=0.40 ≥ 0.34 → substantive（据置）。
  // 「答えは docs にあるが質問語が一部本文に無い」borderline を過剰昇格させないため。
  const q = "権限 レベル に は どんな 種類 が あります か"; // 内容語: 権限/レベル/どんな/種類/あります 等
  const partial = hit("権限 レベル は 閲覧者 編集者 管理者 の 3 種類");
  expect(queryCoverage(q, partial.text)).toBeGreaterThanOrEqual(0.34);
  expect(isSubstantiveTopHit(q, [partial])).toBe(true);
  // 無関係な最上位ヒット（内容語をほぼ含まない）→ cov < 0.34 → 非 substantive（昇格）。
  const unrelated = hit("課題 の 進捗 と 対応 コスト の 話");
  expect(queryCoverage(q, unrelated.text)).toBeLessThan(0.34);
  expect(isSubstantiveTopHit(q, [unrelated])).toBe(false);
});

test("isSubstantiveTopHit は単一内容語クエリで一致時 true（従来どおり非昇格・非回帰）", () => {
  // 分母1の単一内容語は一致で 1.0＝substantive → startHard は従来どおり発火しない。
  expect(isSubstantiveTopHit("トークナイザ", [hit("全文検索 の トークナイザ は unicode61")])).toBe(true);
});

test("queryCoverage / isSubstantiveTopHit は入力を変更しない（純粋・Req 1.5）", () => {
  const hits = [hit("回答 キャッシュ 有効 期限")];
  const snap = JSON.stringify(hits);
  queryCoverage("回答 キャッシュ", hits[0]!.text);
  isSubstantiveTopHit("回答 キャッシュ", hits);
  expect(JSON.stringify(hits)).toBe(snap);
});

test("取り込み→検索で関連チャンクが最上位に来る", () => {
  const db = memDb();
  replaceDoc(db, "deploy.md", chunkMarkdown("# デプロイ\n\n本番は ECS Fargate で稼働します。"));
  replaceDoc(db, "auth.md", chunkMarkdown("# 認証\n\nログインは Google OIDC を使います。"));
  expect(countChunks(db)).toBe(2);

  const hits = search(db, "デプロイ先はどこ？", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.docKey).toBe("deploy.md");
});

test("dropWeakHits は最上位を残し、極端に弱い末尾を落とす", () => {
  const mk = (score: number) => ({ docKey: "d", heading: "", ord: 0, text: "", score });
  // 最上位 -6、-3 は残す、-0.1（絶対値が10%未満）は落とす
  const out = dropWeakHits([mk(-6), mk(-3), mk(-0.1)]);
  expect(out.map((h) => h.score)).toEqual([-6, -3]);
});

test("dropWeakHits は1件以下ならそのまま", () => {
  const mk = (score: number) => ({ docKey: "d", heading: "", ord: 0, text: "", score });
  expect(dropWeakHits([mk(-0.0001)]).length).toBe(1);
});

test("replaceDoc は同一 docKey を入れ替える（重複しない）", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n初版"));
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n改訂版"));
  expect(countChunks(db)).toBe(1);
});

test("pruneDocsNotIn は keep 外の doc を消し、件数を返す", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n認証の手順"));
  replaceDoc(db, "b.md", chunkMarkdown("# B\n\nデプロイの設定"));
  replaceDoc(db, "c.md", chunkMarkdown("# C\n\n課金の仕組み"));
  const removed = pruneDocsNotIn(db, ["a.md", "c.md"]);
  expect(removed).toBe(1); // b.md が消える
  expect(countChunks(db)).toBe(2);
  expect(search(db, "デプロイ", 5).length).toBe(0);
  expect(search(db, "認証", 5).length).toBeGreaterThan(0);
});

test("pruneDocsNotIn は keep 空なら全削除", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n認証の手順"));
  expect(pruneDocsNotIn(db, [])).toBe(1);
  expect(countChunks(db)).toBe(0);
});

test("isStaleKey は _stale 配下を判定", () => {
  expect(isStaleKey("knowledge/_stale/github-issues/x-y/1.md")).toBe(true);
  expect(isStaleKey("_stale/1.md")).toBe(true);
  expect(isStaleKey("knowledge/github-issues/x-y/1.md")).toBe(false);
});

test("isReservedKey は _config 配下を判定（追加プロンプト等を索引から外す）", () => {
  expect(isReservedKey("_config/system-prompt.md")).toBe(true);
  expect(isReservedKey("knowledge/_config/system-prompt.md")).toBe(true);
  expect(isReservedKey("knowledge/system-prompt.md")).toBe(false);
});
