#!/usr/bin/env node
// lint-emoji.mjs — SPEC-349 (item A): no Unicode emoji in user-visible UI/copy.
//
// 扫描前端源码（src/ + index.html）与 worker 用户可见文案（worker/src），
// 命中 Unicode emoji / pictograph / VS16 / ZWJ 即失败（exit 1），防复发。
// 参考 gepa-studios backend/scripts/lint-emoji.sh 的判定口径。
//
// 用法：npm run check:emoji
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const SCAN_PATHS = ["src", "worker/src", "index.html"];
const FILE_EXTS = new Set([".html", ".ts", ".tsx", ".css", ".js", ".mjs", ".json"]);

// Unicode 属性 \p{Extended_Pictographic} 覆盖 emoji + pictograph 全谱；
// 加上 VS16（emoji 呈现选择子）与 ZWJ（emoji 序列连结符）两种成对出现的形态。
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

function* iterFiles(path) {
  const full = join(root, path);
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const name of readdirSync(full)) {
      yield* iterFiles(join(path, name));
    }
  } else if (FILE_EXTS.has(extname(full))) {
    yield full;
  }
}

const hits = [];
for (const p of SCAN_PATHS) {
  if (!statSync(join(root, p), { throwIfNoEntry: false })) continue;
  for (const f of iterFiles(p)) {
    const text = readFileSync(f, "utf8");
    // 逐行报告，便于 reviewer 定位。emoji 不会出现在 SVG path/viewBox 数据里，
    // 前端源码此处只有 JSX/TS/CSS/HTML，无需 gepa 的 SVG 跳行规则。
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      EMOJI.lastIndex = 0;
      if (EMOJI.test(line)) {
        const cps = [...line.matchAll(EMOJI)].map((m) => `U+${m[0].codePointAt(0).toString(16).toUpperCase()}`).join(" ");
        hits.push(`${relative(root, f)}:${i + 1}  [${cps}]  ${line.trim().slice(0, 100)}`);
      }
    });
  }
}

if (hits.length > 0) {
  console.error(`check:emoji FAILED — ${hits.length} match(es) (SPEC-349 item A)\n`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("\nUI 与文案一律纯文字或 inline SVG，禁止 Unicode emoji。");
  process.exit(1);
}

console.log("check:emoji OK — zero Unicode emoji in src/, worker/src/, index.html.");