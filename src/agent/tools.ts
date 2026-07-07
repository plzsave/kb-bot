import type { Database } from "bun:sqlite";
import { search } from "../kb/db.ts";
import { logUsage } from "../usage.ts";
import type { AgentTool } from "./agent.ts";

// ナレッジ検索ツール。FTS5/BM25 でチャンクを引き、出典付きで返す。
// 初回プロンプトに上位を前置きしておき（agent 呼び出し側）、足りない時にこのツールで深掘りさせる。

export function searchKnowledgeTool(db: Database): AgentTool {
  return {
    def: {
      name: "search_knowledge",
      description:
        "R2/S3 に蓄積された Markdown ナレッジを全文検索する。" +
        "ユーザーの質問に答えるための事実・手順・用語が初期コンテキストに無い、" +
        "または不足している時に呼ぶ。日本語の質問はそのまま渡してよい。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索したい語句や言い換え" },
          limit: { type: "integer", description: "取得件数（既定5）" },
        },
        required: ["query"],
      },
    },
    async run(input) {
      const { query, limit } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return "（検索語が空でした）";
      const hits = search(db, query, Math.min(limit ?? 5, 10));
      logUsage(
        db,
        hits.map((h) => h.docKey),
      ); // 検索ヒットを retrieved として記録（kb-prune 用）
      return formatHits(hits);
    },
  };
}

/** 検索結果を LLM に渡す/前置きする共通フォーマット。 */
export function formatHits(hits: ReturnType<typeof search>): string {
  if (hits.length === 0) return "（該当するナレッジは見つかりませんでした）";
  return hits
    .map((h, i) => `[${i + 1}] 出典: ${h.docKey}${h.heading ? ` / ${h.heading}` : ""}\n${h.text}`)
    .join("\n\n---\n\n");
}
