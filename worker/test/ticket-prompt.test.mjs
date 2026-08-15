// SPEC-345 关键风险守卫（判定逻辑快照）：
// 片名/时间原文必须逐字注入图像 prompt，且 CJK 文字精确约束不可被误删。
// 用 source 快照断言，因为 worker 源码依赖 Cloudflare global，无法直接 import 执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("片名与时间原文逐字注入图像 prompt", () => {
  assert.ok(src.includes('the film title: "${title}"'));
  assert.ok(src.includes('the showtime: "${showtime}"'));
});

test("CJK 乱码风险缓解措施在位（构造类守卫）", () => {
  assert.ok(src.includes("complete, correct strokes"));
  assert.ok(src.includes("never simplified, broken, mirrored"));
  assert.ok(src.includes("character-for-character"));
});

test("prompt 改写模型被禁止自己写正文", () => {
  assert.ok(src.includes("NEVER WRITE TEXT"));
  assert.ok(src.includes("You must NOT reproduce or transliterate them"));
});

test("生图关闭 prompt 扩写与去水印（文字精确优先）", () => {
  assert.ok(src.includes("prompt_extend: false"));
  assert.ok(src.includes("watermark: false"));
});

console.log("ticket-prompt snapshot tests passed");