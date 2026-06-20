import { expect, test } from "bun:test";
import { rejectPath, createGitHub } from "../src/github.ts";

test("秘匿ファイルは拒否する", () => {
  expect(rejectPath(".env")).not.toBeNull();
  expect(rejectPath("config/.env.production")).not.toBeNull();
  expect(rejectPath("keys/server.pem")).not.toBeNull();
  expect(rejectPath("secrets/token.txt")).not.toBeNull();
});

test("パストラバーサル・絶対パス・URL を拒否する", () => {
  expect(rejectPath("../etc/passwd")).not.toBeNull();
  expect(rejectPath("/etc/passwd")).not.toBeNull();
  expect(rejectPath("https://example.com/x")).not.toBeNull();
  expect(rejectPath("")).not.toBeNull();
});

test("通常のソースパスは許可する", () => {
  expect(rejectPath("src/index.ts")).toBeNull();
  expect(rejectPath("docs/guide.md")).toBeNull();
});

test("resolveRepo は allowlist 外を拒否する", () => {
  const gh = createGitHub(undefined, ["owner/allowed"]);
  expect(gh.resolveRepo("owner/allowed")).toEqual({ repo: "owner/allowed" });
  const denied = gh.resolveRepo("owner/evil");
  expect("error" in denied).toBe(true);
});

test("単一リポなら repo 省略で既定を使う", () => {
  const gh = createGitHub(undefined, ["owner/only"]);
  expect(gh.resolveRepo()).toEqual({ repo: "owner/only" });
});

test("複数リポで repo 省略はエラー", () => {
  const gh = createGitHub(undefined, ["a/b", "c/d"]);
  expect("error" in gh.resolveRepo()).toBe(true);
});
