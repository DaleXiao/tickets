// tickets — 电影票根生成器 worker
// SPEC-345 (T-633): 输入片名 + 场次时间，生成一张纪念票根图（片名/时间文字由模型直写）。
//
// 架构对齐 fleet 现有 worker（icon-forge / ukiyo-e）：
//   - LLM 调用全走 api-llm.openclawd.co gateway，带 x-llm-usecase 头（SPEC-285 模式）
//   - 异步队列：Durable Object + SSE 流式 + KV 任务缓存（poll 兜底）
//   - 限流：IP 级日配额 + 短时突发（MVP 边界 = 简单 KV 计数，不含 Turnstile/PoW）

export interface Env {
  RATE_LIMIT: KVNamespace;
  // SPEC-345 依赖：tickets 服务的 service token 由 Cindy/Dale 签发。
  LLM_SERVICE_TOKEN: string;
  LLM_GATEWAY_URL: string;
  ENVIRONMENT: string;
  GENERATION_QUEUE: DurableObjectNamespace;
}

// --- Types ---

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  enable_thinking?: boolean;
  // SPEC-350 (T-639)：联网检索，覆盖新片/新剧/冷门片的训练知识缺口。
  // DashScope compatible-mode 原生参数；api-llm gateway 对 body 逐字节透传（仅 model 可被路由覆盖），无需 gateway 改动。
  enable_search?: boolean;
  response_format?: { type: string };
  [key: string]: unknown;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}

// qwen3.8-max 结构化输出：只产出「插画 + 版面 + 配色」三个叙事槽，
// 片名与时间原文由 worker 侧注入，不信任 LLM 转写（中文长片名乱码风险高）。
interface TicketPrompt {
  illustration: string; // 抽象插画描述
  layout: string;       // 版面指令（插画/文字字段的相对位置）
  palette: string;      // 配色 + 情绪
}

interface QueueTask {
  taskId: string;
  title: string;
  showtime: string;
  seat: string;
  ip: string;
  isTestMode: boolean;
  testRemaining?: number;
  promptModel: string;
  status: "queued" | "generating" | "complete" | "error";
  // 单张票根，保留 icons[] 数组形态以兼容 fleet SSE 事件契约（index 恒为 0）。
  icons: Array<{ url: string; index: number }>;
  remaining?: number;
  errorMessage?: string;
  createdAt: number;
  currentIconIndex?: number;
}

interface SSEWriter {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  taskId: string;
}

// --- Constants ---

// 免费使用，IP 级日配额。阈值自定（SPEC-345 MVP）。
const DAILY_LIMIT = 10;
// ?test 模式给真·端到端测试用，但要单独封顶付费输出（对齐 icon-forge/ukiyo-e）。
const TEST_DAILY_IMAGE_LIMIT = 100;
const TEST_IMAGES_PER_TASK = 1;

const PROMPT_MODEL = "qwen3.8-max"; // SPEC-345（默认值；gateway model_routes 可热切）
const IMAGE_MODEL = "qwen-image-3.0-pro"; // SPEC-345

// gateway 端点（内部透传 dashscope，上游响应 schema 不变，解析 0 修改）。
const CHAT_PATH = "/v1/chat/completions";
const IMAGE_PATH = "/v1/images/generations";

// 票根横向 3:2。1536*1024 是 SPEC-345 建议值。
const TICKET_SIZE = "1536*1024";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://tickets.openclawd.co",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_QUEUE_SIZE = 10;
// prompt 改写 + 生图各可合法耗时 ~2min，这是端到端队列预算。
const TASK_TIMEOUT_MS = 420_000;

// Origin 白名单——仅这些前端可调用写端点（读端点 quota 保持开放）。
const ALLOWED_ORIGINS = new Set<string>([
  "https://tickets.openclawd.co",
  "https://www.openclawd.co",
  "https://openclawd.co",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
]);

const BURST_WINDOW_SECONDS = 60;
const BURST_LIMIT = 5;

// poll 兜底缓存 TTL（对齐 ukiyo-e）。
const TASK_CACHE_TTL_SECONDS = 300;

