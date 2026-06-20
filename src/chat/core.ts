import type { Database } from "bun:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { search } from "../kb/db.ts";
import { getCachedAnswer, putCachedAnswer } from "../cache.ts";
import { runAgent, type AgentTool } from "../agent/agent.ts";
import { searchKnowledgeTool, formatHits } from "../agent/tools.ts";
import { githubTools } from "../agent/githubTools.ts";
import type { GitHub } from "../github.ts";

// プラットフォーム非依存の回答コア。
// Slack/Discord などの差は ChatReply（送信と逐次更新）に閉じ込め、ここは入出力の語彙を持たない。
// 回答キャッシュ照会 → FTS5 前置き → エージェント実行（逐次更新）→ キャッシュ保存、の一連を担う。

const TOP_K = 5; // 初期プロンプトに前置きするチャンク数
const STREAM_THROTTLE_MS = 900; // 逐次更新の最小間隔（各プラットフォームの編集レート配慮）

// system はモデルが GitHub を持つかで変わる。コードを真実とみなす指示を GitHub 有効時に足す。
function buildSystem(gh?: GitHub): string {
  const base = `あなたは社内向けのナレッジ Bot です。
- R2/S3 の Markdown ナレッジと、管理アプリの使い方・仕様について、簡潔・正確に日本語で答えます。
- まず与えられた「初期コンテキスト」を読み、足りなければ search_knowledge ツールで追加検索します。
- 【参照先の振り分け】「手順・運用・決まり事・用語の定義」は R2/S3 ドキュメント（search_knowledge）、
  「実装・挙動・仕様の詳細・なぜそう動くか」は GitHub の実コードを優先します。判断に迷えば両方参照します。
- 事実が見つからない時は推測せず「ナレッジに見つかりませんでした」と述べます。
- 【出力スタイル】検索や読み込みの途中経過・実況（「〜を確認します」「見つかりませんでした、次は…」等）は
  書かないでください。最終的な答えだけを、結論から簡潔に提示します。
- 【読み手への配慮】読み手は非エンジニアの可能性があります。次の二層構成で書いてください:
  1) まず「やさしい説明」: 何ができる/どう使う/どう動くのかを、専門用語を避けた平易な日本語で 1〜3 文。
     やむを得ず専門用語を使う時は一言で補足する。
  2) 次に「根拠」: 出典（ファイル名/見出し、コードならパスと行番号）を簡潔に列挙。詳しく知りたい人向け。
  コードの行を細かく逐条解説するより、まず要点を言葉で伝えることを優先します。`;
  if (!gh) return base;
  return (
    base +
    `\n\n【重要】アプリの仕様・挙動・使い方に関する質問では、ドキュメントは陳腐化している可能性があるため
**実コードを真実（source of truth）とみなして**ください。参照可能なリポジトリ: ${gh.repos.join(", ")}。
list_repo_tree で構成を把握し、search_repo_code で該当箇所を探し、read_repo_file で実コードを読み、
ファイルパスと行番号を根拠として引用して説明します。ドキュメントとコードが食い違う場合はコードを優先します。`
  );
}

// 後方互換のための既定 system（GitHub 無効時）。
export const SYSTEM = buildSystem();

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

/** スレッド/DM の過去発言（会話メモリ）。プラットフォーム側が取得して渡す。 */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AnswerDeps {
  db: Database;
  anthropic: Anthropic;
  model: string;
  /** 設定されていれば GitHub コード参照ツールを有効化する（実コードで仕様を語る）。 */
  github?: GitHub;
}

// Anthropic は user/assistant の交互かつ user 始まりを要求するため、履歴を正規化する。
// 連続する同一ロールは結合し、先頭の assistant は落とす。
export function normalizeHistory(history: HistoryTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    if (!turn.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${turn.text}`;
    } else {
      out.push({ role: turn.role, content: turn.text });
    }
  }
  while (out.length && out[0]!.role === "assistant") out.shift();
  return out;
}

/** 質問テキストを受け、reply 経由で回答する（プラットフォーム非依存）。history はスレッド文脈（任意）。 */
export async function answer(
  question: string,
  reply: ChatReply,
  deps: AnswerDeps,
  history: HistoryTurn[] = [],
): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const { db, anthropic, model, github } = deps;
  const hasContext = history.length > 0;

  // ① 回答キャッシュ（完全一致）→ ヒットなら LLM を呼ばない＝最大の節約。
  //    ただし会話の続き（文脈あり）は同じ問い文でも答えが変わるためキャッシュしない。
  if (!hasContext) {
    const cached = getCachedAnswer(db, q);
    if (cached) {
      await reply.send(`${cached}\n\n_（キャッシュ応答）_`);
      return;
    }
  }

  // プレースホルダを起票し、以降この handle を書き換えていく
  // 絵文字は Slack/Discord 双方で表示できる Unicode を使う（:shortcode: は Slack 専用）。
  const handle = await reply.send("考え中… ⏳");

  // ② FTS5/BM25 で関連チャンクを取得し初期コンテキストに前置き（埋め込み課金ゼロ）
  const hits = search(db, q, TOP_K);
  const initialPrompt = `# 初期コンテキスト（FTS検索の上位${hits.length}件）\n\n${formatHits(hits)}\n\n# 質問\n${q}`;

  // ③ エージェント実行（既定 Haiku・プロンプトキャッシュ・tool use）。逐次更新。
  // GitHub が有効ならコード参照ツールを足す（実コードで仕様を語る）。
  const tools: AgentTool[] = [searchKnowledgeTool(db), ...(github ? githubTools(github) : [])];

  let lastEdit = 0;
  let pending = "";
  const flush = async (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastEdit < STREAM_THROTTLE_MS) return;
    lastEdit = now;
    if (pending.trim()) await handle.update(pending);
  };

  // スレッド/DM の過去発言を会話履歴として前置きし、今回の質問を最後に積む。
  const messages: Anthropic.MessageParam[] = [
    ...normalizeHistory(history),
    { role: "user", content: initialPrompt },
  ];

  const result = await runAgent({
    client: anthropic,
    model,
    system: buildSystem(github),
    messages,
    tools,
    // コード探索は tree→search→read と手数が要るので GitHub 有効時はターン上限を緩める。
    maxTurns: github ? 8 : undefined,
    onDelta: (t) => {
      pending += t;
      void flush(false);
    },
  });

  const finalText = result.text.trim() || "（回答を生成できませんでした）";
  await handle.update(finalText);

  // ④ キャッシュ保存＋使用量ログ（truncated は不完全・文脈ありは再利用不可なのでキャッシュしない）
  if (!hasContext && !result.truncated && result.text.trim()) putCachedAnswer(db, q, finalText);
  const u = result.usage;
  console.log(
    `[usage] model=${model} tools=${result.toolsUsed.join(",") || "-"} ` +
      `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheCreate=${u.cacheCreation} truncated=${result.truncated}`,
  );
}
