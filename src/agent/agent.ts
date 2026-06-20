import Anthropic from "@anthropic-ai/sdk";

// ネイティブ tool use のループ（mdcollab の reviewAgent と同じ思想：ループ論理は
// プロバイダ詳細から独立、ツール実体は注入）。ストリーミングで逐次 onDelta を呼ぶ。
// system はキャッシュ前提で安定させ、cache_control: ephemeral を付ける。

export interface AgentTool {
  def: Anthropic.Tool;
  /** never throw 推奨。失敗はメモ文字列で返してモデルに再試行させる。 */
  run(input: unknown): Promise<string>;
}

export interface AgentUsage {
  input: number; // キャッシュ未ヒットの新規入力
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface RunAgentOpts {
  client: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
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
  const messages: Anthropic.MessageParam[] = [...opts.messages];
  const usage = emptyUsage();
  const toolsUsed: string[] = [];
  let full = "";
  let completed = false;

  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  // system はブロック配列にして末尾に cache_control を置く＝tools+system がキャッシュ対象。
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = opts.client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      tools: opts.tools.map((t) => t.def),
      messages,
    });

    stream.on("text", (delta) => {
      full += delta;
      opts.onDelta?.(delta);
    });

    const msg = await stream.finalMessage();
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreation += msg.usage.cache_creation_input_tokens ?? 0;

    if (msg.stop_reason !== "tool_use") {
      completed = true;
      break;
    }

    // tool_use を含む assistant 生ブロックをそのまま積む（tool_use_id 対応の正しさの鍵）。
    messages.push({ role: "assistant", content: msg.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const impl = registry.get(block.name);
      const out = impl ? await impl.run(block.input) : `unknown tool: ${block.name}`;
      toolsUsed.push(block.name);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  return { text: full, toolsUsed, truncated: !completed, usage };
}
