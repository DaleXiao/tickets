import { useState, useEffect, useCallback, useRef } from "react";
import { useT, useTheme, useLang, toggleLang, toggleTheme } from "./i18n";

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

// --- 小图标 ---

// 太阳/放射线 spinner —— 对齐 icon-forge 同款（animate-spin 圆 + 放射线）。
function SunSpinner({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1.5M12 19.5V21M4.219 4.219l1.061 1.061M17.72 17.72l1.06 1.06M3 12h1.5M19.5 12H21M4.219 19.781l1.061-1.061M17.72 6.28l1.06-1.06" />
      <circle cx="12" cy="12" r="4.2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  );
}

// --- 顶部切换按钮 ---

function ThemeToggle() {
  const theme = useTheme();
  const t = useT();
  const label = t(theme === "dark" ? "theme.toLight" : "theme.toDark");
  return (
    <button type="button" className="knob" onClick={() => toggleTheme()} aria-label={label} title={label}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function LangToggle() {
  const t = useT();
  const lang = useLang();
  // 显示「将切换到的语言」——icon-forge 同款语义。
  const label = lang === "zh" ? "EN" : "中";
  return (
    <button type="button" className="knob knob-text" onClick={() => toggleLang()} aria-label={t("lang.toggle")} title={t("lang.toggle")}>
      {label}
    </button>
  );
}

// --- App ---

export default function App() {
  const t = useT();
  const lang = useLang();
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
      if (!(e as MessageEvent).data) return;
      let message = t("err.generateFailed");
      try {
        const parsed = JSON.parse((e as MessageEvent).data);
        if (parsed.code === "throttled") message = t("err.busy");
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
          setError(t("err.connection"));
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
          setError(t("err.generateFailed"));
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
      setError(t("err.titleRequired"));
      return;
    }
    if (!date || !time) {
      setError(t("err.timeRequired"));
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
        body: JSON.stringify({ title: trimmed, showtime, lang }),
      });

      const body: ErrorResponse & EnqueueResponse = await res.json().catch(() => ({} as ErrorResponse));

      if (res.status === 429) {
        setRateLimited(true);
        setRemaining(0);
        setError(t("err.rateLimited"));
        setPhase("error");
        setLoading(false);
        return;
      }
      if (res.status === 503) {
        const busy = body as ErrorResponse & { retryAfter?: number };
        setError(t("err.busy"));
        setPhase("error");
        setLoading(false);
        startRetryCountdown(busy.retryAfter || 30);
        return;
      }
      if (!res.ok) {
        setError(t("err.generateFailed"));
        setPhase("error");
        setLoading(false);
        return;
      }

      setQueuePosition(body.position);
      startSSE(body.taskId);
    } catch {
      setError(t("err.network"));
      setPhase("error");
      setLoading(false);
    }
  }, [title, date, time, showtime, lang, t]);

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
      <div className="grain" aria-hidden="true" />

      <header className="topbar rise">
        <a className="wordmark" href="/" onClick={(e) => e.preventDefault()}>
          {t("wordmark")}<span className="dot">.</span>
        </a>
        <div className="top-actions">
          <LangToggle />
          <ThemeToggle />
        </div>
      </header>

      <main className="container">
        <section className="hero rise rise-1">
          <span className="eyebrow">Admit One — Cinema Ticket Studio</span>
          <h1 className="headline serif">{t("hero.headline")}</h1>
          <p className="lede">{t("tagline")}</p>
        </section>

        {/* 表单 */}
        <section className="form rise rise-2" aria-label={t("sec.film")}>
          <span className="kicker">01</span>
          <div className="field">
            <label htmlFor="title" className="field-label">
              {t("field.title")} <span className="req">*</span>
            </label>
            <input
              id="title"
              className="input serif-input"
              type="text"
              value={title}
              maxLength={120}
              placeholder={t("field.title.placeholder")}
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
              <label htmlFor="date" className="field-label">
                {t("field.date")}
              </label>
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
              <label htmlFor="time" className="field-label">
                {t("field.time")}
              </label>
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
            {loading ? t("btn.generating") : t("btn.generate")}
          </button>
        </section>

        {/* 错误 */}
        {error && <p className="error rise">{error}</p>}

        {/* 生成进度 */}
        {loading && (
          <section className="stage rise">
            <p className="status">
              {phase === "queued" && queuePosition > 1 ? (
                t("status.queued", { n: queuePosition - 1 })
              ) : phase === "queued" ? (
                t("status.preparing")
              ) : (
                <>
                  <SunSpinner className="spinner" />
                  {t("status.generating")}{" "}
                  <span className="pct">{progress}%</span>
                </>
              )}
            </p>
            <div className="ticket">
              <div className="skeleton" />
            </div>
            <p className="status-soft">{t("status.dontClose")}</p>
          </section>
        )}

        {/* 结果 */}
        {!loading && icon && (
          <section className="stage rise">
            <div className="ticket">
              <img src={icon.url} alt={title} />
            </div>
            <div className="caption serif">
              <div className="caption-title">{title}</div>
              <div className="caption-meta">{showtime}</div>
              <div className="caption-venue">Elsewhere Cinema</div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => void handleGenerate()}>
                {t("btn.regenerate")}
              </button>
              <button className="btn btn-ghost" onClick={() => void handleDownload()}>
                {t("btn.download")}
              </button>
            </div>
          </section>
        )}

        {/* 重试倒计时 */}
        {retryCountdown > 0 && !loading && (
          <p className="error rise">
            {retryCountdown}{t("err.retryAfter")}
          </p>
        )}

        {/* 配额 */}
        {remaining !== null && (
          <p className="quota">
            {rateLimited ? (
              t("err.rateLimited")
            ) : (
              <>
                {t("quota.left")} <span className="num">{remaining}/{total}</span>{" "}
                {t("quota.unit")}
              </>
            )}
          </p>
        )}
      </main>

      <footer className="footer">
        <a href="https://openclawd.co" target="_blank" rel="noopener">
          {t("footer.brand")}
        </a>
      </footer>
    </div>
  );
}