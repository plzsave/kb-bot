#!/usr/bin/env bun
// ローカルディレクトリの .md を取り込んで FTS5 インデックスを構築する（資格情報ゼロの動作確認用）。
// 本番の R2/S3 取り込み(kb:ingest)と同じ chunkMarkdown→replaceDoc を流用し、入力元だけ差し替える。
//   bun run scripts/kb-ingest-local.ts [ディレクトリ]   (既定: ./samples)
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { dbPath } from "../src/config.ts";
import { openDb, replaceDoc, countChunks } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";

const root = process.argv[2] ?? "./samples";
const db = openDb(dbPath());

async function listMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMd(p)));
    else if (e.name.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

const files = await listMd(root);
let total = 0;
for (const path of files) {
  const md = await Bun.file(path).text();
  const key = relative(root, path); // R2 のキー相当（例: github-app.md）
  const chunks = chunkMarkdown(md);
  replaceDoc(db, key, chunks);
  total += chunks.length;
  console.log(`  ✓ ${key} (${chunks.length} chunks)`);
}

console.log("\n=== ローカル取り込み完了 ===");
console.log(`成功 ${files.length} ファイル / 総チャンク ${total}`);
console.log(`インデックス総チャンク数: ${countChunks(db)} (DB: ${dbPath()})`);
