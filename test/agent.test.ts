import { expect, test } from "bun:test";
import { runAgent, type AgentTool } from "../src/agent/agent.ts";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../src/llm/provider.ts";

// フェイク provider で runAgent のループを固定する（プロバイダ非依存のループ論理の回帰ガード）。
// スクリプト化した各ターンの応答を順に返し、呼び出し時の引数も記録する。

function fakeProvider(
  script: Array<Omit<StreamTurnResult, "usage"> & { usage?: Partial<StreamTurnResult["usage"]> }>,
): LlmProvider & { calls: StreamTurnParams[] } {
  const calls: StreamTurnParams[] = [];
  let i = 0;
  return {
    name: "fake",
    defaultModel: "fake-model",
    calls,
    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      calls.push(params);
      const turn = script[Math.min(i, script.length - 1)]!;
      i++;
      // テキストブロックは onText で逐次通知（実 provider のストリーミング相当）。
      for (const b of turn.blocks) if (b.type === "text") params.onText?.(b.text);
      return {
        blocks: turn.blocks,
        stopReason: turn.stopReason,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ...turn.usage },
      };
    },
    async complete() {
      return "";
    },
  };
}

const echoTool: AgentTool = {
  def: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run(input) {
    return `ran:${JSON.stringify(input)}`;
  },
};

test("tool_use → tool_result → 最終回答（ツール往復が1周回る）", async () => {
  const provider = fakeProvider([
    {
      blocks: [{ type: "tool_use", id: "t1", name: "echo", input: { q: "hi" } }],
      stopReason: "tool_use",
      usage: { input: 10, output: 2 },
    },
    {
      blocks: [{ type: "text", text: "最終回答です" }],
      stopReason: "stop",
      usage: { input: 5, output: 7, cacheRead: 3 },
    },
  ]);

  const deltas: string[] = [];
  const result = await runAgent({
    provider,
    model: "m",
    system: "sys",
    messages: [{ role: "user", content: "質問" }],
    tools: [echoTool],
    onDelta: (t) => deltas.push(t),
  });

  expect(result.text).toBe("最終回答です");
  expect(result.truncated).toBe(false);
  expect(result.toolsUsed).toEqual(["echo"]);
  // usage はターンを跨いで累積。
  expect(result.usage).toEqual({ input: 15, output: 9, cacheRead: 3, cacheCreation: 0 });
  // onDelta は最終ターンのテキストを受け取る。
  expect(deltas.join("")).toBe("最終回答です");

  // 2 ターン目の messages に、assistant の tool_use と user の tool_result(name 付き) が積まれている。
  const secondTurnMessages = provider.calls[1]!.messages;
  expect(secondTurnMessages).toHaveLength(3); // user質問 / assistant tool_use / user tool_result
  const toolResultMsg = secondTurnMessages[2]!;
  expect(toolResultMsg.role).toBe("user");
  const block = (toolResultMsg.content as any[])[0];
  expect(block.type).toBe("tool_result");
  expect(block.toolUseId).toBe("t1");
  expect(block.name).toBe("echo");
  expect(block.content).toBe('ran:{"q":"hi"}');
});

test("cacheHint が常に渡る（プロンプトキャッシュのヒント付与）", async () => {
  const provider = fakeProvider([{ blocks: [{ type: "text", text: "x" }], stopReason: "stop" }]);
  await runAgent({
    provider,
    model: "m",
    system: "sys",
    messages: [{ role: "user", content: "q" }],
    tools: [],
  });
  expect(provider.calls[0]!.cacheHint).toBe(true);
});

test("毎ターン tool_use なら maxTurns で打ち切り truncated になる", async () => {
  const provider = fakeProvider([
    {
      blocks: [
        { type: "text", text: "途中…" },
        { type: "tool_use", id: "t", name: "echo", input: {} },
      ],
      stopReason: "tool_use",
    },
  ]);

  const result = await runAgent({
    provider,
    model: "m",
    system: "sys",
    messages: [{ role: "user", content: "q" }],
    tools: [echoTool],
    maxTurns: 2,
  });

  expect(result.truncated).toBe(true);
  expect(provider.calls).toHaveLength(2); // maxTurns 分だけ呼ばれる
  // truncated 時は全ターンの逐次出力をフォールバックに使う。
  expect(result.text).toBe("途中…途中…");
});

test("未知ツールはエラーメモを返してループは継続する", async () => {
  const provider = fakeProvider([
    {
      blocks: [{ type: "tool_use", id: "t1", name: "missing", input: {} }],
      stopReason: "tool_use",
    },
    { blocks: [{ type: "text", text: "done" }], stopReason: "stop" },
  ]);

  const result = await runAgent({
    provider,
    model: "m",
    system: "sys",
    messages: [{ role: "user", content: "q" }],
    tools: [echoTool],
  });

  expect(result.text).toBe("done");
  const toolResultBlock = (provider.calls[1]!.messages[2]!.content as any[])[0];
  expect(toolResultBlock.content).toBe("unknown tool: missing");
});
