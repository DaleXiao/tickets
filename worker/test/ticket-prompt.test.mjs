// SPEC-348 关键风险守卫（判定逻辑快照）：
// 片名/时间/座位号原文必须逐字注入图像 prompt，CJK 文字精确约束不可被误删，
// v1.2 新增约束在位：可辨识海报（A）、文字无重叠（B）、日期时间对齐（C）、
// 随机座位号 + 底部条形码（F）、三行主文字 + ELSEWHERE CINEMA 保持、四行总文字。
// 用 source 快照断言，因为 worker 源码依赖 Cloudflare global，无法直接 import 执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("片名与时间原文逐字注入图像 prompt", () => {
  assert.ok(src.includes('the film title, typeset large and elegant in an editorial Didone/Garamond serif, on its own line: "${title}"'));
  assert.ok(src.includes('the showtime, typeset smaller beneath the title in the same serif'));
  assert.ok(src.includes('"${showtime}"'));
});

test("F：随机座位号注入 prompt（第 4 行）", () => {
  assert.ok(src.includes('Line 4 — the seat number'));
  assert.ok(src.includes('"${seat}"'));
  assert.ok(src.includes('EXACTLY FOUR lines'));
  // 旧约束「EXACTLY THREE lines」必须已被移除（否则三行改四行未落地）
  assert.ok(!src.includes("EXACTLY THREE lines"));
  // 座位号由 worker 随机生成，不得固定文案
  assert.ok(src.includes("generateSeat"));
});

test("F：底部随机条形码约束", () => {
  assert.ok(src.includes("barcode"));
  assert.ok(src.includes("decodes to no readable characters"));
  assert.ok(src.includes("random-width"));
});

test("G：三行主文字保持（ELSEWHERE CINEMA 大写冒号内）", () => {
  assert.ok(src.includes('"ELSEWHERE CINEMA"'));
  assert.ok(src.includes("small and letter-spaced uppercase small-caps, the fixed cinema name"));
  assert.ok(src.includes("EXACTLY FOUR lines"));
  // 旧约束「EXACTLY TWO lines」必须已被移除
  assert.ok(!src.includes("EXACTLY TWO lines"));
});

test("B：文字区干净、不重叠约束（prompt 层）", () => {
  assert.ok(src.includes("clean, unobstructed"));
  assert.ok(src.includes("never overlapping"));
});

test("C：日期时间对齐约束（prompt 层）", () => {
  assert.ok(src.includes("sharing the title's left (or center) alignment axis"));
  assert.ok(src.includes("share one alignment axis"));
});

test("A：可辨识海报约束（silhouette 保真）", () => {
  assert.ok(src.includes("ICONIC BUT RECOGNIZABLE"));
  assert.ok(src.includes("silhouette"));
  assert.ok(src.includes("instantly recognizable"));
  assert.ok(src.includes("Flat solid fills, no gradients"));
});

test("衬线排版写入 prompt（editorial serif / Didone/Garamond）", () => {
  assert.ok(src.includes("Didone/Garamond serif"));
  assert.ok(src.includes("elegant editorial hierarchy"));
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

test("禁止页面标签词（no ADMIT ONE / no SEAT / no Film title）", () => {
  assert.ok(src.includes("no 'ADMIT ONE'"));
  assert.ok(src.includes("no 'SEAT'"));
  // 座位号现在是合法第 4 行，旧「no seat numbers」约束必须移除
  assert.ok(!src.includes("no seat numbers"));
});

test("生图关闭 prompt 扩写与去水印（文字精确优先）", () => {
  assert.ok(src.includes("prompt_extend: false"));
  assert.ok(src.includes("watermark: false"));
});

console.log("ticket-prompt snapshot tests passed");