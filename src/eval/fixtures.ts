// フィクスチャ Markdown 群から隔離 FTS 索引を組み立てる（eval 専用・本番 KB 非依存）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { chunkMarkdown } from "../kb/chunk.ts";
import { openDb, replaceDoc } from "../kb/db.ts";

/**
 * フィクスチャ Markdown 群を本番 KB と分離した in-memory FTS 索引に組み立てて返す（Req 2.1/2.2/2.4）。
 * - `openDb(":memory:")` で空の隔離索引を作る。本番 `dbPath()`/`./kb.sqlite` は一切開かず・変更しない（2.2）。
 * - 各 `fixturePath` は `join(baseDir, fixturePath)` で解決する。基準は呼び出し側が渡す `baseDir`（＝ケース
 *   定義ファイルのディレクトリ）に固定し、実行時の `process.cwd()` に依存しない（設計レビュー Issue 2）。
 * - 解決先が存在しなければ原因パスを添えて即エラー（fail-fast, Error Handling）。
 * - 索引は既存部品（`chunkMarkdown` → `replaceDoc`）を再利用。`docKey` はフィクスチャの相対パス。
 * - 返す db は呼び出し側が `close()` する（ここでは閉じない）。副作用は baseDir 配下の読み取りと in-memory 構築のみ。
 */
export function buildFixtureDb(fixturePaths: string[], baseDir: string): Database {
  const db = openDb(":memory:");
  for (const fixturePath of fixturePaths) {
    const resolved = join(baseDir, fixturePath);
    if (!existsSync(resolved)) {
      db.close();
      throw new Error(`フィクスチャが見つかりません: ${resolved}`);
    }
    const md = readFileSync(resolved, "utf8");
    replaceDoc(db, fixturePath, chunkMarkdown(md));
  }
  return db;
}
