"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import styles from "./eclipse-scene.module.css";

// Higani's own universe « Éclipse lunaire » (brand direction V2.2): a huge
// black disc set on the horizon, its rim lit from the left; a liquid black
// sea with its column of silver reflections and its scarlet fractures;
// rocky mountains and lit clouds; and a rain of petals. It is Higani's,
// for the app: never a professional's page.
//
// Built as stacked layers on a 1600 × 900 stage that covers its box (CSS
// only, art-directed again on a portrait screen). What moves is its own
// layer, moved by the GPU (transform, opacity), never repainted; the heavy
// painting (clouds, blur, rock) is done once. Everything is drawn from a
// fixed seed, so the server and the browser draw the same scene. With
// reduced motion, a few petals rest and nothing moves.

const H = 654; // the horizon
const CX = 1150;
const CY = 500;
const R = 490; // the disc
const LX = 690; // the light on the horizon
const CRACK =
  "M610 742 L760 770 L905 796 L1060 820 L1230 846 L1420 874 L1600 892";

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
type Spark = {
  x: number;
  y: number;
  rx: number;
  ry: number;
  a: number;
  o: number;
};
type Drop = {
  left: number;
  size: number;
  tier: 0 | 1 | 2;
  style: CSSProperties;
};

function draw(seed: number) {
  const rnd = seeded(seed);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const stars: Dot[] = [];
  const twinkle: Dot[] = [];
  for (let i = 0; i < 90; i++) {
    const x = rnd() * 1600;
    const y = rnd() * (H - 40);
    const dot = {
      x: f(x, 0),
      y: f(y, 0),
      r: f(rnd() * 1.3 + 0.3, 2),
      o: f(rnd() * 0.45 + 0.08, 2),
    };
    if (Math.hypot(x - CX, y - CY) < R + 20) continue;
    (i % 4 ? stars : twinkle).push(dot);
  }
  const silver: Line[] = [];
  for (let i = 0; i < 170; i++) {
    const near = i < 110;
    const x = near ? LX + gauss() * 70 : rnd() * 1600;
    const y = H + 4 + Math.pow(rnd(), 1.6) * (900 - H);
    const w = (near ? 30 : 12) + rnd() * (near ? 120 : 70);
    const o = near
      ? (0.75 - Math.abs(x - LX) / 260) * (1 - (y - H) / 360)
      : rnd() * 0.18;
    const h = rnd() * 1.6 + 0.6;
    if (o > 0.03)
      silver.push({
        x: f(x - w / 2, 0),
        y: f(y),
        w: f(w, 0),
        h: f(h),
        o: f(o, 2),
      });
  }
  const scarlet: Line[] = [];
  for (const at of [70, 250, 470, 760, 1190, 1330, 1480]) {
    for (let i = 0; i < 6; i++) {
      const y = H + 3 + Math.pow(rnd(), 1.8) * 90;
      const w = 4 + rnd() * 18;
      scarlet.push({
        x: f(at + gauss() * 16 - w / 2, 0),
        y: f(y),
        w: f(w, 0),
        h: 1.4,
        o: f(0.85 - (y - H) / 160, 2),
      });
    }
  }
  const sparks: [Spark[], Spark[]] = [[], []];
  for (let i = 0; i < 46; i++) {
    (i % 2 ? sparks[1] : sparks[0]).push({
      x: f(rnd() * 1600, 0),
      y: f(80 + rnd() * (H - 100), 0),
      rx: f(rnd() * 5 + 1.5),
      ry: f(rnd() * 1.4 + 0.6),
      a: f(-30 - rnd() * 30, 0),
      o: f(rnd() * 0.7 + 0.3, 2),
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
  return { stars, twinkle, silver, scarlet, sparks, rain };
}

/** Petals at rest, where motion is reduced: [x, y, scale, angle, blur]. */
const RESTING = [
  [985, 430, 1.35, 10, 0],
  [1260, 170, 0.5, -34, 0],
  [880, 200, 0.3, 28, 0],
  [840, 560, 0.36, 22, 0],
  [1385, 300, 0.34, -30, 1],
  [1520, 470, 0.3, -34, 0],
  [60, 150, 0.8, 34, 3],
  [1480, 760, 1.1, -12, 3],
] as const;

const SCENE = draw(7);

function Leaf({ fill }: { fill: string }) {
  return (
    <>
      <path
        d="M-96 10 C-70 -22 -10 -44 62 -26 C84 -20 98 -10 108 -4 C80 14 30 34 -30 32 C-62 30 -84 22 -96 10Z"
        fill={fill}
      />
      <path
        d="M-90 10 C-40 6 30 -4 104 -4"
        stroke="#ff8ea2"
        strokeOpacity=".55"
        strokeWidth="1.4"
        fill="none"
      />
      <path
        d="M-70 -8 C-30 -34 30 -40 80 -22"
        stroke="#ffc2cd"
        strokeOpacity=".35"
        strokeWidth="2"
        fill="none"
      />
    </>
  );
}

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

const blur = (id: string, deviation: number, pad = 30) => (
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

const cloudFilter = (id: string) => (
  <filter id={id} x="-30%" y="-60%" width="160%" height="220%">
    <feTurbulence
      type="fractalNoise"
      baseFrequency=".011 .02"
      numOctaves={4}
      seed={7}
      result="n"
    />
    <feDisplacementMap
      in="SourceGraphic"
      in2="n"
      scale={90}
      xChannelSelector="R"
      yChannelSelector="G"
    />
    <feGaussianBlur stdDeviation={5} />
  </filter>
);

const rimMask = (id: string) => (
  <>
    <linearGradient
      id={`${id}-fade`}
      x1={CX - R}
      y1="0"
      x2="1600"
      y2="0"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset="0" stopColor="#fff" />
      <stop offset=".42" stopColor="#fff" stopOpacity=".9" />
      <stop offset=".72" stopColor="#fff" stopOpacity=".28" />
      <stop offset="1" stopColor="#fff" stopOpacity=".12" />
    </linearGradient>
    <mask
      id={id}
      maskUnits="userSpaceOnUse"
      x="0"
      y="-200"
      width="1600"
      height="1200"
    >
      <rect
        x="0"
        y="-200"
        width="1600"
        height="1200"
        fill={`url(#${id}-fade)`}
      />
    </mask>
  </>
);

const cloud = (x: number, y: number, rx: number, ry: number, o: number) => (
  <ellipse
    key={`${x}-${y}`}
    cx={x}
    cy={y}
    rx={rx}
    ry={ry}
    fill="#e6e9f0"
    opacity={o}
  />
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

  const { stars, twinkle, silver, scarlet, sparks, rain } = SCENE;
  return (
    <div
      ref={host}
      className={`${styles.host} ${className}`}
      aria-hidden="true"
    >
      <svg width="0" height="0" className={styles.defs}>
        <defs>
          <radialGradient id="eclipse-petal" cx="35%" cy="40%" r="75%">
            <stop offset="0" stopColor="#ff6b84" />
            <stop offset=".35" stopColor="#f01d43" />
            <stop offset=".75" stopColor="#a80a27" />
            <stop offset="1" stopColor="#4c0313" />
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
                <stop offset="0" stopColor="#050507" />
                <stop offset=".8" stopColor="#0b0b0e" />
                <stop offset="1" stopColor="#2b2c32" />
              </linearGradient>
              {blur("eclipse-haze", 48, 40)}
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
          <ellipse
            cx="820"
            cy={H - 10}
            rx="980"
            ry="70"
            fill="#9aa0ab"
            opacity=".16"
            filter="url(#eclipse-haze)"
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
        <Layer
          name="rimglow"
          depth={0.1}
          defs={
            <>
              {rimMask("eclipse-rim-a")}
              {blur("eclipse-glow-x", 48, 40)}
              {blur("eclipse-glow-l", 22)}
            </>
          }
        >
          <g mask="url(#eclipse-rim-a)">
            <circle
              cx={CX}
              cy={CY}
              r={R + 6}
              fill="none"
              stroke="#fff"
              strokeWidth="90"
              opacity=".32"
              filter="url(#eclipse-glow-x)"
            />
            <circle
              cx={CX}
              cy={CY}
              r={R + 4}
              fill="none"
              stroke="#fff"
              strokeWidth="26"
              opacity=".75"
              filter="url(#eclipse-glow-l)"
            />
          </g>
        </Layer>
        <Layer name="clouds" depth={0.18} defs={cloudFilter("eclipse-cloud-a")}>
          <g filter="url(#eclipse-cloud-a)">
            {[
              cloud(300, 300, 190, 46, 0.42),
              cloud(470, 420, 170, 40, 0.5),
              cloud(640, 520, 80, 30, 0.3),
            ]}
          </g>
        </Layer>
        <Layer
          name="world"
          depth={0.1}
          defs={
            <>
              <radialGradient id="eclipse-disc" cx="50%" cy="50%" r="50%">
                <stop offset=".9" stopColor="#000" />
                <stop offset="1" stopColor="#08080a" />
              </radialGradient>
              {rimMask("eclipse-rim-b")}
              {blur("eclipse-b2", 4)}
            </>
          }
        >
          <circle cx={CX} cy={CY} r={R} fill="url(#eclipse-disc)" />
          <g mask="url(#eclipse-rim-b)">
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="#fff"
              strokeWidth="9"
              filter="url(#eclipse-b2)"
            />
            <circle
              cx={CX}
              cy={CY}
              r={R - 1}
              fill="none"
              stroke="#fff"
              strokeWidth="3.5"
            />
          </g>
          <circle
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke="#c9ced8"
            strokeOpacity=".35"
            strokeWidth="1.2"
          />
        </Layer>
        <div
          className={`${styles.layer} ${styles.sweepLayer}`}
          data-depth={0.1}
        >
          <div className={styles.sweepMask}>
            <div className={styles.sweep} />
          </div>
        </div>
        <Layer
          name="land"
          depth={0.3}
          defs={
            <>
              {blur("eclipse-b1", 1.6)}
              {blur("eclipse-gm", 7, 20)}
              {blur("eclipse-gl", 22)}
              {cloudFilter("eclipse-cloud-b")}
              <filter id="eclipse-rock" x="0" y="0" width="100%" height="100%">
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency=".035"
                  numOctaves={3}
                  seed={10}
                  result="n"
                />
                <feColorMatrix
                  in="n"
                  type="matrix"
                  values="0 0 0 0 .55  0 0 0 0 .55  0 0 0 0 .6  0 0 0 .07 0"
                  result="t"
                />
                <feComposite
                  in="t"
                  in2="SourceGraphic"
                  operator="in"
                  result="tex"
                />
                <feMerge>
                  <feMergeNode in="SourceGraphic" />
                  <feMergeNode in="tex" />
                </feMerge>
              </filter>
              <linearGradient
                id="eclipse-sea"
                x1="0"
                y1={H}
                x2="0"
                y2="900"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#2a2b31" />
                <stop offset=".12" stopColor="#121216" />
                <stop offset="1" stopColor="#030304" />
              </linearGradient>
              <linearGradient
                id="eclipse-rock-l"
                x1="0"
                y1="300"
                x2="520"
                y2={H}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#1d1e22" />
                <stop offset=".5" stopColor="#0f0f12" />
                <stop offset="1" stopColor="#070708" />
              </linearGradient>
              <linearGradient
                id="eclipse-rock-r"
                x1="1600"
                y1="380"
                x2="1150"
                y2={H}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#1b1c20" />
                <stop offset="1" stopColor="#08080a" />
              </linearGradient>
            </>
          }
        >
          <path
            d={`M0 ${H} L0 330 L48 300 L90 344 L150 292 L196 360 L250 330 L300 420 L350 452 L392 500 L446 548 L500 600 L560 ${H}Z`}
            fill="url(#eclipse-rock-l)"
            filter="url(#eclipse-rock)"
          />
          <path
            d="M150 292 L196 360 L250 330 L300 420"
            fill="none"
            stroke="#dfe3ea"
            strokeOpacity=".22"
            strokeWidth="2"
            filter="url(#eclipse-b1)"
          />
          <path
            d={`M0 ${H} L0 520 L80 498 L150 540 L230 560 L300 600 L360 ${H}Z`}
            fill="#070709"
          />
          <path
            d={`M500 ${H} L540 628 L585 634 L626 610 L668 626 L720 ${H}Z M760 ${H} L800 642 L860 646 L900 ${H}Z`}
            fill="#101014"
          />
          <path
            d={`M1600 ${H} L1600 410 L1555 440 L1520 418 L1470 470 L1430 456 L1380 520 L1330 548 L1290 590 L1240 620 L1200 ${H}Z`}
            fill="url(#eclipse-rock-r)"
            filter="url(#eclipse-rock)"
          />
          <path
            d="M1555 440 L1520 418 L1470 470 L1430 456 L1380 520"
            fill="none"
            stroke="#dfe3ea"
            strokeOpacity=".16"
            strokeWidth="2"
            filter="url(#eclipse-b1)"
          />
          <g filter="url(#eclipse-cloud-b)">
            {[
              cloud(330, 600, 230, 30, 0.55),
              cloud(520, 625, 150, 18, 0.6),
              cloud(1320, 610, 200, 26, 0.45),
              cloud(120, 560, 140, 26, 0.3),
            ]}
          </g>
          <rect
            x="0"
            y={H}
            width="1600"
            height={900 - H}
            fill="url(#eclipse-sea)"
          />
          <ellipse
            cx={LX}
            cy={H + 110}
            rx="34"
            ry="130"
            fill="#fff"
            opacity=".28"
            filter="url(#eclipse-gl)"
          />
          <line
            x1="0"
            y1={H}
            x2="1600"
            y2={H}
            stroke="#ff3159"
            strokeWidth="5"
            opacity=".55"
            filter="url(#eclipse-gm)"
          />
          <line
            x1="0"
            y1={H}
            x2="1600"
            y2={H}
            stroke="#ffd0d8"
            strokeWidth=".8"
            opacity=".55"
          />
          <g stroke="#ff3159" fill="none" strokeLinecap="round">
            <path
              d={CRACK}
              strokeWidth="7"
              opacity=".5"
              filter="url(#eclipse-gm)"
            />
            <path d={CRACK} strokeWidth="1.8" />
            <path
              d="M905 796 L960 838 L1010 900 M1230 846 L1290 900 M760 770 L700 812"
              strokeWidth="1.1"
              opacity=".75"
            />
            <path
              d="M330 690 L420 716 L520 735"
              strokeWidth="1.2"
              opacity=".6"
            />
          </g>
        </Layer>
        <Layer
          name="shimmer"
          depth={0.3}
          defs={
            <>
              {blur("eclipse-s1", 1.6)}
              {blur("eclipse-s2", 4)}
            </>
          }
        >
          <g filter="url(#eclipse-s1)">
            {silver.map((l, i) => (
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
          </g>
          <g filter="url(#eclipse-s2)">
            {scarlet.map((l, i) => (
              <rect
                key={i}
                x={l.x}
                y={l.y}
                width={l.w}
                height={l.h}
                fill="#ff3159"
                opacity={l.o}
              />
            ))}
          </g>
        </Layer>
        <div
          className={`${styles.layer} ${styles.sourceLayer}`}
          data-depth={0.3}
        >
          <div className={styles.source} />
        </div>
        <Layer name="pulse" depth={0.3}>
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
          <path
            d={CRACK}
            fill="none"
            stroke="#ff3159"
            strokeWidth="10"
            strokeLinecap="round"
            opacity=".5"
            pathLength={1000}
            strokeDasharray="90 1000"
            className={styles.pulsePath}
          />
        </Layer>
        {sparks.map((group, n) => (
          <Layer
            key={n}
            name={n ? "sparksB" : "sparksA"}
            depth={n ? 0.7 : 0.55}
          >
            {group.map((s, i) => (
              <ellipse
                key={i}
                cx={s.x}
                cy={s.y}
                rx={s.rx}
                ry={s.ry}
                transform={`rotate(${s.a} ${s.x} ${s.y})`}
                fill="#ff3d5f"
                opacity={s.o}
              />
            ))}
          </Layer>
        ))}
        <div className={`${styles.layer} ${styles.resting}`}>
          {RESTING.map(([x, y, scale, angle, softness], i) => (
            <svg
              key={i}
              viewBox="-110 -52 225 104"
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
            >
              <Leaf fill="url(#eclipse-petal)" />
            </svg>
          ))}
        </div>
      </div>
      <div className={styles.rain} data-depth={1}>
        {rain.map((drop, i) => (
          <div
            key={i}
            className={`${styles.drop} ${styles[`tier${drop.tier}`]}`}
            style={{
              left: `${drop.left}%`,
              width: drop.size,
              height: Math.round(drop.size * 0.46),
              ...drop.style,
            }}
          >
            <div className={styles.fall}>
              <div className={styles.sway}>
                <svg viewBox="-110 -52 225 104" className={styles.turn}>
                  <Leaf fill="url(#eclipse-petal)" />
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
