import { Database } from "bun:sqlite";
import type { Chunk } from "./chunk.ts";
import { indexTokens, queryTerms } from "./segment.ts";

// FTS5(unicode61) + 形態素分割の全文検索インデックス。
// 本文を分割して空白連結した tokens 列を索引し、原文 body は表示用に UNINDEXED で持つ。
// これで和文の 2 文字語・助詞分離に強くなり、BM25 ランキングが効く（埋め込み課金ゼロ）。
// このファイル(SQLite)は R2 の md から導出する派生物＝消えても再取り込みで再構築できる。

export interface SearchHit {
  docKey: string;
  heading: string;
  ord: number;
  text: string;
  score: number; // bm25。小さい(より負)ほど良い。
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      doc_key UNINDEXED,
      heading UNINDEXED,
      ord UNINDEXED,
      body UNINDEXED,
      tokens,
      tokenize = 'unicode61'
    )
  `);
  return db;
}

/** 1 ドキュメント分のチャンクを入れ替える（再取り込みで重複しないよう先に削除）。 */
export function replaceDoc(db: Database, docKey: string, chunks: Chunk[]): void {
  const del = db.query("DELETE FROM chunks WHERE doc_key = ?");
  const ins = db.query("INSERT INTO chunks (doc_key, heading, ord, body, tokens) VALUES (?, ?, ?, ?, ?)");
  const tx = db.transaction(() => {
    del.run(docKey);
    for (const c of chunks) ins.run(docKey, c.heading, c.ord, c.text, indexTokens(c.text));
  });
  tx();
}

export function countChunks(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
}

/**
 * keep に含まれない doc_key の索引行を削除し、消した doc 数を返す。
 * ingest は現存キーだけを upsert するため、S3 から消えた/除外されたドキュメントの
 * 古い索引が残り続ける（追加専用）。取り込みの最後にこれを呼んで「S3 の現状＝索引の現状」
 * を保つ。keep が空なら全削除（md が 1 件も無い状態＝索引も空であるべき）。
 */
export function pruneDocsNotIn(db: Database, keep: string[]): number {
  const tx = db.transaction(() => {
    db.run("CREATE TEMP TABLE IF NOT EXISTS _keep (k TEXT PRIMARY KEY)");
    db.run("DELETE FROM _keep");
    const ins = db.query("INSERT OR IGNORE INTO _keep (k) VALUES (?)");
    for (const k of keep) ins.run(k);
    const removed = (
      db.query("SELECT count(DISTINCT doc_key) AS n FROM chunks WHERE doc_key NOT IN (SELECT k FROM _keep)").get() as {
        n: number;
      }
    ).n;
    db.run("DELETE FROM chunks WHERE doc_key NOT IN (SELECT k FROM _keep)");
    db.run("DROP TABLE _keep");
    return removed;
  });
  return tx();
}

export function search(db: Database, rawQuery: string, limit = 5): SearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const rows = db
    .query(
      `SELECT doc_key AS docKey, heading, ord, body AS text, bm25(chunks) AS score
       FROM chunks WHERE chunks MATCH ? ORDER BY score ASC LIMIT ?`,
    )
    .all(match, limit) as SearchHit[];
  return dropWeakHits(rows);
}

// OR 一致は一般語（「手順」等）で無関係チャンクも拾うため、末尾の極端に弱いヒットを落とす。
// 最上位は必ず残し、bm25 スコアの絶対値が最上位の RATIO 未満のものだけ除外する（安全側・コーパス非依存）。
const WEAK_RATIO = 0.1;
export function dropWeakHits(hits: SearchHit[], ratio = WEAK_RATIO): SearchHit[] {
  if (hits.length <= 1) return hits;
  const best = Math.abs(hits[0]!.score); // bm25 は負・絶対値が大きいほど良い
  if (best === 0) return hits;
  const cutoff = best * ratio;
  return hits.filter((h, i) => i === 0 || Math.abs(h.score) >= cutoff);
}

// 問い合わせ文を FTS5 クエリ式へ。内容語をフレーズ化して OR で結ぶ（再帰率重視・BM25 で順位付け）。
export function buildMatchQuery(raw: string): string | null {
  const terms = queryTerms(raw);
  if (terms.length === 0) return null;
  const uniq = [...new Set(terms)];
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// 「実質空振り」判定のしきい値。FTS の OR 一致は最低 1 語一致を保証するため「1 語以上」では無意味。
// クエリ内容語の半数以上を最上位ヒットが含めば実質関連とみなす（コーパス非依存＝生 bm25 に非依存）。
export const REL_MIN_COVERAGE = 0.5;

/**
 * クエリ内容語カバレッジ（0..1）。query の distinct 内容語（queryTerms）のうち、
 * text の索引用トークン列（indexTokens）に語として含まれる割合を返す。分母 0 は 0。
 * 生 bm25 の絶対値には依存しない（コーパス非依存）。副作用なし・入力不変。
 */
export function queryCoverage(query: string, text: string): number {
  const terms = [...new Set(queryTerms(query))];
  if (terms.length === 0) return 0;
  const hay = ` ${indexTokens(text)} `; // 前後空白で語境界を作り、部分語誤一致を避ける
  const matched = terms.filter((t) => hay.includes(` ${t} `)).length;
  return matched / terms.length;
}

/**
 * 最上位ヒットが質問に「実質関連」かを判定する純粋関数。hits が空なら false
 * （＝従来の hits.length===0 空振りを包含）。そうでなければ最上位ヒットのカバレッジが
 * しきい値以上かを返す。事前昇格（startHard）の判定にのみ用い、検索の提示・枝刈りは変えない。
 */
export function isSubstantiveTopHit(
  query: string,
  hits: SearchHit[],
  minCoverage = REL_MIN_COVERAGE,
): boolean {
  const top = hits[0];
  if (!top) return false;
  return queryCoverage(query, top.text) >= minCoverage;
}
