import { useState, useEffect, useCallback, useRef } from "react";

// --- Types ---

interface IconResult {
  url: string;
  index: number;
}

interface QuotaResponse {
  remaining: number;
  total: number;
}

interface ErrorResponse {
  error: string;
  message: string;
}

interface EnqueueResponse {
  taskId: string;
  position: number;
}

type Phase = "idle" | "queued" | "generating" | "complete" | "error";

// --- Constants ---

// 生产走 CF worker 独立子域，本地 dev 走 vite proxy。
const API_BASE = import.meta.env.PROD ? "https://api-tickets.openclawd.co/api" : "/api";
const TEST_PARAM = new URLSearchParams(window.location.search).has("test") ? "?test" : "";

const TASK_POLL_MS = 5000;

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// --- App ---

export default function App() {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState("20:00");
  const [loading, setLoading] = useState(false);
  const [icon, setIcon] = useState<IconResult | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [total, setTotal] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [queuePosition, setQueuePosition] = useState(0);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [progress, setProgress] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);
  const sseRetriesRef = useRef(0);
  const currentTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    fetchQuota();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchQuota() {
    try {
      const res = await fetch(`${API_BASE}/quota${TEST_PARAM}`, { credentials: "include" });
      if (res.ok) {
        const data: QuotaResponse = await res.json();
        setRemaining(data.remaining);
        if (typeof data.total === "number" && data.total > 0) setTotal(data.total);
        if (data.remaining <= 0) setRateLimited(true);
      }
    } catch {
      // 配额查询静默失败
    }
  }

  function cleanup() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    retryTimerRef.current = null;
    progressTimerRef.current = null;
    pollTimerRef.current = null;
  }

  useEffect(() => cleanup, []);

  function startProgressAnimation(fromPct: number, toPct: number) {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressRef.current = fromPct;
    setProgress(Math.round(fromPct));
    progressTimerRef.current = setInterval(() => {
      const remainingPct = toPct - progressRef.current;
      const step = Math.max(remainingPct * 0.03, 0.1);
      progressRef.current = Math.min(progressRef.current + step, toPct - 0.5);
      setProgress(Math.round(progressRef.current));
    }, 250);
  }

  function startSSE(taskId: string) {
    cleanup();
    currentTaskIdRef.current = taskId;
    const es = new EventSource(`${API_BASE}/generate/stream?taskId=${encodeURIComponent(taskId)}`);
    eventSourceRef.current = es;

    es.addEventListener("queued", (e) => {
      const data = JSON.parse(e.data);
      setPhase("queued");
      setQueuePosition(data.position);
    });

    es.addEventListener("generating", () => {
      setPhase("generating");
      startProgressAnimation(Math.max(progressRef.current, 0), 95);
    });

    es.addEventListener("icon_ready", (e) => {
      const data = JSON.parse(e.data);
      setIcon({ url: data.url, index: data.index });
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      progressRef.current = 100;
      setProgress(100);
    });

    es.addEventListener("complete", (e) => {
      const data = JSON.parse(e.data);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      progressRef.current = 100;
      setProgress(100);
      if (typeof data.remaining === "number") {
        setRemaining(data.remaining);
        if (data.remaining <= 0) setRateLimited(true);
      }
      // 用最后一张图兜底（icon_ready 已推过，这里仅状态收尾）
      if (Array.isArray(data.icons) && data.icons.length > 0) {
        setIcon(data.icons[0]);
      }
      es.onerror = null;
      es.close();
      eventSourceRef.current = null;
      currentTaskIdRef.current = null;
      setTimeout(() => {
        setPhase("complete");
        setLoading(false);
      }, 600);
    });

    es.addEventListener("error", (e) => {
      // 服务端 `event: error` 是 MessageEvent；原生传输失败是 Event，交给 onerror。
      if (!(e as MessageEvent).data) return;
      let message = "生成失败，请稍后重试";
      try {
        const parsed = JSON.parse((e as MessageEvent).data);
        if (parsed.message) message = parsed.message;
      } catch {
        // ignore
      }
      setError(message);
      setPhase("error");
      setLoading(false);
      es.onerror = null;
      es.close();
      eventSourceRef.current = null;
      currentTaskIdRef.current = null;
    });

    es.onerror = () => {
      if (eventSourceRef.current !== es) return;
      es.close();
      eventSourceRef.current = null;
      if (sseRetriesRef.current < 3 && currentTaskIdRef.current) {
        sseRetriesRef.current++;
        setTimeout(() => {
          if (currentTaskIdRef.current) startSSE(currentTaskIdRef.current);
        }, 1000);
      } else {
        setPhase((prev) => {
          if (prev === "complete" || prev === "error") return prev;
          setError("连接中断，请重试");
          setLoading(false);
          return "error";
        });
      }
    };
  }

  function startPolling(taskId: string) {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(async () => {
      if (!currentTaskIdRef.current) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/task/${encodeURIComponent(taskId)}${TEST_PARAM}`);
        if (!res.ok && res.status !== 404) return;
        const data = await res.json();
        if (data.state === "complete" && Array.isArray(data.icons)) {
          if (progressTimerRef.current) clearInterval(progressTimerRef.current);
          progressRef.current = 100;
          setProgress(100);
          if (data.icons.length > 0) setIcon(data.icons[0]);
          if (typeof data.remaining === "number") {
            setRemaining(data.remaining);
            if (data.remaining <= 0) setRateLimited(true);
          }
          currentTaskIdRef.current = null;
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setTimeout(() => {
            setPhase("complete");
            setLoading(false);
          }, 300);
        } else if (data.state === "error") {
          setError(data.error || "生成失败，请重试");
          setPhase("error");
          setLoading(false);
          currentTaskIdRef.current = null;
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } catch {
        // 网络噪音，下一 tick 重试
      }
    }, TASK_POLL_MS);
  }

  useEffect(() => {
    const handleVisibility = () => {
      const taskId = currentTaskIdRef.current;
      if (!taskId) return;
      if (document.visibilityState === "visible") {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        if (eventSourceRef.current) {
          eventSourceRef.current.onerror = null;
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        sseRetriesRef.current = 0;
        startSSE(taskId);
      } else {
        startPolling(taskId);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  function startRetryCountdown(seconds: number) {
    setRetryCountdown(seconds);
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    retryTimerRef.current = setInterval(() => {
      setRetryCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
  }

  const showtime = `${date} ${time}`;

  const handleGenerate = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("请输入电影名");
      return;
    }
    if (!date || !time) {
      setError("请选择放映时间");
      return;
    }

    setLoading(true);
    setError(null);
    setIcon(null);
    setRateLimited(false);
    setPhase("queued");
    setQueuePosition(0);
    setRetryCountdown(0);
    setProgress(0);
    progressRef.current = 0;
    sseRetriesRef.current = 0;
    currentTaskIdRef.current = null;
    cleanup();

    try {
      const res = await fetch(`${API_BASE}/generate${TEST_PARAM}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed, showtime }),
      });

      const body: ErrorResponse & EnqueueResponse = await res.json().catch(() => ({} as ErrorResponse));

      if (res.status === 429) {
        setRateLimited(true);
        setRemaining(0);
        setError(body.message || "今日额度已用完");
        setPhase("error");
        setLoading(false);
        return;
      }
      if (res.status === 503) {
        const busy = body as ErrorResponse & { retryAfter?: number };
        setError(body.message || "使用人数较多，请稍后再试");
        setPhase("error");
        setLoading(false);
        startRetryCountdown(busy.retryAfter || 30);
        return;
      }
      if (!res.ok) {
        setError(body.message || "生成失败，请稍后重试");
        setPhase("error");
        setLoading(false);
        return;
      }

      setQueuePosition(body.position);
      startSSE(body.taskId);
    } catch {
      setError("网络错误，请重试");
      setPhase("error");
      setLoading(false);
    }
  }, [title, date, time, showtime]);

  async function handleDownload() {
    if (!icon) return;
    try {
      const res = await fetch(icon.url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      const safe = title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "ticket";
      a.download = `${safe}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(icon.url, "_blank");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !loading && !rateLimited) {
      e.preventDefault();
      handleGenerate();
    }
  }

  const canGenerate = title.trim().length >= 1 && !!date && !!time && !loading && !rateLimited;

  return (
    <div className="shell">
      <div className="container">
        <header className="masthead fade-in">
          <span className="eyebrow">Admit One</span>
          <h1 className="wordmark">
            票根<span className="dot">.</span>
          </h1>
          <p className="tagline">输入片名和场次，生成一张纪念票根</p>
        </header>

        {/* 表单 */}
        <section className="form fade-in">
          <div className="field">
            <label htmlFor="title">
              片名 <span className="req">*</span>
            </label>
            <input
              id="title"
              className="input"
              type="text"
              value={title}
              maxLength={120}
              placeholder="例如：银翼杀手 2049 / Parasite / 千与千寻"
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="date">日期</label>
              <input
                id="date"
                className="input"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setError(null);
                }}
                disabled={loading}
              />
            </div>
            <div className="field">
              <label htmlFor="time">时间</label>
              <input
                id="time"
                className="input"
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  setError(null);
                }}
                disabled={loading}
              />
            </div>
          </div>

          <button className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate}>
            {loading ? "生成中…" : "生成票根"}
          </button>
        </section>

        {/* 错误 */}
        {error && <p className="error fade-in">{error}</p>}

        {/* 生成进度 */}
        {loading && (
          <section className="ticket-stage fade-in">
            <p className="status">
              {phase === "queued" && queuePosition > 1
                ? `前面还有 ${queuePosition - 1} 位，请稍候`
                : phase === "queued"
                  ? "正在准备…"
                  : (
                    <>
                      正在绘制票根 <span className="pct">{progress}%</span>
                    </>
                  )}
            </p>
            <div className="ticket">
              <div className="skeleton" />
            </div>
            <p className="status">请勿关闭页面</p>
          </section>
        )}

        {/* 结果 */}
        {!loading && icon && (
          <section className="ticket-stage fade-in">
            <div className="ticket">
              <img src={icon.url} alt="生成的电影票根" />
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => void handleGenerate()}>
                重新生成
              </button>
              <button className="btn btn-ghost" onClick={() => void handleDownload()}>
                下载 PNG
              </button>
            </div>
          </section>
        )}

        {/* 重试倒计时 */}
        {retryCountdown > 0 && !loading && (
          <p className="error fade-in">{retryCountdown}s 后可重试</p>
        )}

        {/* 配额 */}
        {remaining !== null && (
          <p className="quota">
            {rateLimited
              ? "今日免费额度已用完，明天再来 🙂"
              : (
                <>
                  今日剩余 <span className="num">{remaining}/{total}</span> 张
                </>
              )}
          </p>
        )}

        <footer className="footer">
          <a href="https://openclawd.co" target="_blank" rel="noopener">
            openclawd.co
          </a>
        </footer>
      </div>
    </div>
  );
}