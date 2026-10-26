"use client";

import { useRef, useState, type PointerEvent } from "react";

import {
  euros,
  minutes,
  pauses,
  stateOf,
  takings,
  today,
  visits,
  type Payment,
} from "../data";
import styles from "./ecrin.module.css";

// Today as an object: the dial in the middle (the open hours on a 300°
// ring, each visit a capsule on it, the hand at now), what comes next on
// the left, the case of the day's takings on the right, where she slides
// to settle.

const OPEN = minutes(today.dayStart);
const SPAN = minutes(today.dayEnd) - OPEN;
const SWEEP = 300;
const C = 270; // centre of a 540 × 540 dial
const R = 214;

const angle = (time: string) =>
  -SWEEP / 2 + ((minutes(time) - OPEN) / SPAN) * SWEEP;
const point = (deg: number, r = R) => {
  const rad = (deg * Math.PI) / 180;
  const round = (n: number) => Math.round(n * 100) / 100;
  return [round(C + r * Math.sin(rad)), round(C - r * Math.cos(rad))] as const;
};
function arc(from: number, to: number, r = R) {
  const [x1, y1] = point(from, r);
  const [x2, y2] = point(to, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}
const INSET = 3.4; // room for the rounded ends, in degrees

export function EcrinToday() {
  const [paid, setPaid] = useState<Record<string, Payment>>(() =>
    Object.fromEntries(
      visits.filter((v) => v.payment).map((v) => [v.id, v.payment!]),
    ),
  );
  const current = visits.find((v) => stateOf(v) === "now")!;
  const upcoming = visits.filter((v) => ["next", "later"].includes(stateOf(v)));
  const left = minutes(current.end) - minutes(today.now);
  const card = sum(paid, "card");
  const cash = sum(paid, "cash");
  const owed = visits
    .filter(
      (v) => (stateOf(v) === "done" || stateOf(v) === "now") && !paid[v.id],
    )
    .reduce((t, v) => t + v.priceCents, 0);
  const [hx1, hy1] = point(angle(today.now), 192);
  const [hx, hy] = point(angle(today.now), 246);

  return (
    <div className={styles.stage}>
      <section className={styles.tray} aria-labelledby="ensuite">
        <h2 id="ensuite" className={styles.caps}>
          Ensuite
        </h2>
        <ol className={styles.trayList}>
          {upcoming.map((v) => (
            <li
              key={v.id}
              className={`${styles.capsule} ${styles.object}`}
              data-flag={v.note ? "" : undefined}
              style={{
                minHeight: 56 + (minutes(v.end) - minutes(v.start)) * 0.22,
              }}
            >
              <span className={`${styles.capsuleTime} ${styles.num}`}>
                {v.start}
              </span>
              <span>
                <span className={styles.capsuleName}>{v.client}</span>
                <span className={styles.capsuleWhat}>{v.service}</span>
                {v.note ? <em className={styles.flagNote}>{v.note}</em> : null}
              </span>
              <span className={`${styles.capsulePrice} ${styles.num}`}>
                {euros(v.priceCents)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section
        className={styles.dialWrap}
        aria-label={`Il est ${today.now}. En cours : ${current.client}, encore ${left} minutes.`}
      >
        <svg viewBox="0 0 540 540" className={styles.dial} aria-hidden="true">
          <defs>
            <radialGradient id="face" cx="40%" cy="30%" r="80%">
              <stop offset="0%" stopColor="var(--surface)" />
              <stop offset="100%" stopColor="var(--surface-2)" />
            </radialGradient>
          </defs>
          <circle
            cx={C}
            cy={C}
            r={250}
            fill="url(#face)"
            className={styles.dialRing}
            style={{
              fill: "url(#face)",
              filter: "drop-shadow(0 18px 30px rgb(var(--shadow) / 0.18))",
            }}
          />
          <circle cx={C} cy={C} r={244} className={styles.dialRing} />
          <circle cx={C} cy={C} r={186} className={styles.dialRing} />
          {Array.from({ length: 11 }, (_, i) => {
            const deg = -SWEEP / 2 + (i / 10) * SWEEP;
            const [x1, y1] = point(deg, 236);
            const [x2, y2] = point(deg, 244);
            const [lx, ly] = point(deg, 262);
            return (
              <g key={i}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  className={styles.dialTick}
                />
                <text x={lx} y={ly} className={styles.dialHour}>
                  {9 + i}
                </text>
              </g>
            );
          })}
          {pauses.map((p) => (
            <path
              key={p.id}
              d={arc(angle(p.start) + 2, angle(p.end) - 2)}
              className={styles.arcPause}
            />
          ))}
          {visits.map((v) => (
            <path
              key={v.id}
              d={arc(angle(v.start) + INSET, angle(v.end) - INSET)}
              className={styles.arc}
              data-state={stateOf(v)}
            />
          ))}
          <line x1={hx1} y1={hy1} x2={hx} y2={hy} className={styles.hand} />
          <circle cx={hx} cy={hy} r={6} className={styles.handJewel} />
        </svg>
        <div className={styles.dialCenter}>
          <span className={styles.caps}>En cours</span>
          <span className={`${styles.bigTime} ${styles.num}`}>
            14<small>h</small>05
          </span>
          <span className={styles.who}>{current.client}</span>
          <span className={styles.left}>encore {left} minutes</span>
        </div>
      </section>

      <section className={styles.case} aria-labelledby="coffret">
        <h2 id="coffret" className={styles.caps}>
          Le coffret du jour
        </h2>
        <div className={styles.pearls}>
          <span className={`${styles.pearl} ${styles.object}`}>
            <b className={styles.num}>{euros(card)}</b>
            <span>Carte</span>
          </span>
          <span className={`${styles.pearl} ${styles.object}`}>
            <b className={styles.num}>{euros(cash)}</b>
            <span>Espèces</span>
          </span>
          <span className={`${styles.pearl} ${styles.object}`} data-owed="">
            <b className={styles.num}>{euros(owed)}</b>
            <span>À encaisser</span>
          </span>
        </div>
        <Settle
          key={paid[current.id] ? "paid" : "open"}
          name={current.client.split(" ")[0]!}
          amount={current.priceCents}
          payment={paid[current.id]}
          onSettle={(method) =>
            setPaid({
              ...paid,
              [current.id]: { method, amountCents: current.priceCents },
            })
          }
        />
        <p className={`${styles.caseFoot} ${styles.num}`}>
          <span>Semaine {euros(takings.week)}</span>
          <span>Octobre {euros(takings.month)}</span>
        </p>
      </section>
    </div>
  );
}

/** Choose how she was paid, then slide: a gesture, not a slip of the finger. */
function Settle({
  name,
  amount,
  payment,
  onSettle,
}: {
  name: string;
  amount: number;
  payment?: Payment;
  onSettle: (method: Payment["method"]) => void;
}) {
  const [method, setMethod] = useState<Payment["method"]>("card");
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const start = useRef(0);

  if (payment)
    return (
      <div className={styles.settled} role="status">
        <i aria-hidden="true">✓</i>
        {name} · {euros(payment.amountCents)} ·{" "}
        {payment.method === "card" ? "carte" : "espèces"}
      </div>
    );

  const max = () => (track.current ? track.current.clientWidth - 60 : 0);
  const onDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = event.clientX - x;
    setDragging(true);
  };
  const onMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    setX(Math.max(0, Math.min(max(), event.clientX - start.current)));
  };
  const onUp = () => {
    setDragging(false);
    if (x > max() * 0.86) onSettle(method);
    else setX(0);
  };

  return (
    <div className={`${styles.settle} ${styles.object}`}>
      <div className={styles.settleHead}>
        <b>{name}</b>
        <span className={styles.num}>{euros(amount)}</span>
      </div>
      <div
        className={styles.choices}
        role="group"
        aria-label="Moyen de paiement"
      >
        {(["card", "cash"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={styles.choice}
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
          >
            {m === "card" ? "Carte" : "Espèces"}
          </button>
        ))}
      </div>
      <div className={styles.slider} ref={track}>
        <span className={styles.sliderLabel} aria-hidden="true">
          Glisser pour encaisser
        </span>
        <button
          type="button"
          className={styles.knob}
          data-dragging={dragging ? "" : undefined}
          style={{ transform: `translateX(${x}px)` }}
          aria-label={`Encaisser ${euros(amount)} de ${name}, ${method === "card" ? "par carte" : "en espèces"}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            setDragging(false);
            setX(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSettle(method);
            }
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}

function sum(paid: Record<string, Payment>, method: Payment["method"]) {
  return Object.values(paid)
    .filter((p) => p.method === method)
    .reduce((t, p) => t + p.amountCents, 0);
}