function taskCacheKey(taskId: string): string {
  return `task:${taskId}`;
}

// --- Prompt 改写系统提示词 ---
//
// 核心原则：模型靠自身电影知识提炼「最有辨识度的场景/元素」，产出抽象插画
// 描述 + 版面指令 + 配色。模型【绝不】自己写片名/时间正文——那两个字符串由
// worker 用用户原文逐字注入图像 prompt（规避中文长片名乱码风险，SPEC-345 关键决策）。

export const TICKET_SYSTEM_PROMPT = `You are an elite movie-ticket art director. Given a film title (any language) and a showtime, you produce a single structured JSON interpretation that an image model renders as a commemorative, collectible cinema ticket stub.

━━━ CORE PRINCIPLE ━━━
The illustration must evoke the film through its SINGLE most iconic, recognizable element or motif — rendered as a flat, geometric, minimalist poster-grade graphic whose silhouette is instantly recognizable, never a photorealistic still and never a specific actor's likeness. Rely on your own knowledge of the film. If web-search results are available for this film, prefer the freshest public material (posters, stills, production reports) as the motif source over your training memory — an unreleased or newly released film has no reliable training data.

━━━ RULES ━━━
1. ICONIC BUT RECOGNIZABLE — render the film's single most recognizable motif as a flat, bold graphic silhouette that a viewer can name the film from at a glance (the DeLorean's gull-wing stance for "Back to the Future", the black monolith for "2001: A Space Odyssey", the red balloon for "IT", a lone shark fin above water for "Jaws"). Keep the silhouette TRUE to the real object — its signature shape and proportions must stay accurate — but rendered flat and simplified. ONE motif only.
2. SIMPLEST POSSIBLE — 1 dominant motif, at most 1 supporting shape. Flat solid fills, no gradients, no texture detail, no depth. Large negative space around the motif. Abstract in style, accurate in silhouette, instantly nameable. Crowded or busy tickets look cheap and AI-generated.
3. MINIMALIST POSTER-GRADE — think a 1950s–70s minimalist film poster: a single bold geometric shape against empty field, not a populated scene. Never enumerate a roster of scenes or objects; never stack decorative detail.
4. TWO TO THREE COLORS — a tight, disciplined palette (2–3 ink colors + the paper). The palette must match the film's emotional register (noir = near-black + one warm accent; comedy = warm cream + one bright; horror = near-black + one blood accent).
5. NEVER WRITE TEXT — your JSON describes ILLUSTRATION + LAYOUT + PALETTE only. The system injects the film title and showtime strings separately as exact text. You must NOT reproduce or transliterate them.

━━━ OUTPUT FORMAT ━━━
Output ONLY valid JSON (no markdown fences, no commentary):
{
  "illustration": "abstract graphic description: the single iconic motif, concrete flat shapes, composition (2-3 sentences max)",
  "layout": "where the illustration sits on the ticket relative to the text block (e.g. a left flat motif with the typeset title+time on the right; or a large background motif with a reserved bottom text strip)",
  "palette": "2-3 concrete colors named as hex-like descriptions + the single mood word they create"
}`;

