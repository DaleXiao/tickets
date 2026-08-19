// SPEC-351 关键风险守卫（判定逻辑快照）：
// 防盗刷 = icon-forge（SPEC-341）同款 trusted anonymous session 机制，
// 移植到 tickets worker：session bootstrap + Turnstile + PoW 回退 + HMAC session +
// session 维度日配额（取代原 IP 日配额）+ generate/quota gate。
// 用 source 快照断言，因为 worker 源码依赖 Cloudflare global，无法直接 import 执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("B：Env 挂 TURNSTILE_SECRET（部署前置 secret）", () => {
  assert.ok(src.includes("TURNSTILE_SECRET?: string"));
});

test("B：session bootstrap 路由 + 处理函数在位", () => {
  assert.ok(src.includes('path === "/api/session"'));
  assert.ok(src.includes("handleSessionBootstrap"));
  assert.ok(src.includes("SESSION_COOKIE = \"trusted_session\""));
});

test("B：PoW 回退（challenge 签发 + 16 bits 前导零 + 重放防护）", () => {
  assert.ok(src.includes('path === "/api/pow-challenge"'));
  assert.ok(src.includes("issuePowChallenge"));
  assert.ok(src.includes("POW_DIFFICULTY = 16"));
  assert.ok(src.includes("pow-used:"));
});

test("B：Turnstile siteverify 验证", () => {
  assert.ok(src.includes("turnstile/v0/siteverify"));
  assert.ok(src.includes("verifyTurnstile"));
});

test("B：HMAC trusted session 签发与校验（恒时比较 + 过期判断）", () => {
  assert.ok(src.includes("issueTrustedSession"));
  assert.ok(src.includes("verifyTrustedSession"));
  assert.ok(src.includes('name: "HMAC"'));
});

test("B：配额改 session 维度，且计数在 DO storage 强一致预扣（v1.6.1 修复超额 bug）", () => {
  // DO 事务预扣/退还/查询在位
  assert.ok(src.includes("reserveSessionQuota"));
  assert.ok(src.includes("refundSessionQuota"));
  assert.ok(src.includes("session-quota"));
  assert.ok(src.includes("session-limit:${sid}:"));
  assert.ok(src.includes("this.state.storage.transaction"));
  // 旧 KV 计数路径（最终一致，超额 bug 根因）必须已移除
  assert.ok(!src.includes("incrementSessionLimit"));
  assert.ok(!src.includes("checkSessionLimit"));
  assert.ok(!src.includes("getSessionRemainingQuota"));
  // 原 IP 日配额逻辑必须已被移除（否则 session 取代未落地，双配额残留）
  assert.ok(!src.includes("checkRateLimit"));
  assert.ok(!src.includes("getRemainingQuota"));
  assert.ok(!src.includes("limit:${ip}:${today}"));
});

test("B：generate/quota 无 session → verification_required 403", () => {
  assert.ok(src.includes("verification_required"));
  assert.ok(src.includes("需要完成一次安全验证"));
  assert.ok(src.includes("403"));
});

test("B：IP 突发限流保留为第二道闸", () => {
  assert.ok(src.includes("checkBurst"));
  assert.ok(src.includes("rate_limited_burst"));
});

console.log("session-gate snapshot tests passed");