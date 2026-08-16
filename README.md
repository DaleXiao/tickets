# tickets — 电影票根生成器

输入片名 + 场次时间，AI 生成一张含抽象电影场景插画的纪念票根图。

- 上线域名：`tickets.openclawd.co`（Cindy 负责 DNS / 部署配置）
- 前端：Vite + React，复古电影票根设计（impeccable.style，西文 editorial serif + UI 中文 sans + 禁 emoji）
- Worker：CF Worker，模型调用全走 `api-llm.openclawd.co` gateway

## 架构

```
tickets/
├── worker/          # CF Worker（异步队列 + SSE 流式）
│   ├── src/index.ts
│   └── wrangler.toml
└── src/             # 前端（Vite + React）
    ├── App.tsx
    └── index.css    # 唯一样式入口（无 Tailwind）
```

### 数据流

1. 前端 POST `/api/generate`（`{ title, showtime }`）
2. Worker 入 Durable Object 队列，返回 `taskId`
3. Worker 按队列顺序：
   - **prompt 改写** → `x-llm-usecase: tickets-prompt`，模型 `qwen3.8-max`（chat completions，temperature 0.8，结构化输出）
   - **生图** → `x-llm-usecase: tickets-image`，模型 `qwen-image-3.0-pro`（native generation，`prompt_extend=false`, `watermark=false`，尺寸 `1536*1024`）
4. 前端 SSE `/api/generate/stream?taskId=` 收结果；`/api/task/:id` 作 poll 兜底

### 文字渲染（关键风险缓解）

片名/时间原文**由 worker 逐字注入图像 prompt**（不信任 LLM 转写），并强制约束：
字符逐字精确、无乱码、无缺笔。CJK 要求完整正确笔画。前端「重新生成」换 seed 重跑。

### 限流（MVP）

IP 级日配额（`DAILY_LIMIT=10`）+ 短时突发（60s 内 5 次）。简单 KV 计数，免费使用。不含账号/历史/画廊。

## 本地开发

```bash
# 前端
npm install && npm run dev            # vite proxy /api → localhost:8787

# worker
cd worker && npm install && wrangler dev
```

测试：`cd worker && npm test`（prompt 组装判定快照，守卫 SPEC-345 文字风险缓解）。

## 部署（Cindy）

1. `wrangler kv namespace create tickets-rate-limit`，把 id 回填 `worker/wrangler.toml`
2. `wrangler secret put LLM_SERVICE_TOKEN`（值 `SERVICE_TOKEN_TICKETS`）
3. DNS：`tickets.openclawd.co` → CF Pages（前端），`api-tickets.openclawd.co` → worker
4. gateway 侧确认 `tickets` 服务 token + `tickets-prompt` / `tickets-image` 两个 usecase 用量可查

## 验收标准（SPEC-345）

1. 输入片名+时间 → 出票根图（vision QA 抽查 3 部：1 中文 / 1 英文 / 1 高辨识度老片；文字无乱码、版面像票根）
2. gateway 侧可查 `tickets-prompt` / `tickets-image` 用量
3. 前端复古、非衬线，impeccable anti-slop 自检通过
4. 重新生成、下载 PNG 可用；超限友好报错
5. Lynx review + ledger approve 后合并