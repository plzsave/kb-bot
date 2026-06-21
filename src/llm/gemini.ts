import { GoogleGenAI, ThinkingLevel, type Content, type Part, type Tool } from "@google/genai";
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

// Gemini アダプタ。中立型 ⇄ @google/genai の相互変換のみを担う。
// - role: assistant → "model"。tool_use → functionCall、tool_result → functionResponse。
// - tool 定義は parametersJsonSchema に素の JSON Schema をそのまま渡す（Schema enum 形式への変換不要）。
// - プロンプトキャッシュは暗黙キャッシュが自動で効くため cacheHint は no-op（割引は維持される）。
// - usage は promptTokenCount からキャッシュ分(cachedContentTokenCount)を差し引いて input に正規化し、
//   出力には思考分(thoughtsTokenCount)も足してコストを取りこぼさない。
//
// 【thinking】Gemini 2.5/3.x flash 系は思考が既定 ON で、思考トークンが maxOutputTokens に算入される。
// 簡潔・低コスト回答が目的なので思考を MINIMAL に絞る（さもないと思考が枠を食い切り本文が空＝
// finishReason: MAX_TOKENS になりうる）。
const THINKING_CONFIG = { thinkingLevel: ThinkingLevel.MINIMAL };

/** 中立ツール定義 → Gemini Tool（functionDeclarations）。 */
function toGeminiTools(tools: LlmToolDef[]): Tool[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    },
  ];
}

/** 中立メッセージ → Gemini contents。text/functionCall/functionResponse を相互変換する。 */
export function toGeminiContents(messages: LlmMessage[]): Content[] {
  return messages.map((m): Content => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      return { role, parts: [{ text: m.content }] };
    }
    const parts: Part[] = m.content.map((b): Part => {
      switch (b.type) {
        case "text":
          return { text: b.text };
        case "tool_use":
          return {
            functionCall: {
              id: b.id,
              name: b.name,
              args: (b.input ?? {}) as Record<string, unknown>,
            },
          };
        case "tool_result":
          return {
            functionResponse: {
              id: b.toolUseId,
              name: b.name,
              response: { result: b.content },
            },
          };
      }
    });
    return { role, parts };
  });
}

export function createGeminiProvider(apiKey: string, defaultModel: string): LlmProvider {
  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",
    defaultModel,

    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      const tools = toGeminiTools(params.tools);
      const stream = await ai.models.generateContentStream({
        model: params.model,
        contents: toGeminiContents(params.messages),
        config: {
          systemInstruction: params.system,
          maxOutputTokens: params.maxTokens,
          thinkingConfig: THINKING_CONFIG,
          ...(tools.length ? { tools } : {}),
        },
      });

      let text = "";
      const toolUses: LlmAssistantBlock[] = [];
      let prompt = 0;
      let cached = 0;
      let candidates = 0;
      let thoughts = 0;

      for await (const chunk of stream) {
        const delta = chunk.text;
        if (delta) {
          text += delta;
          params.onText?.(delta);
        }
        for (const fc of chunk.functionCalls ?? []) {
          toolUses.push({
            type: "tool_use",
            id: fc.id ?? `${fc.name ?? "fn"}-${toolUses.length}`,
            name: fc.name ?? "",
            input: fc.args ?? {},
          });
        }
        // usageMetadata は累積で（多くは最終チャンクに）付くため、来るたびに上書きする。
        const u = chunk.usageMetadata;
        if (u) {
          prompt = u.promptTokenCount ?? prompt;
          cached = u.cachedContentTokenCount ?? cached;
          candidates = u.candidatesTokenCount ?? candidates;
          thoughts = u.thoughtsTokenCount ?? thoughts;
        }
      }

      const blocks: LlmAssistantBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      blocks.push(...toolUses);

      const usage: LlmUsage = {
        input: Math.max(0, prompt - cached), // promptTokenCount はキャッシュ分を含むので差し引く
        output: candidates + thoughts, // 思考分も課金対象なので出力に合算する
        cacheRead: cached,
        cacheCreation: 0, // Gemini の暗黙キャッシュは creation を別計上しない
      };

      return {
        blocks,
        stopReason: toolUses.length > 0 ? "tool_use" : "stop",
        usage,
      };
    },

    async complete(params: CompleteParams): Promise<string> {
      const res = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.prompt }] }],
        config: {
          systemInstruction: params.system,
          maxOutputTokens: params.maxTokens,
          thinkingConfig: THINKING_CONFIG,
          ...(params.temperature != null ? { temperature: params.temperature } : {}),
        },
      });
      return res.text ?? "";
    },
  };
}
