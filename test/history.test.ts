import { expect, test } from "bun:test";
import { normalizeHistory } from "../src/chat/core.ts";

test("先頭の assistant は落とす（user 始まりにする）", () => {
  const out = normalizeHistory([
    { role: "assistant", text: "前置き" },
    { role: "user", text: "質問" },
  ]);
  expect(out[0]!.role).toBe("user");
  expect(out.length).toBe(1);
});

test("連続する同一ロールは結合する", () => {
  const out = normalizeHistory([
    { role: "user", text: "A" },
    { role: "user", text: "B" },
    { role: "assistant", text: "C" },
  ]);
  expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(out[0]!.content).toBe("A\n\nB");
});

test("空テキストは無視する", () => {
  const out = normalizeHistory([
    { role: "user", text: "  " },
    { role: "user", text: "質問" },
  ]);
  expect(out.length).toBe(1);
  expect(out[0]!.content).toBe("質問");
});

test("交互の履歴はそのまま保たれる", () => {
  const out = normalizeHistory([
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
  ]);
  expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});
