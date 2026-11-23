import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GCP_PROJECT_ID ??= "test-project";
process.env.STORAGE_BUCKET ??= "test-bucket";

const { buildApp } = await import("../src/app.js");

test("GET /health trả 200", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
  await app.close();
});

test("thiếu token -> 401 UNAUTHENTICATED", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/users/me" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("route không tồn tại -> 404 NOT_FOUND dạng chuẩn", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/khong-co" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "NOT_FOUND");
  await app.close();
});
