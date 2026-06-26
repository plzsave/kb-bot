import { expect, test, describe } from "bun:test";
import { detectLang, uiText, isPlaceholder } from "../src/chat/messages.ts";

describe("detectLang", () => {
  test("日本語文字を含めば ja", () => {
    expect(detectLang("デプロイ手順は？")).toBe("ja");
    expect(detectLang("How do I デプロイ?")).toBe("ja"); // 混在でも日本語があれば ja
    expect(detectLang("漢字のみ")).toBe("ja");
    expect(detectLang("カタカナ")).toBe("ja");
  });

  test("日本語文字が無ければ en（既定）", () => {
    expect(detectLang("How do I deploy?")).toBe("en");
    expect(detectLang("123 + 456 = ?")).toBe("en");
    expect(detectLang("")).toBe("en");
  });
});

describe("uiText", () => {
  test("質問の言語に合わせた外枠文言を返す", () => {
    expect(uiText("デプロイは？").thinking).toBe("考え中… ⏳");
    expect(uiText("How to deploy?").thinking).toBe("Thinking… ⏳");
    // 回答本文と齟齬しないよう、英語質問にはキャッシュ印も英語
    expect(uiText("How to deploy?").cacheTag).not.toContain("キャッシュ");
    expect(uiText("デプロイは？").cacheTag).toContain("キャッシュ");
  });
});

describe("isPlaceholder", () => {
  test("両言語の thinking / thinkingHard を番兵として認識する", () => {
    expect(isPlaceholder("考え中… ⏳")).toBe(true);
    expect(isPlaceholder("じっくり考え中… ⏳")).toBe(true);
    expect(isPlaceholder("Thinking… ⏳")).toBe(true);
    expect(isPlaceholder("Thinking harder… ⏳")).toBe(true);
  });

  test("通常の回答テキストは番兵にしない", () => {
    expect(isPlaceholder("有効期限は 90 日です。")).toBe(false);
    expect(isPlaceholder("The token expires in 90 days.")).toBe(false);
    expect(isPlaceholder("")).toBe(false);
  });
});
