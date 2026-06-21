// LLM 呼び出しが「指定モデルが存在しない/退役した」で失敗したかを判定する（プロバイダ非依存）。
// 常駐プロセスでは、設定モデルが稼働中に退役日を迎えると streamTurn が 404 を投げ始める。
// これを掴んで既定モデルへフォールバックする（src/chat/core.ts）ことで、再起動なしに生き延びる。
//
// 3 社（Anthropic / OpenAI / Gemini）の SDK はいずれも 404 系を投げる。第一義は HTTP ステータス
// 404、取りこぼし保険としてメッセージ文字列も見る（"model not found" / "does not exist" 等）。

export function isModelNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 404 || e.code === 404) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("not_found") ||
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    (msg.includes("model") && (msg.includes("deprecat") || msg.includes("retired")))
  );
}
