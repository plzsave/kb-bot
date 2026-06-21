import { expect, test } from "bun:test";
import { answer, type AnswerDeps, type ChatReply, type ReplyHandle } from "../src/chat/core.ts";
import { openDb } from "../src/kb/db.ts";
import { ensureCacheTable } from "../src/cache.ts";
import { ensureUsageTable } from "../src/usage.ts";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../src/llm/provider.ts";

// モデル昇格(A+B)と 404/退役フォールバックの整合を、フェイク provider で固定する。
// 各モデルの振る舞いをマップで指定し、streamTurn が受け取った model 名を記録する。

type Behavior = "toolloop" | "notfound" | { text: string };

function fakeProvider(map: Record<string, Behavior>): LlmProvider & { models: string[] } {
  const models: string[] = [];
  return {
    name: "fake",
    defaultModel: "fallback-model",
    models,
    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      models.push(params.model);
      const beh = map[params.model] ?? { text: "default" };
      if (beh === "notfound") throw { status: 404, message: "model not found" };
      const usage = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 };
      if (beh === "toolloop") {
        // 未知ツールを呼び続けて maxTurns 到達＝truncated を誘発する。
        return { blocks: [{ type: "tool_use", id: "t", name: "noop", input: {} }], stopReason: "tool_use", usage };
      }
      params.onText?.(beh.text);
      return { blocks: [{ type: "text", text: beh.text }], stopReason: "stop", usage };
    },
    async complete() {
      return "";
    },
  };
}

function fakeReply(): { reply: ChatReply; final: () => string } {
  let final = "";
  const handle: ReplyHandle = {
    async update(t: string) {
      final = t;
    },
  };
  return {
    reply: {
      async send(t: string) {
        final = t;
        return handle;
      },
    },
    final: () => final,
  };
}

function deps(provider: LlmProvider, model: string, modelHard?: string): AnswerDeps {
  const db = openDb(":memory:");
  ensureCacheTable(db);
  ensureUsageTable(db);
  return { db, provider, model, modelHard };
}

test("B 昇格: 最安が打ち切られたら上位ティアで再実行して救済する", async () => {
  const provider = fakeProvider({ base: "toolloop", hard: { text: "解決しました" } });
  const r = fakeReply();
  await answer("難問", r.reply, deps(provider, "base", "hard"));

  expect(r.final()).toBe("解決しました");
  expect(provider.models).toContain("hard"); // 上位ティアで再実行された
  expect(provider.models.filter((m) => m === "base").length).toBeGreaterThan(0);
});

test("KB_MODEL_HARD 未設定なら昇格しない（常に基本ティア）", async () => {
  const provider = fakeProvider({ base: "toolloop" });
  const r = fakeReply();
  await answer("難問", r.reply, deps(provider, "base", undefined));

  // 打ち切られても上位が無いので base だけ。fallback-model も呼ばれない。
  expect(new Set(provider.models)).toEqual(new Set(["base"]));
});

test("基本ティアが 404/退役なら既定モデルへフォールバックして回答を継続", async () => {
  const provider = fakeProvider({ base: "notfound", "fallback-model": { text: "復旧回答" } });
  const r = fakeReply();
  await answer("質問", r.reply, deps(provider, "base", undefined));

  expect(r.final()).toBe("復旧回答");
  expect(provider.models).toEqual(["base", "fallback-model"]);
});

test("整合性: 上位へ昇格 → 上位が退役 → 既定へフォールバック（昇格とフォールバックが両立）", async () => {
  const provider = fakeProvider({ base: "toolloop", hard: "notfound", "fallback-model": { text: "救済回答" } });
  const r = fakeReply();
  await answer("難問", r.reply, deps(provider, "base", "hard"));

  expect(r.final()).toBe("救済回答");
  // base(打ち切り) → hard(退役) → fallback-model(成功) の順で踏んでいる。
  expect(provider.models).toContain("hard");
  expect(provider.models[provider.models.length - 1]).toBe("fallback-model");
});
