#!/usr/bin/env bun
// 取り込んだインデックスに対し BM25 検索を試す（再帰率の目視確認用）。
//   bun run kb:search "知りたいこと" [件数]
import { dbPath } from "../src/config.ts";
import { openDb, search, buildMatchQuery, countChunks } from "../src/kb/db.ts";

const query = process.argv[2];
const limit = Number(process.argv[3] ?? 5);
if (!query) {
  console.error('使い方: bun run kb:search "知りたいこと" [件数]');
  process.exit(1);
}

const db = openDb(dbPath());
console.log(`索引チャンク数: ${countChunks(db)}`);
console.log(`FTS式: ${buildMatchQuery(query)}\n`);

const hits = search(db, query, limit);
if (hits.length === 0) {
  console.log("ヒットなし");
} else {
  hits.forEach((h, i) => {
    const preview = h.text.replace(/\s+/g, " ").slice(0, 160);
    console.log(`#${i + 1} score=${h.score.toFixed(3)}  [${h.docKey}]  ${h.heading || "(no heading)"}`);
    console.log(`    ${preview}${h.text.length > 160 ? "…" : ""}\n`);
  });
}