export function assembleTicketPrompt(title: string, showtime: string, seat: string, p: TicketPrompt): string {
  return [
    "A flat, graphic, minimalist poster-grade cinema ticket stub illustration, landscape 3:2, printed on warm cream ticket stock with subtle paper-fiber texture and a clean perforated-edge silhouette (a row of small notches on one short side).",
    p.illustration,
    p.layout,
    p.palette,
    "",
    "The ticket carries EXACTLY FOUR lines of typeset text and nothing else.",
    `Line 1 — the film title, typeset large and elegant in an editorial Didone/Garamond serif, on its own line: "${title}"`,
    `Line 2 — the showtime, typeset smaller beneath the title in the same serif, sharing the title's left (or center) alignment axis and clearly subordinated: "${showtime}"`,
    `Line 3 — below both, small and letter-spaced uppercase small-caps, the fixed cinema name: "ELSEWHERE CINEMA"`,
    `Line 4 — the seat number, small and elegant, in a reserved bottom area, typeset in the same serif and letter-spaced, sharing the same alignment axis: "${seat}"`,
    "Typeset all four lines with elegant editorial hierarchy: title largest, showtime clearly smaller, cinema name smallest with wide letter-spacing, seat number small and discreet near the bottom. All text lines share one alignment axis (either all left-aligned, or all centered). The typesetting must read like a refined print ticket, not label stickers.",
    "The entire text block must sit on a clean, unobstructed, plain background area — never overlapping the illustration, the perforation notches, the barcode, or any graphic element. Reserve a dedicated plain band for the typeset lines.",
    "Do NOT render any field-label words (no 'Film title', no 'Showtime', no 'ADMIT ONE', no 'SEAT'). Do NOT invent any extra text — no price, no venue name other than ELSEWHERE CINEMA, no date sub-fields, no pseudo-Latin filler, no invented words, no signage. The ONLY readable text on the entire ticket is the four lines above.",
    "No emoji, no pictographic or emoticon symbols anywhere on the ticket.",
    "",
    "Along the bottom edge, render a single thin horizontal barcode strip with irregular, random-width vertical black bars (a real ticket stub's barcode). The barcode is decorative: it decodes to no readable characters and contains no text.",
    "Chinese / Japanese / Korean characters in the text lines must be rendered with complete, correct strokes — never simplified, broken, mirrored, or replaced with look-alike glyphs. Numbers, colons, hyphens, punctuation and the seat number must match exactly, character-for-character.",
    "No watermark, no signature, no artist credit.",
  ].join("\n");
}

// --- Helpers ---

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function getTodayKey(ip: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `limit:${ip}:${today}`;
}

async function getCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

async function checkBurst(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `burst:${ip}:${Math.floor(Date.now() / (BURST_WINDOW_SECONDS * 1000))}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= BURST_LIMIT) {
    return { allowed: false, retryAfter: BURST_WINDOW_SECONDS };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: BURST_WINDOW_SECONDS * 2 });
  } catch (e) {
    console.warn("[burst] KV put failed (quota?), allowing through:", (e as Error)?.message);
  }
  return { allowed: true };
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const count = await getCount(kv, getTodayKey(ip));
  if (count >= DAILY_LIMIT) return { allowed: false, remaining: 0 };
  return { allowed: true, remaining: DAILY_LIMIT - count };
}

async function incrementRateLimit(kv: KVNamespace, ip: string): Promise<number> {
  const key = getTodayKey(ip);
  const next = (await getCount(kv, key)) + 1;
  try {
    await kv.put(key, String(next), { expirationTtl: 86400 });
  } catch (e) {
    console.warn("[ratelimit] KV put failed (quota?), allowing through:", (e as Error)?.message);
  }
  return Math.max(0, DAILY_LIMIT - next);
}

async function getRemainingQuota(kv: KVNamespace, ip: string): Promise<number> {
  return Math.max(0, DAILY_LIMIT - (await getCount(kv, getTodayKey(ip))));
}

// --- Prompt 改写 ---

async function synthesizeTicketPrompt(
  title: string,
  showtime: string,
  seat: string,
  apiKey: string,
  gatewayUrl: string,
  model: string = PROMPT_MODEL
): Promise<string> {
  const requestBody: ChatRequest = {
    model,
    temperature: 0.8,
    // 结构化改写，非推理任务——保持关闭以避开上游 125s 边缘限制（ukiyo-e 实测）。
    enable_thinking: false,
    // SPEC-350 (T-639)：默认常开联网检索，覆盖未上映/新上映/冷门片的知识缺口。
    enable_search: true,
    messages: [
      { role: "system", content: TICKET_SYSTEM_PROMPT },
      { role: "user", content: `Film title: ${title}\nShowtime: ${showtime}` },
    ],
  };

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${gatewayUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-llm-usecase": "tickets-prompt",
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 401) {
      const errBody = await response.text();
      console.error(`[llm-gateway] unauthorized on chat: ${errBody}`);
      throw new Error(`LLM gateway unauthorized: ${errBody}`);
    }
    if (response.status === 429 && attempt < 2) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 20000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "No response";
    throw new Error(`LLM gateway chat error (${response?.status}): ${errorText}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("chat API returned empty content");

  let parsed: TicketPrompt;
  try {
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    parsed = JSON.parse(cleaned) as TicketPrompt;
  } catch {
    throw new Error(`Failed to parse ticket prompt response as JSON: ${content}`);
  }

  if (!parsed?.illustration || !parsed?.layout || !parsed?.palette) {
    throw new Error(`ticket prompt response missing fields: ${JSON.stringify(parsed)}`);
  }

  return assembleTicketPrompt(title, showtime, seat, parsed);
}

