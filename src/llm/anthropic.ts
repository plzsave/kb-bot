import Anthropic from "@anthropic-ai/sdk";
import type {
  CompleteParams,
  LlmAssistantBlock,
  LlmMessage,
  LlmProvider,
  LlmToolDef,
  LlmUsage,
  StreamTurnParams,
  StreamTurnResult,
} from "./provider.ts";

// Anthropic アダプタ。中立型 ⇄ @anthropic-ai/sdk の相互変換のみを担い、ループ論理は持たない。
// 既存挙動の再現が目的：cache_control: ephemeral・cache 系 usage・tool_use ループの 1 ターン分。

/** 中立メッセージ → Anthropic.MessageParam。tool_use/tool_result/text を相互変換する。 */
export function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const blocks = m.content.map((b): Anthropic.ContentBlockParam => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content };
      }
    });
    return { role: m.role, content: blocks };
  });
}

/** 中立ツール定義 → Anthropic.Tool。parameters をそのまま input_schema に渡す。 */
function toAnthropicTools(tools: LlmToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

export function createAnthropicProvider(apiKey: string, defaultModel: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  return {
    name: "anthropic",
    defaultModel,

    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      // system はブロック配列にし、cacheHint 時のみ末尾に cache_control を置く＝tools+system がキャッシュ対象。
      const system: Anthropic.TextBlockParam[] = [
        params.cacheHint
          ? { type: "text", text: params.system, cache_control: { type: "ephemeral" } }
          : { type: "text", text: params.system },
      ];

      const stream = client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens,
        system,
        tools: toAnthropicTools(params.tools),
        messages: toAnthropicMessages(params.messages),
      });

      stream.on("text", (delta) => params.onText?.(delta));
      const msg = await stream.finalMessage();

      const blocks: LlmAssistantBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        else if (block.type === "tool_use")
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }

      const usage: LlmUsage = {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
      };

      return {
        blocks,
        stopReason: msg.stop_reason === "tool_use" ? "tool_use" : "stop",
        usage,
      };
    },

    async complete(params: CompleteParams): Promise<string> {
      const msg = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        system: params.system,
        messages: [{ role: "user", content: params.prompt }],
      });
      return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  };
}
