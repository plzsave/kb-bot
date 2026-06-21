import type {
  LlmMessage,
  LlmProvider,
  LlmToolDef,
  LlmToolResultBlock,
  LlmUsage,
} from "../llm/provider.ts";

// ネイティブ tool use のループ。ループ論理はプロバイダ詳細から独立し（中立型 LlmProvider に依存）、
// ツール実体は注入する。ストリーミングで逐次 onDelta を呼ぶ。プロンプトキャッシュは cacheHint で
// 任意化し、対応プロバイダのみ適用される（非対応は no-op）。

export interface AgentTool {
  def: LlmToolDef;
  /** never throw 推奨。失敗はメモ文字列で返してモデルに再試行させる。 */
  run(input: unknown): Promise<string>;
}

export type AgentUsage = LlmUsage;

export interface RunAgentOpts {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  maxTurns?: number;
  maxTokens?: number;
  onDelta?: (text: string) => void;
}

export interface RunAgentResult {
  text: string;
  toolsUsed: string[];
  truncated: boolean;
  usage: AgentUsage;
}

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_MAX_TOKENS = 2048; // Slack 回答は簡潔に＝出力トークンも節約

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const registry = new Map(opts.tools.map((t) => [t.def.name, t]));
  const messages: LlmMessage[] = [...opts.messages];
  const usage = emptyUsage();
  const toolsUsed: string[] = [];
  let full = ""; // 全ターンの逐次出力（truncated 時のフォールバック・ライブ表示用）
  let answerText = ""; // 最終的に回答したターンのテキストだけ（process ログを混ぜない）
  let completed = false;

  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const tools = opts.tools.map((t) => t.def);

  for (let turn = 0; turn < maxTurns; turn++) {
    let turnText = ""; // このターンの出力（tool_use 前の「確認します」等の前置きを含む）
    const result = await opts.provider.streamTurn({
      model: opts.model,
      system: opts.system,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      cacheHint: true, // system+tools は安定＝キャッシュ対象（対応プロバイダのみ適用）
      onText: (delta) => {
        full += delta;
        turnText += delta;
        opts.onDelta?.(delta);
      },
    });

    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheCreation += result.usage.cacheCreation;

    if (result.stopReason !== "tool_use") {
      // 最終回答ターン。途中のツール実況を混ぜず、このターンのテキストだけを答えにする。
      answerText = turnText;
      completed = true;
      break;
    }

    // tool_use を含む assistant 生ブロックをそのまま積む（tool_use_id 対応の正しさの鍵）。
    messages.push({ role: "assistant", content: result.blocks });

    const results: LlmToolResultBlock[] = [];
    for (const block of result.blocks) {
      if (block.type !== "tool_use") continue;
      const impl = registry.get(block.name);
      const out = impl ? await impl.run(block.input) : `unknown tool: ${block.name}`;
      toolsUsed.push(block.name);
      results.push({ type: "tool_result", toolUseId: block.id, content: out, name: block.name });
    }
    messages.push({ role: "user", content: results });
  }

  // 完走時は最終回答ターンのみ。途中で打ち切られた時は全出力をフォールバックに使う。
  return { text: completed ? answerText : full, toolsUsed, truncated: !completed, usage };
}