// --- 生图 ---

async function generateTicket(
  prompt: string,
  apiKey: string,
  gatewayUrl: string,
  maxRetries = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${gatewayUrl}${IMAGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-llm-usecase": "tickets-image",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        input: {
          messages: [{ role: "user", content: [{ text: prompt }] }],
        },
        parameters: {
          size: TICKET_SIZE,
          n: 1,
          seed: Math.floor(Math.random() * 2147483647),
          // SPEC-345：prompt_extend=false（票根文字要逐字精确，不能让上游扩写扰动）；
          // watermark=false（自产图，去水印）。
          prompt_extend: false,
          watermark: false,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        console.error(`[llm-gateway] unauthorized on image: ${errorText}`);
        throw new Error(`LLM gateway unauthorized: ${errorText}`);
      }
      if ((response.status === 429 || response.status === 502 || response.status === 503) && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`LLM gateway image error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
      code?: string;
      message?: string;
    };

    if (data.code) {
      if (data.code === "Throttling.RateQuota" && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Dashscope API error: ${data.code} - ${data.message}`);
    }

    const imageUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image;
    if (!imageUrl) throw new Error(`Dashscope returned no image: ${JSON.stringify(data)}`);
    return imageUrl;
  }
  throw new Error("[throttled] image generation failed after retries");
}

// --- Durable Object: GenerationQueue ---

export class GenerationQueue {
  private queue: QueueTask[] = [];
  private sseClients: Map<string, SSEWriter[]> = new Map();
  private completedTasks: Map<string, QueueTask> = new Map();
  private processing = false;
  private env: Env;
  private lastImageFinishedAt = 0;
  private static readonly IMAGE_COOLDOWN_MS = 3000;

