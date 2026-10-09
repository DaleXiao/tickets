/**
 * TearTicket — tear-off ticket stub with paper-fibre physics (SPEC-471 / T-790).
 *
 * Vendored and modified from react-bits (https://reactbits.dev,
 * https://github.com/DavidHDev/react-bits), component
 * src/content/Micro/TearTicket/TearTicket.jsx (main branch).
 * License: MIT with Commons Clause — use/modification/distribution as part of
 * an application is permitted; reselling the component itself is not.
 * Original copyright the react-bits authors.
 *
 * Modifications in this port:
 * - TypeScript rewrite; motion/react dependency removed: the tilt spring is a
 *   small rAF integrator with the original spring constants, reduced motion is
 *   handled via matchMedia.
 * - The ticket face renders the app-generated image itself, clipped into two
 *   aligned layers (body + stub) with the original buildGeometry paths instead
 *   of generic chrome/art slots; the perforation line punches through both
 *   layers, so page background shows through the holes in either theme.
 * - Vertical-orientation/controlled/disabled modes dropped; restore
 *   interaction added (click or Enter/Space on the body piece) with an
 *   onRestore callback.
 * - Physics parameters unchanged from the original component (GRAVITY,
 *   TILT_SPRING, resistance, tearAngle, stretch, retract).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./TearTicket.css";

// --- Physics baseline (unchanged from react-bits TearTicket) ---
const TILT_SPRING = { stiffness: 220, damping: 24, mass: 0.6 };
const GRAVITY = 2400;
const RETRACT = 0.17;

// --- Interaction defaults (unchanged from react-bits TearTicket) ---
const TEAR_ANGLE = 30;
const STRETCH = 30;
const RESISTANCE = 0.45;
const ROTATE = 4;
const TILT_MAX = 9;
const TILT_REACH = 260;
const PARALLAX = 6;
const PERSPECTIVE = 1000;

// --- Design space of the generated ticket face (3:2, scaled to fit container) ---
const WIDTH = 600;
const HEIGHT = 400;
const STUB_SIZE = 114; // 19% of width; spec band is 18-20%
const RADIUS = 10;
const HOLES = 14;
const HOLE_SIZE = 9;
const NOTCH = 4;
const ROUGHNESS = 0;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const rad = (deg: number): number => (deg * Math.PI) / 180;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const noise = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const f = (n: number): string => n.toFixed(2);

type Bridge = { y0: number; y1: number; mid: number; pts: number[][]; x: number; y: number };

type Geometry = {
  cross: number;
  body: string;
  stub: string;
  bridges: Bridge[];
  ends: { x: number; y: number; v: number }[];
  bodyOutline: string;
  stubOutline: string;
};

// Ported from react-bits buildGeometry, restricted to horizontal orientation
// (vertical branches removed; path maths identical).
const buildGeometry = (
  W: number,
  H: number,
  S: number,
  R: number,
  holes: number,
  hole: number,
  notch: number,
  rough: number
): Geometry => {
  const main = W;
  const cross = H;
  const x = main - S;
  const hr = hole / 2;
  const n = Math.max(1, Math.round(holes));
  const span = cross - 2 * notch;
  const bridge = Math.max(2, (span - n * hole) / (n + 1));
  const random = noise(n * 7919 + Math.round(cross));
  const pt = (u: number, v: number): string => `${f(u)},${f(v)}`;
  const arc = (r: number, sweep: number, u: number, v: number): string =>
    `A${f(r)},${f(r)} 0 0 ${sweep} ${pt(u, v)}`;
  const bridges: Bridge[] = [];
  for (let i = 0; i <= n; i += 1) {
    const y0 = notch + i * (bridge + hole);
    const y1 = y0 + bridge;
    const steps = Math.max(2, Math.round(bridge / 2.2));
    const pts: number[][] = [];
    for (let k = 1; k < steps; k += 1) {
      pts.push([x + (random() - 0.5) * 2 * rough, y0 + (bridge * k) / steps]);
    }
    bridges.push({ y0, y1, mid: (y0 + y1) / 2, pts, x, y: (y0 + y1) / 2 });
  }
  let body = `M${pt(R, 0)}L${pt(x - notch, 0)}${arc(notch, 0, x, notch)}`;
  bridges.forEach((b, i) => {
    b.pts.forEach((p) => {
      body += `L${pt(p[0], p[1])}`;
    });
    body += `L${pt(x, b.y1)}`;
    if (i < n) body += arc(hr, 0, x, b.y1 + hole);
  });
  body += `${arc(notch, 0, x - notch, cross)}L${pt(R, cross)}${arc(R, 1, 0, cross - R)}L${pt(0, R)}${arc(R, 1, R, 0)}Z`;
  let stub = `M${pt(x + notch, 0)}L${pt(main - R, 0)}${arc(R, 1, main, R)}L${pt(main, cross - R)}${arc(R, 1, main - R, cross)}L${pt(x + notch, cross)}${arc(notch, 0, x, cross - notch)}`;
  for (let i = n; i >= 0; i -= 1) {
    const b = bridges[i];
    for (let k = b.pts.length - 1; k >= 0; k -= 1) stub += `L${pt(b.pts[k][0], b.pts[k][1])}`;
    stub += `L${pt(x, b.y0)}`;
    if (i > 0) stub += arc(hr, 0, x, b.y0 - hole);
  }
  stub += `${arc(notch, 0, x + notch, 0)}Z`;
  const ends = [
    { x, y: notch, v: notch },
    { x, y: cross - notch, v: cross - notch },
  ];
  const bodyOutline = `M${pt(x, cross - notch)}${arc(notch, 0, x - notch, cross)}L${pt(R, cross)}${arc(R, 1, 0, cross - R)}L${pt(0, R)}${arc(R, 1, R, 0)}L${pt(x - notch, 0)}${arc(notch, 0, x, notch)}`;
  const stubOutline = `M${pt(x, notch)}${arc(notch, 0, x + notch, 0)}L${pt(main - R, 0)}${arc(R, 1, main, R)}L${pt(main, cross - R)}${arc(R, 1, main - R, cross)}L${pt(x + notch, cross)}${arc(notch, 0, x, cross - notch)}`;
  return { cross, body, stub, bridges, ends, bodyOutline, stubOutline };
};

type Phase = "idle" | "held" | "free" | "drop" | "return";

type Sim = {
  raf: number;
  last: number;
  phase: Phase;
  id: number | null;
  sign: number;
  hinge: { x: number; y: number };
  hingeV: number;
  grab: { x: number; y: number };
  start: { x: number; y: number };
  point: { x: number; y: number };
  a0: number;
  theta: number;
  thetaV: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  spin: number;
  pvx: number;
  pvy: number;
  pt: number;
  fade: number;
  age: number;
  bx: number;
  bv: number;
  snapped: boolean[];
  snapAt: number[];
  span: number[];
};

type TearTicketProps = {
  image: string;
  imageAlt: string;
  stubAriaLabel?: string;
  restoreAriaLabel?: string;
  onTear?: () => void;
  onRestore?: () => void;
  className?: string;
};

export default function TearTicket({
  image,
  imageAlt,
  stubAriaLabel = "Tear off the stub",
  restoreAriaLabel = "Restore ticket",
  onTear,
  onRestore,
  className = "",
}: TearTicketProps) {
  const [reduce, setReduce] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [used, setUsed] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [instant, setInstant] = useState(false);
  const [fit, setFit] = useState(1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stubRef = useRef<HTMLDivElement | null>(null);
  const bodyImgRef = useRef<HTMLImageElement | null>(null);
  const stubImgRef = useRef<HTMLImageElement | null>(null);
  const fibres = useRef<(SVGPathElement | null)[]>([]);
  const geo = useMemo(
    () => buildGeometry(WIDTH, HEIGHT, STUB_SIZE, RADIUS, HOLES, HOLE_SIZE, NOTCH, ROUGHNESS),
    []
  );
  // Live config for the rAF loops (same pattern as the original component).
  const cfg = useRef({ reduce, onTear, onRestore });
  cfg.current = { reduce, onTear, onRestore };
  const sim = useRef<Sim>({
    raf: 0,
    last: 0,
    phase: "idle",
    id: null,
    sign: 1,
    hinge: { x: 0, y: 0 },
    hingeV: 0,
    grab: { x: 0, y: 0 },
    start: { x: 0, y: 0 },
    point: { x: 0, y: 0 },
    a0: 0,
    theta: 0,
    thetaV: 0,
    sx: 0,
    sy: 0,
    vx: 0,
    vy: 0,
    spin: 0,
    pvx: 0,
    pvy: 0,
    pt: 0,
    fade: 1,
    age: 0,
    bx: 0,
    bv: 0,
    snapped: [],
    snapAt: [],
    span: [],
  });

  // --- Tilt spring: replaces motion/react useSpring + useMotionTemplate ---
  const depth = TILT_MAX > 0 ? PARALLAX / TILT_MAX : 0;
  const tilt = useRef({ x: 0, xv: 0, xt: 0, y: 0, yv: 0, yt: 0, raf: 0, last: 0 });

  const applyTilt = useCallback(() => {
    const tl = tilt.current;
    const plane = planeRef.current;
    if (plane) {
      plane.style.transform = `perspective(${PERSPECTIVE}px) rotate(${ROTATE}deg) rotateX(${tl.x.toFixed(3)}deg) rotateY(${tl.y.toFixed(3)}deg)`;
    }
    const shift = `translate(${(-tl.y * depth).toFixed(3)}px, ${(tl.x * depth).toFixed(3)}px)`;
    if (bodyImgRef.current) bodyImgRef.current.style.transform = shift;
    if (stubImgRef.current) stubImgRef.current.style.transform = shift;
  }, [depth]);

  const tiltStep = useCallback(
    (now: number) => {
      const tl = tilt.current;
      const dt = clamp((now - tl.last) / 1000, 0.001, 0.034);
      tl.last = now;
      const { stiffness, damping, mass } = TILT_SPRING;
      tl.xv += ((-stiffness * (tl.x - tl.xt) - damping * tl.xv) / mass) * dt;
      tl.x += tl.xv * dt;
      tl.yv += ((-stiffness * (tl.y - tl.yt) - damping * tl.yv) / mass) * dt;
      tl.y += tl.yv * dt;
      applyTilt();
      const settled =
        Math.abs(tl.x - tl.xt) < 0.01 &&
        Math.abs(tl.xv) < 0.05 &&
        Math.abs(tl.y - tl.yt) < 0.01 &&
        Math.abs(tl.yv) < 0.05;
      if (settled) {
        tl.x = tl.xt;
        tl.y = tl.yt;
        tl.xv = 0;
        tl.yv = 0;
        tl.raf = 0;
        applyTilt();
      } else {
        tl.raf = requestAnimationFrame(tiltStep);
      }
    },
    [applyTilt]
  );

  const setTilt = useCallback(
    (tx: number, ty: number) => {
      const tl = tilt.current;
      tl.xt = tx;
      tl.yt = ty;
      if (!tl.raf) {
        tl.last = performance.now();
        tl.raf = requestAnimationFrame(tiltStep);
      }
    },
    [tiltStep]
  );

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    // Fluid fit: the ticket always spans its container (design space scales).
    const measure = (): void => setFit(el.clientWidth / WIDTH || 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    applyTilt();
  }, [applyTilt]);

  // Reduced motion: follow OS preference changes (replaces useReducedMotion).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduce(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const paint = useCallback(
    (now: number): boolean => {
      const s = sim.current;
      const stubEl = stubRef.current;
      const bodyEl = bodyRef.current;
      if (stubEl) {
        stubEl.style.transform = `translate(${s.sx.toFixed(2)}px, ${s.sy.toFixed(2)}px) rotate(${((s.theta * s.sign * 180) / Math.PI).toFixed(3)}deg)`;
        stubEl.style.opacity = s.fade.toFixed(3);
      }
      if (bodyEl) bodyEl.style.transform = `translateX(${s.bx.toFixed(2)}px)`;
      const cos = Math.cos(s.theta * s.sign);
      const sin = Math.sin(s.theta * s.sign);
      // Horizontal orientation only: fibre offset runs across the tear line.
      const lx = 0;
      const ly = 1.6;
      let busy = false;
      geo.bridges.forEach((b, i) => {
        const dx = b.x - s.hinge.x;
        const dy = b.y - s.hinge.y;
        const tx = s.hinge.x + dx * cos - dy * sin + s.sx;
        const ty = s.hinge.y + dx * sin + dy * cos + s.sy;
        const ox = b.x + s.bx;
        const oy = b.y;
        const gx = tx - ox;
        const gy = ty - oy;
        const gap = Math.hypot(gx, gy);
        const near = fibres.current[i * 2];
        const far = fibres.current[i * 2 + 1];
        if (!near || !far) return;
        const live = s.phase !== "idle" && !cfg.current.reduce;
        if (!s.snapped[i]) {
          if (!live || gap < 0.35) {
            near.style.opacity = "0";
            far.style.opacity = "0";
            return;
          }
          const k = clamp(gap / STRETCH, 0, 1);
          const sag = gap * 0.18;
          const w = (1.7 - 1.15 * k).toFixed(2);
          const sx = gx / 2;
          const sy = sag + gy / 2;
          near.setAttribute(
            "d",
            `M${f(ox - lx)},${f(oy - ly)}Q${f(ox - lx + sx)},${f(oy - ly + sy)} ${f(tx - lx)},${f(ty - ly)}`
          );
          far.setAttribute(
            "d",
            `M${f(ox + lx)},${f(oy + ly)}Q${f(ox + lx + gx - sx)},${f(oy + ly + gy - sy)} ${f(tx + lx)},${f(ty + ly)}`
          );
          near.style.strokeWidth = w;
          far.style.strokeWidth = w;
          near.style.opacity = "1";
          far.style.opacity = "1";
          s.span[i] = gap;
          return;
        }
        const t = (now - s.snapAt[i]) / 1000 / RETRACT;
        if (!live || t >= 1 || !s.snapAt[i]) {
          near.style.opacity = "0";
          far.style.opacity = "0";
          return;
        }
        busy = true;
        const left = (1 - t) * (1 - t);
        const len = (s.span[i] || STRETCH) * 0.5 * left;
        const ux = gap > 0.01 ? gx / gap : 1;
        const uy = gap > 0.01 ? gy / gap : 0;
        near.setAttribute("d", `M${f(ox)},${f(oy)}L${f(ox + ux * len)},${f(oy + uy * len)}`);
        far.setAttribute("d", `M${f(tx)},${f(ty)}L${f(tx - ux * len)},${f(ty - uy * len)}`);
        near.style.strokeWidth = "0.9";
        far.style.strokeWidth = "0.9";
        near.style.opacity = left.toFixed(2);
        far.style.opacity = left.toFixed(2);
      });
      return busy;
    },
    [geo]
  );

  const finish = useCallback(() => {
    if (stubRef.current) stubRef.current.style.visibility = "hidden";
    setUsed(true);
    cfg.current.onTear?.();
  }, []);

  const step = useCallback(
    (now: number) => {
      const s = sim.current;
      const dt = clamp((now - s.last) / 1000, 0.001, 0.034);
      s.last = now;
      const limit = rad(TEAR_ANGLE);
      if (s.phase === "held") {
        const count = geo.bridges.length;
        let intact = 0;
        for (let i = 0; i < count; i += 1) if (!s.snapped[i]) intact += 1;
        const hold = count ? intact / count : 0;
        const follow = 0.92 * (1 - clamp(RESISTANCE, 0, 0.95) * hold);
        const a = Math.atan2(s.point.y - s.hinge.y, s.point.x - s.hinge.x);
        const want = clamp(wrap(a - s.a0) * s.sign * follow, 0, limit + 0.1);
        s.theta += (want - s.theta) * (1 - Math.exp(-dt / 0.035));
        const away = clamp((s.point.x - s.start.x || 0) * 0.05, -2, 4);
        const side = clamp((s.point.y - s.start.y || 0) * 0.05, -3, 3);
        s.sx += (away - s.sx) * (1 - Math.exp(-dt / 0.05));
        s.sy += (side - s.sy) * (1 - Math.exp(-dt / 0.05));
        const slack = Math.hypot(s.sx, s.sy);
        let left = 0;
        geo.bridges.forEach((b, i) => {
          if (s.snapped[i]) return;
          const d = Math.abs(b.mid - s.hingeV);
          if (2 * d * Math.sin(s.theta / 2) + slack > STRETCH || s.theta >= limit) {
            s.snapped[i] = true;
            s.snapAt[i] = now;
            s.bv -= 560 / geo.bridges.length;
          } else left += 1;
        });
        if (left === 0) {
          s.phase = "free";
          s.bv -= 150;
        }
      } else if (s.phase === "free") {
        const cos = Math.cos(s.theta * s.sign);
        const sin = Math.sin(s.theta * s.sign);
        const gx = s.grab.x - s.hinge.x;
        const gy = s.grab.y - s.hinge.y;
        const wx = s.point.x - s.hinge.x - (gx * cos - gy * sin);
        const wy = s.point.y - s.hinge.y - (gx * sin + gy * cos);
        s.sx += (wx - s.sx) * (1 - Math.exp(-dt / 0.045));
        s.sy += (wy - s.sy) * (1 - Math.exp(-dt / 0.045));
        const hang = limit * 0.55 + clamp(s.pvx * 0.0009 * s.sign, -0.3, 0.3);
        s.theta += (hang - s.theta) * (1 - Math.exp(-dt / 0.12));
      } else if (s.phase === "drop") {
        s.age += dt;
        s.vy += GRAVITY * dt;
        s.sx += s.vx * dt;
        s.sy += s.vy * dt;
        s.theta += s.spin * dt;
        if (s.age > 0.16) s.fade = clamp(1 - (s.age - 0.16) / 0.42, 0, 1);
        if (s.fade <= 0) {
          s.phase = "idle";
          finish();
        }
      } else if (s.phase === "return") {
        s.thetaV += (-300 * s.theta - 24 * s.thetaV) * dt;
        s.theta += s.thetaV * dt;
        s.sx += (0 - s.sx) * (1 - Math.exp(-dt / 0.07));
        s.sy += (0 - s.sy) * (1 - Math.exp(-dt / 0.07));
        if (Math.abs(s.theta) < 0.0008 && Math.abs(s.thetaV) < 0.01 && Math.hypot(s.sx, s.sy) < 0.05) {
          s.theta = 0;
          s.thetaV = 0;
          s.sx = 0;
          s.sy = 0;
          s.phase = "idle";
        }
      }
      s.bv += (-520 * s.bx - 30 * s.bv) * dt;
      s.bx += s.bv * dt;
      const busy = paint(now);
      const moving = Math.abs(s.bx) > 0.02 || Math.abs(s.bv) > 0.5;
      if (s.phase !== "idle" || moving || busy) s.raf = requestAnimationFrame(step);
      else {
        s.bx = 0;
        s.bv = 0;
        paint(now);
        s.raf = 0;
      }
    },
    [geo, paint, finish]
  );

  const run = useCallback(() => {
    const s = sim.current;
    if (s.raf) return;
    s.last = performance.now();
    s.raf = requestAnimationFrame(step);
  }, [step]);

  const reset = useCallback(() => {
    const s = sim.current;
    cancelAnimationFrame(s.raf);
    Object.assign(s, {
      raf: 0,
      phase: "idle",
      id: null,
      theta: 0,
      thetaV: 0,
      sx: 0,
      sy: 0,
      fade: 1,
      age: 0,
      bx: 0,
      bv: 0,
    });
    s.snapped = [];
    s.snapAt = [];
    s.span = [];
    if (stubRef.current) stubRef.current.style.visibility = "";
    paint(performance.now());
  }, [paint]);

  useEffect(() => {
    if (used) {
      const s = sim.current;
      if (s.phase === "idle" && stubRef.current) stubRef.current.style.visibility = "hidden";
      return;
    }
    setInstant(false);
    reset();
  }, [used, reset]);

  // Newly generated image -> back to the untouched state (belt & braces with
  // the remount-by-key done at the call site).
  useEffect(() => {
    setUsed(false);
  }, [image]);

  useEffect(() => {
    const s = sim.current;
    const tl = tilt.current;
    return () => {
      cancelAnimationFrame(s.raf);
      cancelAnimationFrame(tl.raf);
    };
  }, []);

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const stage = stageRef.current;
    const r = stage ? stage.getBoundingClientRect() : null;
    const k = r ? r.width / WIDTH || 1 : 1;
    const left = r ? r.left : 0;
    const top = r ? r.top : 0;
    return { x: (e.clientX - left) / k, y: (e.clientY - top) / k };
  };

  const tearNow = useCallback(() => {
    const s = sim.current;
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    s.phase = "idle";
    setInstant(true);
    finish();
  }, [finish]);

  const restore = useCallback(() => {
    setUsed(false);
    cfg.current.onRestore?.();
  }, []);

  const onStubDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sim.current;
    if (used || e.button !== 0 || s.id !== null || s.phase === "drop") return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture unsupported — bubbled events still drive the drag.
    }
    const p = local(e);
    s.id = e.pointerId;
    s.start = p;
    s.point = p;
    s.pt = performance.now();
    s.pvx = 0;
    s.pvy = 0;
    if (s.theta < 0.01) {
      // Grab in the top half -> hinge at the bottom end, and vice versa.
      const far = p.y < geo.cross / 2;
      const end = geo.ends[far ? 1 : 0];
      s.sign = far ? 1 : -1;
      s.hinge = { x: end.x, y: end.y };
      s.hingeV = end.v;
      if (stubRef.current) stubRef.current.style.transformOrigin = `${s.hinge.x}px ${s.hinge.y}px`;
    }
    const cos = Math.cos(-s.theta * s.sign);
    const sin = Math.sin(-s.theta * s.sign);
    const ux = p.x - s.sx - s.hinge.x;
    const uy = p.y - s.sy - s.hinge.y;
    s.grab = { x: s.hinge.x + ux * cos - uy * sin, y: s.hinge.y + ux * sin + uy * cos };
    s.a0 = Math.atan2(s.grab.y - s.hinge.y, s.grab.x - s.hinge.x) - (s.theta * s.sign) / 0.92;
    s.phase = "held";
    s.thetaV = 0;
    setTilt(0, 0);
    setGrabbing(true);
    run();
  };

  const onStubMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sim.current;
    if (s.id !== e.pointerId) return;
    const p = local(e);
    const now = performance.now();
    const dt = Math.max(0.004, (now - s.pt) / 1000);
    s.pvx += ((p.x - s.point.x) / dt - s.pvx) * 0.35;
    s.pvy += ((p.y - s.point.y) / dt - s.pvy) * 0.35;
    s.pt = now;
    s.point = p;
    // Reduced motion: no physics — a decisive drag past 28px tears instantly.
    if (cfg.current.reduce && Math.hypot(p.x - s.start.x, p.y - s.start.y) > 28) {
      s.id = null;
      setGrabbing(false);
      tearNow();
    }
  };

  const onStubUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sim.current;
    if (s.id !== e.pointerId) return;
    s.id = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setGrabbing(false);
    if (s.phase === "free") {
      const still = performance.now() - s.pt > 80;
      s.vx = still ? 0 : clamp(s.pvx, -1600, 1600);
      s.vy = still ? 0 : clamp(s.pvy, -1600, 1200);
      s.spin = clamp(s.vx * 0.004, -6, 6) + 1.2 * s.sign;
      s.age = 0;
      s.phase = "drop";
    } else if (s.phase === "held") {
      s.phase = "return";
    }
    run();
  };

  const onStubKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (used || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (!e.repeat) tearNow();
  };

  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!used) return;
    e.preventDefault();
    restore();
  };

  const onBodyKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!used || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (!e.repeat) restore();
  };

  // Hover tilt / parallax: mouse pointers only, off for reduced motion.
  useEffect(() => {
    if (reduce) return undefined;
    const move = (e: PointerEvent): void => {
      const el = rootRef.current;
      if (!el || e.pointerType === "touch" || sim.current.id !== null) return;
      const r = el.getBoundingClientRect();
      const nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 + TILT_REACH), -1, 1);
      const ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2 + TILT_REACH), -1, 1);
      setTilt(-ny * TILT_MAX, nx * TILT_MAX);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [reduce, setTilt]);

  const rootStyle = {
    "--tt-w": `${WIDTH}px`,
    "--tt-h": `${HEIGHT}px`,
    "--tt-stub": `${STUB_SIZE}px`,
    "--tt-parallax": `${PARALLAX}px`,
    "--tt-fit": fit,
    height: `${HEIGHT * fit}px`,
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`tear-ticket${className ? ` ${className}` : ""}`}
      data-used={used ? "" : undefined}
      data-shift={used ? "x" : undefined}
      data-instant={instant ? "" : undefined}
      data-grabbing={grabbing ? "" : undefined}
      style={rootStyle}
    >
      <div ref={stageRef} className="tear-ticket__stage">
        <div ref={planeRef} className="tear-ticket__plane">
          <div
            ref={bodyRef}
            className="tear-ticket__piece tear-ticket__piece--body"
            role={used ? "button" : undefined}
            tabIndex={used ? 0 : -1}
            aria-label={used ? restoreAriaLabel : undefined}
            onClick={onBodyClick}
            onKeyDown={onBodyKey}
          >
            <svg className="tear-ticket__edge" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
              <path d={geo.bodyOutline} />
            </svg>
            <div className="tear-ticket__paper" style={{ clipPath: `path('${geo.body}')` }}>
              <img
                ref={bodyImgRef}
                className="tear-ticket__img"
                src={image}
                alt={imageAlt}
                draggable={false}
                decoding="async"
              />
            </div>
          </div>
          <svg className="tear-ticket__fibres" aria-hidden="true">
            {geo.bridges.map((_b, i) => (
              <g key={i}>
                <path
                  ref={(el) => {
                    fibres.current[i * 2] = el;
                  }}
                />
                <path
                  ref={(el) => {
                    fibres.current[i * 2 + 1] = el;
                  }}
                />
              </g>
            ))}
          </svg>
          <div
            ref={stubRef}
            className="tear-ticket__piece tear-ticket__piece--stub"
            role="button"
            tabIndex={used ? -1 : 0}
            aria-label={stubAriaLabel}
            aria-hidden={used || undefined}
            onPointerDown={onStubDown}
            onPointerMove={onStubMove}
            onPointerUp={onStubUp}
            onPointerCancel={onStubUp}
            onLostPointerCapture={onStubUp}
            onKeyDown={onStubKey}
            onDragStart={(e) => e.preventDefault()}
          >
            <svg className="tear-ticket__edge" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
              <path d={geo.stubOutline} />
            </svg>
            <div
              className="tear-ticket__paper tear-ticket__paper--stub"
              style={{ clipPath: `path('${geo.stub}')` }}
            >
              <img
                ref={stubImgRef}
                className="tear-ticket__img"
                src={image}
                alt=""
                draggable={false}
                decoding="async"
              />
            </div>
          </div>
        </div>
      </div>
      <span className="tear-ticket__sr" role="status">
        {used ? "Used" : ""}
      </span>
    </div>
  );
}
