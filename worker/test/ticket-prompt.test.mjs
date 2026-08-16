// SPEC-347 关键风险守卫（判定逻辑快照）：
// 片名/时间原文必须逐字注入图像 prompt，CJK 文字精确约束不可被误删，
// 且 v1.1 三项新约束在位：极简海报（E）、衬线排版（F）、三行文字+ELSEWHERE CINEMA（G）。
// 用 source 快照断言，因为 worker 源码依赖 Cloudflare global，无法直接 import 执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("片名与时间原文逐字注入图像 prompt", () => {
  assert.ok(src.includes('the film title, typeset large and elegant in an editorial Didone/Garamond serif, on its own line: "${title}"'));
  assert.ok(src.includes('the showtime, typeset smaller beneath the title in the same serif, clearly subordinated: "${showtime}"'));
});

test("G：第三行固定文案 ELSEWHERE CINEMA（大写冒号内，非用户输入）", () => {
  assert.ok(src.includes('"ELSEWHERE CINEMA"'));
  assert.ok(src.includes("small and letter-spaced uppercase small-caps, the fixed cinema name"));
  assert.ok(src.includes("EXACTLY THREE lines"));
  // 旧约束「EXACTLY TWO lines」必须已被移除（否则两行改三行未落地）
  assert.ok(!src.includes("EXACTLY TWO lines"));
});

test("F：衬线排版写入 prompt（editorial serif / Didone/Garamond / elegant typesetting）", () => {
  assert.ok(src.includes("Didone/Garamond serif"));
  assert.ok(src.includes("elegant editorial hierarchy"));
  assert.ok(src.includes("elegant typesetting") || src.includes("refined print ticket"));
});

test("E：极简海报约束在位（single motif / flat / 大留白 / 禁渐变）", () => {
  assert.ok(src.includes("SIMPLEST POSSIBLE"));
  assert.ok(src.includes("MINIMALIST POSTER-GRADE"));
  assert.ok(src.includes("Flat solid fills, no gradients"));
  assert.ok(src.includes("Never enumerate a roster of scenes"));
  assert.ok(src.includes("TWO TO THREE COLORS"));
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

test("禁止页面标签词与多余正文（no ADMIT ONE / no seat numbers）", () => {
  assert.ok(src.includes("no 'ADMIT ONE'"));
  assert.ok(src.includes("no seat numbers"));
});

test("生图关闭 prompt 扩写与去水印（文字精确优先）", () => {
  assert.ok(src.includes("prompt_extend: false"));
  assert.ok(src.includes("watermark: false"));
});

console.log("ticket-prompt snapshot tests passed");