  // DurableObjectState 保留在未来做更精细的持久化；当前队列是内存态 + KV 兜底。
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/enqueue" && request.method === "POST") return this.handleEnqueue(request);
    if (path === "/stream" && request.method === "GET") return this.handleStream(request);
    if (path === "/status" && request.method === "GET") return this.handleStatus(request);
    if (path === "/test-quota" && request.method === "GET") return this.handleTestQuota();
    return new Response("Not Found", { status: 404 });
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      taskId: string;
      title: string;
      showtime: string;
      seat: string;
      ip: string;
      isTestMode: boolean;
      promptModel: string;
    };

    this.cleanupTimedOut();

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return jsonResponse({ error: "queue_full", message: "当前使用人数较多，请 30 秒后再试", retryAfter: 30 }, 503);
    }

    let testRemaining: number | undefined;
    if (body.isTestMode) {
      const budget = await this.reserveTestImages(TEST_IMAGES_PER_TASK);
      if (!budget.allowed) {
        return jsonResponse(
          { error: "test_daily_limit", message: `测试模式每天最多生成 ${TEST_DAILY_IMAGE_LIMIT} 张图片，请明天再试`, remaining: budget.remaining, total: TEST_DAILY_IMAGE_LIMIT },
          429
        );
      }
      testRemaining = budget.remaining;
    }

    const task: QueueTask = {
      taskId: body.taskId,
      title: body.title,
      showtime: body.showtime,
      seat: body.seat,
      ip: body.ip,
      isTestMode: body.isTestMode,
      testRemaining,
      promptModel: body.promptModel || PROMPT_MODEL,
      status: "queued",
      icons: [],
      createdAt: Date.now(),
    };

    this.queue.push(task);
    if (!this.processing) this.processQueue();
    return jsonResponse({ taskId: task.taskId, position: this.queue.length }, 202);
  }

  private testBudgetKey(now = new Date()): string {
    return `test-images:${now.toISOString().slice(0, 10)}`;
  }

  private async reserveTestImages(count: number): Promise<{ allowed: boolean; remaining: number }> {
    const key = this.testBudgetKey();
    return this.state.storage.transaction(async (tx) => {
      const used = (await tx.get<number>(key)) ?? 0;
      if (used + count > TEST_DAILY_IMAGE_LIMIT) {
        return { allowed: false, remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used) };
      }
      const next = used + count;
      await tx.put(key, next);
      return { allowed: true, remaining: TEST_DAILY_IMAGE_LIMIT - next };
    });
  }

  private async handleTestQuota(): Promise<Response> {
    const used = (await this.state.storage.get<number>(this.testBudgetKey())) ?? 0;
    return jsonResponse({ remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used), total: TEST_DAILY_IMAGE_LIMIT });
  }

  private handleStream(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const sseWriter: SSEWriter = { writer, taskId };

    if (!this.sseClients.has(taskId)) this.sseClients.set(taskId, []);
    this.sseClients.get(taskId)!.push(sseWriter);

    if (task) {
      const sendCurrentState = async () => {
        try {
          if (task.status === "queued") {
            const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
            await writer.write(encoder.encode(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`));
          } else if (task.status === "generating") {
            await writer.write(encoder.encode(`event: generating\ndata: ${JSON.stringify({ index: task.currentIconIndex ?? 0, total: 1 })}\n\n`));
            for (const icon of task.icons) {
              await writer.write(encoder.encode(`event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`));
            }
          } else if (task.status === "complete") {
            for (const icon of task.icons) {
              await writer.write(encoder.encode(`event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`));
            }
            await writer.write(encoder.encode(`event: complete\ndata: ${JSON.stringify({ icons: task.icons, remaining: task.remaining })}\n\n`));
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          } else if (task.status === "error") {
            await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: task.errorMessage })}\n\n`));
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          }
        } catch {
          this.removeSseClient(taskId, sseWriter);
        }
      };
      sendCurrentState();
    } else {
      const sendNotFound = async () => {
        try {
          await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "任务不存在或已过期" })}\n\n`));
          await writer.close();
        } catch {
          // ignore
        }
      };
      sendNotFound();
      this.removeSseClient(taskId, sseWriter);
    }

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      },
    });
  }

  private handleStatus(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;
    if (!task) return jsonResponse({ error: "not_found", message: "任务不存在或已过期" }, 404);

    const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
    return jsonResponse({
      taskId: task.taskId,
      status: task.status,
      position,
      icons: task.icons,
      remaining: task.remaining,
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];
      if (task.status === "complete" || task.status === "error") {
        this.queue.shift();
        continue;
      }

      this.broadcastQueuePositions();

      try {
        task.status = "generating";
        task.currentIconIndex = 0;
        this.sendToTask(task.taskId, "generating", { index: 0, total: 1 });

        const prompt = await synthesizeTicketPrompt(
          task.title,
          task.showtime,
          task.seat,
          this.env.LLM_SERVICE_TOKEN,
          this.env.LLM_GATEWAY_URL,
          task.promptModel
        );

        await this.waitForCooldown();
        const url = await generateTicket(prompt, this.env.LLM_SERVICE_TOKEN, this.env.LLM_GATEWAY_URL);
        task.icons.push({ url, index: 0 });
        this.sendToTask(task.taskId, "icon_ready", { url, index: 0 });
        this.lastImageFinishedAt = Date.now();

        const remaining = task.isTestMode
          ? (task.testRemaining ?? 0)
          : await incrementRateLimit(this.env.RATE_LIMIT, task.ip);
        task.remaining = remaining;

        task.status = "complete";
        this.sendToTask(task.taskId, "complete", { icons: task.icons, remaining });

        // KV 兜底写入（poll fallback 读这里，DO 被驱逐后仍可查）。
        try {
          await this.env.RATE_LIMIT.put(
            taskCacheKey(task.taskId),
            JSON.stringify({ state: "complete", icons: task.icons, remaining }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (e) {
          console.warn("[cache] KV put failed:", (e as Error)?.message);
        }
      } catch (error) {
        console.error("Generation failed:", error);
        const errMsg = error instanceof Error ? error.message : String(error);
        const isThrottled = errMsg.includes("Throttling") || errMsg.includes("429") || errMsg.includes("[throttled]");
        task.status = "error";
        task.errorMessage = isThrottled ? "服务器繁忙，请稍后重试" : "生成失败，请稍后重试";
        this.sendToTask(task.taskId, "error", { code: isThrottled ? "throttled" : "failed", message: task.errorMessage });
        try {
          await this.env.RATE_LIMIT.put(
            taskCacheKey(task.taskId),
            JSON.stringify({ state: "error", error: task.errorMessage }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (e) {
          console.warn("[cache] KV put failed:", (e as Error)?.message);
        }
      }

      this.queue.shift();
      this.completedTasks.set(task.taskId, task);
      setTimeout(() => {
        this.completedTasks.delete(task.taskId);
        this.closeSseClients(task.taskId);
      }, 300000);
    }

    this.processing = false;
  }

  private async waitForCooldown(): Promise<void> {
    if (this.lastImageFinishedAt === 0) return;
    const remaining = GenerationQueue.IMAGE_COOLDOWN_MS - (Date.now() - this.lastImageFinishedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }

  private broadcastQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status === "queued") this.sendToTask(task.taskId, "queued", { position: i + 1 });
    }
  }

  private sendToTask(taskId: string, event: string, data: Record<string, unknown>): void {
    const clients = this.sseClients.get(taskId);
    if (!clients || clients.length === 0) return;
    const encoder = new TextEncoder();
    const message = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const toRemove: SSEWriter[] = [];
    for (const client of clients) {
      try {
        client.writer.write(message);
      } catch {
        toRemove.push(client);
      }
    }
    for (const c of toRemove) this.removeSseClient(taskId, c);
  }

  private closeSseClients(taskId: string): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;
    for (const c of clients) {
      try {
        c.writer.close();
      } catch {
        // already closed
      }
    }
    this.sseClients.delete(taskId);
  }

  private removeSseClient(taskId: string, client: SSEWriter): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
    if (clients.length === 0) this.sseClients.delete(taskId);
  }

  private cleanupTimedOut(): void {
    const now = Date.now();
    this.queue = this.queue.filter((task) => {
      if (now - task.createdAt > TASK_TIMEOUT_MS) {
        this.sendToTask(task.taskId, "error", { message: "任务超时，请重新提交" });
        this.closeSseClients(task.taskId);
        return false;
      }
      return true;
    });
  }
}

// --- Request handlers ---

// 随机座位号（item F）：row A–L（跳过 I，避免与 1 混淆）+ seat 1–20。
// 语言随 i18n：EN "ROW G · SEAT 12"，ZH "G 排 · 12 座"。
function generateSeat(lang: string): string {
  const ROWS = "ABCDEFGHJKL";
  const row = ROWS[Math.floor(Math.random() * ROWS.length)];
  const seat = Math.floor(Math.random() * 20) + 1;
  return lang === "en" ? `ROW ${row} · SEAT ${seat}` : `${row} 排 · ${seat} 座`;
}

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  let body: { title?: string; showtime?: string; lang?: string };
  try {
    body = (await request.json()) as { title?: string; showtime?: string; lang?: string };
  } catch {
    return jsonResponse({ error: "invalid_input", message: "请提供有效的 JSON 请求体" }, 400);
  }

  const title = body.title?.trim();
  const showtime = body.showtime?.trim();
  const seat = generateSeat(body.lang === "en" ? "en" : "zh");
  if (!title || title.length < 1 || title.length > 120) {
    return jsonResponse({ error: "invalid_input", message: "请输入电影名（1-120 字）" }, 400);
  }
  if (!showtime || showtime.length < 5 || showtime.length > 40) {
    return jsonResponse({ error: "invalid_input", message: "请选择放映时间" }, 400);
  }

  const ip = getClientIP(request);
  const url = new URL(request.url);
  const isTestMode = url.searchParams.has("test");
  const promptModel = PROMPT_MODEL;

  if (!isTestMode) {
    const burst = await checkBurst(env.RATE_LIMIT, ip);
    if (!burst.allowed) {
      return jsonResponse({ error: "rate_limited_burst", message: `请求太快，请 ${burst.retryAfter}s 后再试` }, 429);
    }
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, ip);
    if (!allowed) {
      return jsonResponse({ error: "rate_limited", message: "今天免费额度已用完，请明天再来" }, 429);
    }
  }

  const taskId = generateTaskId();
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);

  let doResponse: Response;
  try {
    doResponse = await doStub.fetch(
      new Request("https://do/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, title, showtime, seat, ip, isTestMode, promptModel }),
      })
    );
  } catch (e) {
    console.error("DO enqueue failed:", (e as Error)?.message);
    return jsonResponse({ error: "service_unavailable", message: "生成服务暂时不可用，请稍后重试" }, 503);
  }

  const responseBody = await doResponse.text();
  return new Response(responseBody, {
    status: doResponse.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleStream(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);
  const doResponse = await doStub.fetch(new Request(`https://do/stream?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }));

  return new Response(doResponse.body, {
    status: doResponse.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("test")) {
    const doId = env.GENERATION_QUEUE.idFromName("singleton");
    return env.GENERATION_QUEUE.get(doId).fetch("https://do/test-quota");
  }
  const remaining = await getRemainingQuota(env.RATE_LIMIT, getClientIP(request));
  return jsonResponse({ remaining, total: DAILY_LIMIT }, 200);
}

async function handleTaskStatus(request: Request, env: Env, taskId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return jsonResponse({ error: "invalid_taskId", message: "任务 ID 格式不正确" }, 400);
  }

  // Step 1: DO（内存队列 + 完成保留区）
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);
  type DOStatus = {
    taskId: string;
    status: "queued" | "generating" | "complete" | "error";
    position: number;
    icons: Array<{ url: string; index: number }>;
    remaining?: number;
    errorMessage?: string;
  };
  let doData: DOStatus | null = null;
  try {
    const doResponse = await doStub.fetch(new Request(`https://do/status?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }));
    if (doResponse.ok) doData = (await doResponse.json()) as DOStatus;
  } catch (e) {
    console.error("DO status fetch failed:", e);
  }

  if (doData && doData.taskId) {
    if (doData.status === "complete") return jsonResponse({ state: "complete", icons: doData.icons, remaining: doData.remaining });
    if (doData.status === "error") return jsonResponse({ state: "error", error: doData.errorMessage || "生成失败，请重试" });
    return jsonResponse({ state: doData.status });
  }

  // Step 2: KV 兜底
  try {
    const cached = await env.RATE_LIMIT.get(taskCacheKey(taskId));
    if (cached) {
      const parsed = JSON.parse(cached) as { state: "complete" | "error"; icons?: Array<{ url: string; index: number }>; remaining?: number; error?: string };
      return jsonResponse(parsed);
    }
  } catch (e) {
    console.error("KV task cache read failed:", e);
  }

  return jsonResponse({ state: "unknown", error: "任务不存在或已过期" }, 404);
}

// --- Main Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/api/generate" && request.method === "POST") {
      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: "forbidden", message: "origin not allowed" }, 403);
      }
      return handleGenerate(request, env);
    }

    if (path === "/api/generate/stream" && request.method === "GET") {
      return handleStream(request, env);
    }

    if (path === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }

    const m = path.match(/^\/api\/task\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === "GET") {
      return handleTaskStatus(request, env, m[1]);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};