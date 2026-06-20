import { expect, test } from "bun:test";
import { toSlackMrkdwn } from "../src/chat/slack.ts";

test("**太字** を *太字* に変換する", () => {
  expect(toSlackMrkdwn("これは **太字** です")).toBe("これは *太字* です");
});

test("見出しは太字に倒す", () => {
  expect(toSlackMrkdwn("# 見出し")).toBe("*見出し*");
});

test("水平線は区切り線に置換する", () => {
  expect(toSlackMrkdwn("---")).toBe("──────────");
});

test("箇条書きは • に変換する", () => {
  expect(toSlackMrkdwn("- 項目")).toBe("• 項目");
});

test("リンクは <url|text> に変換する", () => {
  expect(toSlackMrkdwn("[doc](https://x.test)")).toBe("<https://x.test|doc>");
});

test("コードフェンス内は変換しない", () => {
  const md = "```\n**not bold**\n```";
  expect(toSlackMrkdwn(md)).toBe(md);
});

test("インラインコード内は変換しない", () => {
  expect(toSlackMrkdwn("`**x**` と **y**")).toBe("`**x**` と *y*");
});

test("不揃いなアスタリスク（**x* / *x**）も * に寄せる", () => {
  expect(toSlackMrkdwn("**設定します*。")).toBe("*設定します*。");
  expect(toSlackMrkdwn("*設定方法:**")).toBe("*設定方法:*");
});

test("*** (太字斜体) も * に寄せる", () => {
  expect(toSlackMrkdwn("***重要***")).toBe("*重要*");
});

test("アンダースコア（Python ダンダー等）は壊さない", () => {
  expect(toSlackMrkdwn("src/mailprobe/__main__.py を参照")).toBe("src/mailprobe/__main__.py を参照");
  expect(toSlackMrkdwn("config.token_path")).toBe("config.token_path");
});
