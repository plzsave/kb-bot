import { expect, test } from "bun:test";
import { InFlightGuard } from "../src/inflight.ts";

test("同一キーの二重取得を弾き、release で再取得できる", () => {
  const g = new InFlightGuard();
  expect(g.tryAcquire("u1")).toBe(true);
  expect(g.tryAcquire("u1")).toBe(false); // 処理中
  g.release("u1");
  expect(g.tryAcquire("u1")).toBe(true); // 解放後は再取得可
});

test("別キーは互いに干渉しない", () => {
  const g = new InFlightGuard();
  expect(g.tryAcquire("u1")).toBe(true);
  expect(g.tryAcquire("u2")).toBe(true);
});
