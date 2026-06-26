import { expect, test } from "bun:test";
import { rejectPath, createGitHub, renderTree } from "../src/github.ts";

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

test("renderTree: 小規模リポは全ファイルを列挙する", () => {
  const out = renderTree(["src/index.ts", "README.md"]);
  expect(out).toBe("src/index.ts\nREADME.md");
});

test("renderTree: 大規模（モノレポ）は概要と manifest を返し subdir 深掘りを促す", () => {
  const paths: string[] = [];
  for (let i = 0; i < 500; i++) paths.push(`packages/web/src/file${i}.ts`);
  for (let i = 0; i < 500; i++) paths.push(`packages/api/src/file${i}.ts`);
  paths.push("packages/web/package.json", "packages/api/package.json", "Cargo.toml");

  const out = renderTree(paths);
  expect(out).toContain("subdir を指定して深掘り"); // 全列挙ではなく概要に切り替わる
  expect(out).toContain("packages/"); // トップ階層が見える
  expect(out).toContain("packages/web/package.json"); // パッケージの目印が地図として残る
  expect(out).toContain("Cargo.toml");
});

test("renderTree: subdir 指定でその配下だけに絞る", () => {
  const paths = ["packages/web/a.ts", "packages/web/b.ts", "packages/api/c.ts"];
  const out = renderTree(paths, "packages/web");
  expect(out).toBe("packages/web/a.ts\npackages/web/b.ts");
});

test("renderTree: subdir に該当が無ければその旨を返す", () => {
  const out = renderTree(["packages/web/a.ts"], "packages/none");
  expect(out).toContain("配下にファイルが見つかりません");
});
