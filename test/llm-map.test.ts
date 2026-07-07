import { expect, test } from "bun:test";
import { toAnthropicMessages } from "../src/llm/anthropic.ts";
import { toGeminiContents } from "../src/llm/gemini.ts";
import { toResponsesInput } from "../src/llm/openai.ts";
import type { LlmMessage } from "../src/llm/provider.ts";

// 中立メッセージ → 各社ネイティブ形式の変換（純関数・ネットワーク無し）。
// tool_use/tool_result の往復と role 変換が、各社の仕様どおりに写ることを固定する。

const conversation: LlmMessage[] = [
  { role: "user", content: "質問" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "確認します" },
      { type: "tool_use", id: "call_1", name: "echo", input: { q: "hi" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "call_1", name: "echo", content: "result text" }],
  },
];

test("Anthropic: tool_use/tool_result/text を MessageParam に写す", () => {
  const out = toAnthropicMessages(conversation);
  expect(out[0]).toEqual({ role: "user", content: "質問" });

  const assistant = out[1]!;
  expect(assistant.role).toBe("assistant");
  expect(assistant.content).toEqual([
    { type: "text", text: "確認します" },
    { type: "tool_use", id: "call_1", name: "echo", input: { q: "hi" } },
  ]);

  // tool_result は tool_use_id にスネークケースで写る（name は持たない）。
  const toolResult = (out[2]!.content as any[])[0];
  expect(toolResult).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "result text" });
});

test("Gemini: role=assistant→model、functionCall/functionResponse に写す", () => {
  const out = toGeminiContents(conversation);

  expect(out[0]).toEqual({ role: "user", parts: [{ text: "質問" }] });

  const model = out[1]!;
  expect(model.role).toBe("model"); // assistant → model
  expect(model.parts).toEqual([
    { text: "確認します" },
    { functionCall: { id: "call_1", name: "echo", args: { q: "hi" } } },
  ]);

  // tool_result → functionResponse。name+id を保持し、本文は response.result に入れる。
  const fnResp = out[2]!.parts![0]!;
  expect(fnResp.functionResponse).toEqual({
    id: "call_1",
    name: "echo",
    response: { result: "result text" },
  });
});

test("Gemini: thoughtSignature を functionCall パートに添えて再送する（3.x 必須）", () => {
  const out = toGeminiContents([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "echo",
          input: { q: "hi" },
          providerMeta: { thoughtSignature: "SIG_ABC" },
        },
      ],
    },
  ]);
  const part = out[0]!.parts![0]!;
  expect(part.thoughtSignature).toBe("SIG_ABC");
  expect(part.functionCall).toEqual({ id: "call_1", name: "echo", args: { q: "hi" } });
});

test("Gemini: providerMeta が無ければ thoughtSignature を付けない", () => {
  const out = toGeminiContents([
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "echo", input: {} }] },
  ]);
  expect(out[0]!.parts![0]!.thoughtSignature).toBeUndefined();
});

test("OpenAI(Responses): tool_use→function_call、text は assistant メッセージに分かれる", () => {
  const out = toResponsesInput(conversation);
  expect(out[0]).toEqual({ role: "user", content: "質問" });
  // assistant ターンは text メッセージと function_call アイテムに分かれる。
  expect(out[1]).toEqual({ role: "assistant", content: "確認します" });
  expect(out[2]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "echo",
    arguments: '{"q":"hi"}',
  });
});

test("OpenAI(Responses): tool_result は function_call_output として call_id で対応づけ展開", () => {
  const out = toResponsesInput([
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call_1", name: "echo", content: "r1" },
        { type: "tool_result", toolUseId: "call_2", name: "echo", content: "r2" },
      ],
    },
  ]);
  expect(out).toEqual([
    { type: "function_call_output", call_id: "call_1", output: "r1" },
    { type: "function_call_output", call_id: "call_2", output: "r2" },
  ]);
});

test("OpenAI(Responses): tool_use のみ（テキスト無し）は function_call だけ", () => {
  const out = toResponsesInput([
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "echo", input: { a: 1 } }] },
  ]);
  expect(out).toEqual([{ type: "function_call", call_id: "c1", name: "echo", arguments: '{"a":1}' }]);
});
