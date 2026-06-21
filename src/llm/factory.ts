import type { LlmProvider } from "./provider.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAiProvider } from "./openai.ts";

// 環境変数からプロバイダを選び、{ provider, model } を組み立てる単一の入口。
// KB_LLM_PROVIDER で分岐し、必要なキーだけを要求する（未選択プロバイダのキーは不要）。
// 既定モデルはプロバイダ別。KB_MODEL があればそれを優先（モデルティアリング）。

// 既定モデル（モデル名は外部識別子。更新時は各社の最新を確認すること）。
// コスト優先で各社の最安ティアを既定にし、難問だけ KB_MODEL で上位へ上げる想定。
// いずれも GA の最安ティア。確認日: 2026-06-21（gemini-3.1-flash-lite / gpt-5.4-nano）。
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";
const OPENAI_DEFAULT_MODEL = "gpt-5.4-nano";

export type ProviderName = "anthropic" | "gemini" | "openai";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function selectedProvider(): ProviderName {
  const raw = (process.env.KB_LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (raw === "anthropic" || raw === "gemini" || raw === "openai") return raw;
  throw new Error(`unknown KB_LLM_PROVIDER: ${raw}（anthropic | gemini | openai）`);
}

/** 選択中プロバイダのアダプタと、解決済みモデル名を返す。 */
export function createLlm(): { provider: LlmProvider; model: string } {
  const name = selectedProvider();
  const provider =
    name === "gemini"
      ? createGeminiProvider(required("GEMINI_API_KEY"), GEMINI_DEFAULT_MODEL)
      : name === "openai"
        ? createOpenAiProvider(required("OPENAI_API_KEY"), OPENAI_DEFAULT_MODEL)
        : createAnthropicProvider(required("ANTHROPIC_API_KEY"), ANTHROPIC_DEFAULT_MODEL);
  const model = process.env.KB_MODEL?.trim() || provider.defaultModel;
  return { provider, model };
}
