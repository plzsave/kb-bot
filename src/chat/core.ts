import type { Database } from "bun:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { search } from "../kb/db.ts";
import { getCachedAnswer, putCachedAnswer } from "../cache.ts";
import { runAgent } from "../agent/agent.ts";
import { searchKnowledgeTool, formatHits } from "../agent/tools.ts";

// プラットフォーム非依存の回答コア。
// Slack/Discord などの差は ChatReply（送信と逐次更新）に閉じ込め、ここは入出力の語彙を持たない。
// 回答キャッシュ照会 → FTS5 前置き → エージェント実行（逐次更新）→ キャッシュ保存、の一連を担う。

const TOP_K = 5; // 初期プロンプトに前置きするチャンク数
const STREAM_THROTTLE_MS = 900; // 逐次更新の最小間隔（各プラットフォームの編集レート配慮）

export const SYSTEM = `あなたは社内向けのナレッジ Bot です。
- R2/S3 の Markdown ナレッジと GitHub 管理アプリの使い方について、簡潔・正確に日本語で答えます。
- まず与えられた「初期コンテキスト」を読み、それで足りなければ search_knowledge ツールで追加検索します。
- 事実が見つからない時は推測せず「ナレッジに見つかりませんでした」と述べます。
- 回答末尾に参照した出典（ファイル名/見出し）を簡潔に挙げます。`;

/** 1 回の発言（メッセージ）に対する返信ハンドル。send で起票し、返る handle を update で書き換える。 */
export interface ReplyHandle {
  /** 逐次更新（ストリーミング表示）。プラットフォーム側で必要ならレート調整・分割を行う。 */
  update(text: string): Promise<void>;
}

/** プラットフォームごとに実装する送信口。1 質問につき send が 1 回呼ばれる。 */
export interface ChatReply {
  /** 最初のメッセージを投稿し、以降それを書き換えるための handle を返す。 */
  send(text: string): Promise<ReplyHandle>;
}

export interface AnswerDeps {
  db: Database;
  anthropic: Anthropic;
  model: string;
}

/** 質問テキストを受け、reply 経由で回答する（プラットフォーム非依存）。 */
export async function answer(question: string, reply: ChatReply, deps: AnswerDeps): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const { db, anthropic, model } = deps;

  // ① 回答キャッシュ（完全一致）→ ヒットなら LLM を呼ばない＝最大の節約
  const cached = getCachedAnswer(db, q);
  if (cached) {
    await reply.send(`${cached}\n\n_（キャッシュ応答）_`);
    return;
  }

  // プレースホルダを起票し、以降この handle を書き換えていく
  // 絵文字は Slack/Discord 双方で表示できる Unicode を使う（:shortcode: は Slack 専用）。
  const handle = await reply.send("考え中… ⏳");

  // ② FTS5/BM25 で関連チャンクを取得し初期コンテキストに前置き（埋め込み課金ゼロ）
  const hits = search(db, q, TOP_K);
  const initialPrompt = `# 初期コンテキスト（FTS検索の上位${hits.length}件）\n\n${formatHits(hits)}\n\n# 質問\n${q}`;

  // ③ エージェント実行（既定 Haiku・プロンプトキャッシュ・tool use）。逐次更新。
  let lastEdit = 0;
  let pending = "";
  const flush = async (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastEdit < STREAM_THROTTLE_MS) return;
    lastEdit = now;
    if (pending.trim()) await handle.update(pending);
  };

  const result = await runAgent({
    client: anthropic,
    model,
    system: SYSTEM,
    messages: [{ role: "user", content: initialPrompt }],
    tools: [searchKnowledgeTool(db)],
    onDelta: (t) => {
      pending += t;
      void flush(false);
    },
  });

  const finalText = result.text.trim() || "（回答を生成できませんでした）";
  await handle.update(finalText);

  // ④ キャッシュ保存＋使用量ログ（truncated 時は不完全なのでキャッシュしない）
  if (!result.truncated && result.text.trim()) putCachedAnswer(db, q, finalText);
  const u = result.usage;
  console.log(
    `[usage] model=${model} tools=${result.toolsUsed.join(",") || "-"} ` +
      `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheCreate=${u.cacheCreation} truncated=${result.truncated}`,
  );
}
