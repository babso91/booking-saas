"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import styles from "./eclipse-scene.module.css";

// Higani's own universe « Éclipse » (brand direction V2.2): a black hole
// set on the horizon of a mirror. Its ring of light, thick and intense,
// glows on every side; its lower half is its reflection, smeared and
// rippled by the floor, so that together they close the circle. Two
// flares where the ring meets the horizon; a grey mist; a single scarlet
// fracture on the floor; and a rain of petals. It is Higani's, for the
// app: never a professional's page.
//
// Built as stacked layers on a 1600 × 900 stage that covers its box (CSS
// only, framed again on a portrait screen). What moves is its own layer,
// moved by the GPU (transform, opacity), never repainted; the heavy
// painting (blur, ripples) is done once. Everything is drawn from a fixed
// seed, so the server and the browser draw the same scene. With reduced
// motion, a few petals rest and nothing moves.

const H = 560; // the horizon, where the ring is centred
const CX = 1120;
const R = 350; // the ring
const CRACK =
  "M560 690 L700 712 L850 740 L1000 766 L1180 800 L1390 842 L1600 880";

/** A small deterministic generator (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (value: number, digits = 1) => Number(value.toFixed(digits));

type Dot = { x: number; y: number; r: number; o: number };
type Line = { x: number; y: number; w: number; h: number; o: number };
type Arc = { r: number; w: number; o: number; dash: string; offset: number };
type Drop = {
  left: number;
  size: number;
  tier: 0 | 1 | 2;
  style: CSSProperties;
};

function draw(seed: number) {
  const rnd = seeded(seed);
  const stars: Dot[] = [];
  const twinkle: Dot[] = [];
  for (let i = 0; i < 80; i++) {
    const x = rnd() * 1600;
    const y = rnd() * (H - 60);
    const dot = {
      x: f(x, 0),
      y: f(y, 0),
      r: f(rnd() * 1.1 + 0.3, 2),
      o: f(rnd() * 0.35 + 0.06, 2),
    };
    if (Math.hypot(x - CX, y - H) < R + 60) continue;
    (i % 4 ? stars : twinkle).push(dot);
  }
  // Light streaks on the floor: denser and brighter under the ring.
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const streaks: Line[] = [];
  for (let i = 0; i < 170; i++) {
    const under = i < 80;
    const x = under ? CX + gauss() * R * 1.5 : rnd() * 1600;
    const y = H + 3 + Math.pow(rnd(), 1.4) * (900 - H);
    const w = 20 + rnd() * (under ? 160 : 90);
    const o = under
      ? (0.08 + rnd() * 0.28) *
        (1 - Math.min(1, Math.abs(x - CX) / (R * 1.6)) * 0.6)
      : rnd() * 0.14;
    streaks.push({
      x: f(x - w / 2, 0),
      y: f(y),
      w: f(w, 0),
      h: f(rnd() * 1.4 + 0.5),
      o: f(o, 2),
    });
  }
  // Fine arcs around the ring, turning slowly.
  const arcs: Arc[] = [];
  for (let i = 0; i < 9; i++) {
    const r = R + 14 + rnd() * 70;
    const length = 2 * Math.PI * r;
    const seen = 0.08 + rnd() * 0.22;
    arcs.push({
      r: f(r, 0),
      w: f(0.6 + rnd() * 1.6),
      o: f(0.12 + rnd() * 0.3, 2),
      dash: `${f(length * seen, 0)} ${f(length * (1 - seen), 0)}`,
      offset: f(rnd() * length, 0),
    });
  }
  // The rain: far, middle and near petals.
  const tiers = [
    [18, 30, 14, 20, 0.6, 0.8, 26],
    [40, 66, 9, 13, 0, 0.96, 50],
    [90, 130, 6.5, 8.5, 3.2, 0.92, 80],
  ] as const;
  const rain: Drop[] = [];
  for (let i = 0; i < 44; i++) {
    const t = rnd();
    const tier = t < 0.45 ? 0 : t < 0.87 ? 1 : 2;
    const [s0, s1, d0, d1, blur, opacity, sway] = tiers[tier];
    const size = s0 + rnd() * (s1 - s0);
    const duration = d0 + rnd() * (d1 - d0);
    rain.push({
      left: f(rnd() * 112 - 6),
      size: f(size, 0),
      tier,
      style: {
        opacity,
        "--blur": `${blur}px`,
        "--dur": `${f(duration)}s`,
        "--delay": `${f(-rnd() * duration)}s`,
        "--wind": `${f(-40 - rnd() * 120, 0)}px`,
        "--sway": `${f(sway * (0.6 + rnd() * 0.6), 0)}px`,
        "--swayd": `${f(2.6 + rnd() * 2.4)}s`,
        "--turn": `${f(5 + rnd() * 8)}s`,
        "--dir": rnd() < 0.5 ? "normal" : "reverse",
      } as CSSProperties,
    });
  }
  return { stars, twinkle, streaks, arcs, rain };
}

/** Petals at rest, where motion is reduced: [x, y, scale, angle, blur]. */
const RESTING = [
  [960, 300, 0.9, 10, 0],
  [1290, 200, 0.42, -34, 0],
  [760, 430, 0.3, 28, 0],
  [1420, 470, 0.34, -30, 1],
  [1180, 640, 0.36, 22, 0],
  [60, 150, 0.8, 34, 3],
  [1500, 790, 1.1, -12, 3],
] as const;

