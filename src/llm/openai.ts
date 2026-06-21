import OpenAI from "openai";
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

// OpenAI アダプタ（Responses API）。中立型 ⇄ openai SDK の相互変換のみを担う。
//
// なぜ Chat Completions ではなく Responses API か：
//   OpenAI は安価帯を推論モデル（gpt-5.x nano 等）に集約し、「推論モデル × function tools」を
//   Chat Completions では拒否して /v1/responses に誘導する。本ボットはツール往復が必須なので
//   Responses API を採用する（OpenAI の go-forward API）。
//
// 形式の差分（他社アダプタとの対比）：
// - 履歴は input アイテムの配列。tool_use → function_call、tool_result → function_call_output。
//   いずれも独立アイテムで、call_id で対応づける（中立 tool_use の id を call_id にそのまま使う）。
// - system は instructions に渡す。tool は { type:"function", name, parameters, strict:false }。
// - プロンプトキャッシュは自動なので cacheHint は no-op。usage は input_tokens_details.cached_tokens
//   を cacheRead に正規化する。
// - reasoning は "none"（推論オフ）。簡潔・低コスト・空回答回避が目的（Gemini の thinking と同じ判断）。

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponsesTool = OpenAI.Responses.Tool;

const REASONING_EFFORT = "none" as const;

/** 中立ツール定義 → Responses function tool。parameters をそのまま渡す。 */
function toResponsesTools(tools: LlmToolDef[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false, // 任意プロパティを許すため strict は無効（厳格スキーマ要件を回避）
  }));
}

function parseArgs(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** 中立メッセージ → Responses input。function_call / function_call_output へ展開する。 */
export function toResponsesInput(messages: LlmMessage[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const calls: ResponseInputItem[] = [];
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use")
          calls.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
      }
      if (text) out.push({ role: "assistant", content: text });
      out.push(...calls);
    } else {
      // user 側の tool_result は function_call_output として、call_id で対応づける。
      for (const b of m.content) {
        if (b.type === "tool_result")
          out.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

function mapUsage(u: OpenAI.Responses.ResponseUsage | undefined): LlmUsage {
  const input = u?.input_tokens ?? 0;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, input - cached), // input_tokens はキャッシュ分を含むので差し引く
    output: u?.output_tokens ?? 0, // reasoning_tokens は output_tokens に含まれる
    cacheRead: cached,
    cacheCreation: 0, // OpenAI の自動キャッシュは creation を別計上しない
  };
}

export function createOpenAiProvider(apiKey: string, defaultModel: string): LlmProvider {
  const client = new OpenAI({ apiKey });

  return {
    name: "openai",
    defaultModel,

    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      const tools = toResponsesTools(params.tools);
      const stream = client.responses.stream({
        model: params.model,
        instructions: params.system,
        input: toResponsesInput(params.messages),
        max_output_tokens: params.maxTokens,
        reasoning: { effort: REASONING_EFFORT },
        ...(tools.length ? { tools } : {}),
      });

      stream.on("response.output_text.delta", (e) => params.onText?.(e.delta));
      const response = await stream.finalResponse();

      let text = "";
      const toolUses: LlmAssistantBlock[] = [];
      for (const item of response.output ?? []) {
        if (item.type === "message") {
          for (const part of item.content) if (part.type === "output_text") text += part.text;
        } else if (item.type === "function_call") {
          toolUses.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: parseArgs(item.arguments),
          });
        }
      }

      const blocks: LlmAssistantBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      blocks.push(...toolUses);

      return {
        blocks,
        stopReason: toolUses.length > 0 ? "tool_use" : "stop",
        usage: mapUsage(response.usage),
      };
    },

    async complete(params: CompleteParams): Promise<string> {
      // 注: reasoning モデルは非既定 temperature を拒否しうるため temperature は送らない
      //（要約の安定性は reasoning.effort:"none" でほぼ担保される）。
      const res = await client.responses.create({
        model: params.model,
        instructions: params.system,
        input: params.prompt,
        max_output_tokens: params.maxTokens,
        reasoning: { effort: REASONING_EFFORT },
      });
      return res.output_text ?? "";
    },
  };
}
