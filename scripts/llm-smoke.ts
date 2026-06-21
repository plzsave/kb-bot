#!/usr/bin/env bun
// LLM 疎通確認用の使い捨てスクリプト。Slack/S3/DB を立てずに、選択中プロバイダの
// complete（一発生成）と streamTurn（ストリーミング・ツール無し）だけを叩く。
// thinking 修正が効いて本文が空にならないこと・usage が取れることを目視確認する。
//
//   KB_LLM_PROVIDER=gemini GEMINI_API_KEY=... KB_MODEL= bun run scripts/llm-smoke.ts
//
// ※ .env に KB_MODEL が固定されていると別社モデル id が渡るので、上のように KB_MODEL= で打ち消すこと。

import { createLlm } from "../src/llm/factory.ts";
import { runAgent, type AgentTool } from "../src/agent/agent.ts";

const { provider, model } = createLlm();
console.log(`▶ provider=${provider.name} model=${model}\n`);

// 1) complete: ツール無しの単発生成（issue 要約と同じ経路）
console.log("--- complete() ---");
const completion = await provider.complete({
  model,
  system: "あなたは簡潔な日本語アシスタントです。",
  prompt: "「疎通確認OK」とだけ返してください。",
  maxTokens: 64,
  temperature: 0,
});
console.log(`応答: ${JSON.stringify(completion)}`);
console.log(completion.trim() ? "✅ 本文あり\n" : "❌ 本文が空（thinking 枠枯渇などを疑う）\n");

// 2) streamTurn: ストリーミング（bot 本体と同じ経路。ツールは無し）
console.log("--- streamTurn() ---");
process.stdout.write("応答: ");
const result = await provider.streamTurn({
  model,
  system: "あなたは簡潔な日本語アシスタントです。",
  messages: [{ role: "user", content: "1 から 5 まで日本語で数えてください。" }],
  tools: [],
  maxTokens: 128,
  cacheHint: true,
  onText: (delta) => process.stdout.write(delta),
});
console.log("\n");
const text = result.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
console.log(text.trim() ? "✅ 本文あり" : "❌ 本文が空");
console.log(`stopReason=${result.stopReason}`);
console.log(`usage=${JSON.stringify(result.usage)}`);

// 3) tool 往復: runAgent（bot 本体と同じループ）にダミーツールを1個渡し、
//    functionCall → functionResponse の実 API 往復を確認する。モデルが知り得ない
//    「社内在庫」を聞くことで、ツールを呼ばざるを得ない状況にする。
console.log("\n--- runAgent() tool 往復 ---");
let toolCalled = false;
const STOCK = "42"; // モデルが事前に知り得ない値（ツール経由でしか答えられない）
const stockTool: AgentTool = {
  def: {
    name: "get_stock",
    description: "社内倉庫の在庫数を照会する。商品名の在庫を知りたい時に必ず使う。",
    parameters: {
      type: "object",
      properties: { item: { type: "string", description: "商品名" } },
      required: ["item"],
    },
  },
  async run(input) {
    toolCalled = true;
    const { item } = (input ?? {}) as { item?: string };
    console.log(`  [tool] get_stock(${JSON.stringify(item)}) → ${STOCK}`);
    return `${item} の在庫は ${STOCK} 個です。`;
  },
};

process.stdout.write("応答: ");
const agentResult = await runAgent({
  provider,
  model,
  system: "あなたは社内アシスタントです。在庫を聞かれたら get_stock ツールで調べて答えます。",
  messages: [{ role: "user", content: "りんごの在庫は何個ありますか？" }],
  tools: [stockTool],
  onDelta: (t) => process.stdout.write(t),
});
console.log("\n");
console.log(toolCalled ? "✅ ツールが呼ばれた" : "❌ ツールが呼ばれていない");
console.log(`toolsUsed=${JSON.stringify(agentResult.toolsUsed)}`);
console.log(
  agentResult.text.includes(STOCK)
    ? `✅ ツール結果(${STOCK})を踏まえた回答になっている`
    : `⚠️ 回答に ${STOCK} が含まれない（往復はしたが要確認）`,
);
console.log(`truncated=${agentResult.truncated}`);
console.log(`usage=${JSON.stringify(agentResult.usage)}`);