const SCENE = draw(7);

// The petals and flowers, cut out of the brand's own paintings
// (public/brand/rain): most fall, three rest on the mirror.
const PETALS = Array.from(
  { length: 16 },
  (_, i) => `/brand/rain/petal-${String(i + 1).padStart(2, "0")}.webp`,
);
const FLOWERS = Array.from(
  { length: 8 },
  (_, i) => `/brand/rain/flower-${String(i + 1).padStart(2, "0")}.webp`,
);
/** One in four falling shapes is a whole flower. */
const shapeOf = (i: number) =>
  i % 4 === 3 ? FLOWERS[i % FLOWERS.length]! : PETALS[i % PETALS.length]!;
/** Flowers resting on the water: [x, y, width] on the stage. */
const FLOATING = [
  [700, 618, 150],
  [1400, 668, 120],
  [1000, 800, 200],
] as const;

function Layer({
  name,
  depth,
  children,
  defs,
}: {
  name: string;
  depth: number;
  children: ReactNode;
  defs?: ReactNode;
}) {
  return (
    <div className={`${styles.layer} ${styles[name] ?? ""}`} data-depth={depth}>
      <svg viewBox="0 0 1600 900" preserveAspectRatio="none">
        {defs ? <defs>{defs}</defs> : null}
        {children}
      </svg>
    </div>
  );
}

const blur = (id: string, deviation: number | string, pad = 30) => (
  <filter
    id={id}
    x={`-${pad}%`}
    y={`-${pad}%`}
    width={`${100 + 2 * pad}%`}
    height={`${100 + 2 * pad}%`}
  >
    <feGaussianBlur stdDeviation={deviation} />
  </filter>
);

/** The ring of light: its haze, its glow and its bright core. */
function Ring({ prefix }: { prefix: string }) {
  return (
    <>
      <circle
        cx={CX}
        cy={H}
        r={R + 8}
        fill="none"
        stroke="#fff"
        strokeWidth="150"
        opacity=".34"
        filter={`url(#${prefix}-haze)`}
      />
      <circle
        cx={CX}
        cy={H}
        r={R + 6}
        fill="none"
        stroke="#fff"
        strokeWidth="54"
        opacity=".6"
        filter={`url(#${prefix}-glow)`}
      />
      <circle cx={CX} cy={H} r={R} fill="url(#eclipse-disc)" />
      <circle
        cx={CX}
        cy={H}
        r={R + 4}
        fill="none"
        stroke="#fff"
        strokeWidth="22"
        filter={`url(#${prefix}-soft)`}
      />
      <circle
        cx={CX}
        cy={H}
        r={R + 3}
        fill="none"
        stroke="#fff"
        strokeWidth="9"
      />
    </>
  );
}

const ringFilters = (prefix: string) => (
  <>
    {blur(`${prefix}-haze`, 60, 50)}
    {blur(`${prefix}-glow`, 18, 30)}
    {blur(`${prefix}-soft`, 3, 10)}
  </>
);

