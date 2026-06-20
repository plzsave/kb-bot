import { expect, test } from "bun:test";
import { splitForDiscord, toDiscordMarkdown } from "../src/chat/discord.ts";

test("2000 字以下はそのまま 1 チャンク", () => {
  expect(splitForDiscord("短い")).toEqual(["短い"]);
  expect(splitForDiscord("あ".repeat(2000)).length).toBe(1);
});

test("2000 字超は各 2000 字以内に分割する", () => {
  const chunks = splitForDiscord("あ".repeat(2001));
  expect(chunks.length).toBe(2);
  expect(chunks.every((c) => c.length <= 2000)).toBe(true);
});

test("標準 Markdown（太字・箇条書き・見出し）は維持する", () => {
  const md = "# 見出し\n\n- **太字**";
  expect(toDiscordMarkdown(md)).toBe(md);
});

test("水平線は区切り線に置換する", () => {
  expect(toDiscordMarkdown("---")).toBe("──────────");
});

test("マスクリンクは text (url) に展開する", () => {
  expect(toDiscordMarkdown("[doc](https://x.test)")).toBe("doc (https://x.test)");
});

test("インラインコード内は変換しない", () => {
  expect(toDiscordMarkdown("`[x](y)`")).toBe("`[x](y)`");
});