export function EclipseScene({ className = "" }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  // The scene leans slightly with a fine pointer (eased), unless motion
  // is reduced. Nothing else needs the page's script.
  useEffect(() => {
    const root = host.current;
    const area = root?.parentElement;
    if (!root || !area) return;
    if (
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !matchMedia("(pointer: fine)").matches
    )
      return;
    const layers = [...root.querySelectorAll<HTMLElement>("[data-depth]")];
    let target: [number, number] = [0, 0];
    let now: [number, number] = [0, 0];
    let frame = 0;
    const tick = () => {
      now = [
        now[0] + (target[0] - now[0]) * 0.06,
        now[1] + (target[1] - now[1]) * 0.06,
      ];
      for (const layer of layers) {
        const depth = Number(layer.dataset.depth);
        layer.style.translate = `${(now[0] * depth * 26).toFixed(2)}px ${(now[1] * depth * 16).toFixed(2)}px`;
      }
      frame =
        Math.abs(target[0] - now[0]) + Math.abs(target[1] - now[1]) > 0.001
          ? requestAnimationFrame(tick)
          : 0;
    };
    const move = (event: PointerEvent) => {
      const box = root.getBoundingClientRect();
      target = [
        (event.clientX - box.left) / box.width - 0.5,
        (event.clientY - box.top) / box.height - 0.5,
      ];
      if (!frame) frame = requestAnimationFrame(tick);
    };
    area.addEventListener("pointermove", move);
    return () => {
      area.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);

  const { stars, twinkle, streaks, arcs, rain } = SCENE;
  return (
    <div
      ref={host}
      className={`${styles.host} ${className}`}
      aria-hidden="true"
    >
      <svg width="0" height="0" className={styles.defs}>
        <defs>
          {/* The hole is not flat: dark grey where the light bleeds in. */}
          <radialGradient id="eclipse-disc" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#020203" />
            <stop offset=".78" stopColor="#060608" />
            <stop offset=".93" stopColor="#18181b" />
            <stop offset="1" stopColor="#3b3b40" />
          </radialGradient>
        </defs>
      </svg>
      <div className={styles.stage}>
        <Layer
          name="sky"
          depth={0.04}
          defs={
            <>
              <linearGradient
                id="eclipse-sky"
                x1="0"
                y1="0"
                x2="0"
                y2={H}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#060608" />
                <stop offset=".7" stopColor="#101013" />
                <stop offset="1" stopColor="#26272b" />
              </linearGradient>
              {blur("eclipse-mist", 50, 40)}
              <filter
                id="eclipse-fog"
                x="-30%"
                y="-60%"
                width="160%"
                height="220%"
              >
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency=".008 .018"
                  numOctaves={4}
                  seed={7}
                  result="n"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="n"
                  scale={120}
                  xChannelSelector="R"
                  yChannelSelector="G"
                />
                <feGaussianBlur stdDeviation={14} />
              </filter>
            </>
          }
        >
          <rect width="1600" height="900" fill="url(#eclipse-sky)" />
          {stars.map((s, i) => (
            <circle
              key={i}
              cx={s.x}
              cy={s.y}
              r={s.r}
              fill="#fff"
              opacity={s.o}
            />
          ))}
          <g filter="url(#eclipse-fog)" fill="#c9ccd3">
            <ellipse cx="220" cy="150" rx="300" ry="80" opacity=".16" />
            <ellipse cx="460" cy="300" rx="260" ry="60" opacity=".1" />
            <ellipse cx="200" cy={H - 40} rx="420" ry="50" opacity=".14" />
          </g>
          <ellipse
            cx="800"
            cy={H - 6}
            rx="1000"
            ry="60"
            fill="#a7abb5"
            opacity=".16"
            filter="url(#eclipse-mist)"
          />
        </Layer>
        <Layer name="twinkle" depth={0.04}>
          {twinkle.map((s, i) => (
            <circle
              key={i}
              cx={s.x}
              cy={s.y}
              r={s.r}
              fill="#fff"
              opacity={s.o}
            />
          ))}
        </Layer>
        {/* The floor: a black mirror, streaked with light. */}
        <Layer
          name="floor"
          depth={0.3}
          defs={
            <>
              {blur("eclipse-floor-glow", 50, 40)}
              <linearGradient
                id="eclipse-floor"
                x1="0"
                y1={H}
                x2="0"
                y2="900"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#2c2d32" />
                <stop offset=".1" stopColor="#141417" />
                <stop offset="1" stopColor="#050506" />
              </linearGradient>
            </>
          }
        >
          <rect
            x="0"
            y={H}
            width="1600"
            height={900 - H}
            fill="url(#eclipse-floor)"
          />
          <ellipse
            cx={CX}
            cy={H + 40}
            rx={R * 2.2}
            ry="120"
            fill="#9ea3ae"
            opacity=".07"
            filter="url(#eclipse-floor-glow)"
          />
        </Layer>
        {/* The reflection: the ring itself, turned over under the horizon,
            softened and banded by the mirror's ripples (CSS: no filter
            region to cut its glow). */}
        <Layer
          name="reflection"
          depth={0.3}
          defs={
            <>
              {ringFilters("eclipse-mirror")}
              <clipPath id="eclipse-mirror-above">
                <rect x="0" y="-200" width="1600" height={H + 200} />
              </clipPath>
            </>
          }
        >
          <g clipPath="url(#eclipse-mirror-above)">
            <Ring prefix="eclipse-mirror" />
          </g>
        </Layer>
        <Layer name="streaks" depth={0.3}>
          {streaks.map((l, i) => (
            <rect
              key={i}
              x={l.x}
              y={l.y}
              width={l.w}
              height={l.h}
              fill="#f2f4f8"
              opacity={l.o}
            />
          ))}
        </Layer>
        {/* The ring itself, above the horizon. */}
        <Layer
          name="ring"
          depth={0.1}
          defs={
            <>
              {ringFilters("eclipse-ring")}
              <clipPath id="eclipse-above">
                <rect x="0" y="-200" width="1600" height={H + 200} />
              </clipPath>
            </>
          }
        >
          <g clipPath="url(#eclipse-above)">
            <Ring prefix="eclipse-ring" />
          </g>
        </Layer>
        <Layer
          name="swirl"
          depth={0.1}
          defs={
            <clipPath id="eclipse-swirl-above">
              <rect x="0" y="-200" width="1600" height={H + 200} />
            </clipPath>
          }
        >
          <g clipPath="url(#eclipse-swirl-above)">
            {arcs.map((a, i) => (
              <circle
                key={i}
                cx={CX}
                cy={H}
                r={a.r}
                fill="none"
                stroke="#fff"
                strokeWidth={a.w}
                opacity={a.o}
                strokeDasharray={a.dash}
                strokeDashoffset={a.offset}
              />
            ))}
          </g>
        </Layer>
        <div
          className={`${styles.layer} ${styles.sweepLayer}`}
          data-depth={0.1}
        >
          <div className={styles.sweep} />
        </div>
        {/* Where the ring meets the horizon: two flares and a white line. */}
        <Layer
          name="horizon"
          depth={0.2}
          defs={
            <>
              {blur("eclipse-line", 3, 10)}
              <linearGradient id="eclipse-line-fade" x1="0" x2="1">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset=".3" stopColor="#fff" stopOpacity=".55" />
                <stop offset=".62" stopColor="#fff" stopOpacity=".9" />
                <stop offset="1" stopColor="#fff" stopOpacity=".25" />
              </linearGradient>
            </>
          }
        >
          <rect
            x="0"
            y={H - 1.5}
            width="1600"
            height="3"
            fill="url(#eclipse-line-fade)"
            filter="url(#eclipse-line)"
          />
          <rect
            x="0"
            y={H - 0.4}
            width="1600"
            height=".8"
            fill="url(#eclipse-line-fade)"
          />
        </Layer>
        <div
          className={`${styles.layer} ${styles.flareLayer}`}
          data-depth={0.2}
        >
          <div className={`${styles.flare} ${styles.flareLeft}`} />
          <div className={`${styles.flare} ${styles.flareRight}`} />
        </div>
        {/* Fracture écarlate: one crack on the mirror, a pulse along it. */}
        <Layer name="crack" depth={0.3} defs={blur("eclipse-crack", 6, 20)}>
          <g stroke="#ff3159" fill="none" strokeLinecap="round">
            <path
              d={CRACK}
              strokeWidth="7"
              opacity=".45"
              filter="url(#eclipse-crack)"
            />
            <path d={CRACK} strokeWidth="1.6" />
            <path
              d="M850 740 L905 784 L950 850 M1180 800 L1240 860 M700 712 L640 756"
              strokeWidth="1"
              opacity=".7"
            />
          </g>
          <path
            d={CRACK}
            fill="none"
            stroke="#ffe3e8"
            strokeWidth="2.6"
            strokeLinecap="round"
            pathLength={1000}
            strokeDasharray="70 1000"
            className={styles.pulsePath}
          />
        </Layer>
        <div className={`${styles.layer} ${styles.resting}`}>
          {RESTING.map(([x, y, scale, angle, softness], i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={shapeOf(i)}
              alt=""
              className={styles.rest}
              style={
                {
                  left: `${(x / 1600) * 100}%`,
                  top: `${(y / 900) * 100}%`,
                  width: `${((225 * scale) / 1600) * 100}%`,
                  rotate: `${angle}deg`,
                  filter: softness ? `blur(${softness * 1.6}px)` : undefined,
                } as CSSProperties
              }
            />
          ))}
        </div>
        {/* Flowers resting on the mirror, rings spreading around them. */}
        <div className={`${styles.layer} ${styles.pond}`} data-depth={0.3}>
          {FLOATING.map(([x, y, width], i) => (
            <div
              key={i}
              className={styles.floating}
              style={
                {
                  left: `${(x / 1600) * 100}%`,
                  top: `${(y / 900) * 100}%`,
                  width: `${(width / 1600) * 100}%`,
                  "--bob": `${4.2 + i * 0.9}s`,
                } as CSSProperties
              }
            >
              <span className={styles.ring1} />
              <span className={styles.ring2} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/rain/water-01.webp" alt="" />
            </div>
          ))}
        </div>
      </div>
      <div className={styles.rain} data-depth={1} data-fracture-skip="">
        {rain.map((drop, i) => (
          <div
            key={i}
            className={`${styles.drop} ${styles[`tier${drop.tier}`]}`}
            style={{
              left: `${drop.left}%`,
              width: drop.size,
              height: drop.size,
              ...drop.style,
            }}
          >
            <div className={styles.fall}>
              <div className={styles.sway}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shapeOf(i)}
                  alt=""
                  className={styles.turn}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
