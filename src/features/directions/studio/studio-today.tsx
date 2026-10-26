"use client";

import { useState } from "react";

import {
  euros,
  frTime,
  minutes,
  notes,
  pauses,
  stateOf,
  takings,
  today,
  visits,
  week,
  type Payment,
} from "../data";
import styles from "./studio.module.css";

// Today as a poster: the colour field says what is happening now and what
// comes next; the day runs left to right under it; the figures close it.

const OPEN = minutes(today.dayStart);
const SPAN = minutes(today.dayEnd) - OPEN;
const pct = (time: string) => ((minutes(time) - OPEN) / SPAN) * 100;
const hours = Array.from({ length: 10 }, (_, i) => 9 + i);

export function StudioToday() {
  const [paid, setPaid] = useState<Record<string, Payment>>(() =>
    Object.fromEntries(
      visits.filter((v) => v.payment).map((v) => [v.id, v.payment!]),
    ),
  );
  const current = visits.find((v) => stateOf(v) === "now")!;
  const next = visits.find((v) => stateOf(v) === "next")!;
  const elapsed = minutes(today.now) - minutes(current.start);
  const total = minutes(current.end) - minutes(current.start);
  const card = sum(paid, "card");
  const cash = sum(paid, "cash");
  const owedVisit = visits.find(
    (v) => (stateOf(v) === "done" || stateOf(v) === "now") && !paid[v.id],
  );
  const owed = visits
    .filter(
      (v) => (stateOf(v) === "done" || stateOf(v) === "now") && !paid[v.id],
    )
    .reduce((t, v) => t + v.priceCents, 0);

  return (
    <>
      <section className={styles.now} aria-label="Maintenant">
        <p className={styles.clock}>
          {today.now.replace(":", ".")}
          <small>
            {today.weekday} {today.day} {today.month}
          </small>
        </p>
        <div className={styles.current}>
          <span className={styles.eyebrow}>En cours</span>
          <span className={styles.currentName}>{current.client}</span>
          <span className={styles.currentWhat}>{current.service}</span>
          <span
            className={styles.progress}
            role="progressbar"
            aria-label="Avancement du rendez-vous"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={elapsed}
          >
            <i style={{ width: `${(elapsed / total) * 100}%` }} />
          </span>
          <span className={`${styles.progressLegend} ${styles.num}`}>
            <span>{current.start}</span>
            <span>encore {total - elapsed} min</span>
            <span>{current.end}</span>
          </span>
        </div>
        <div className={styles.next}>
          <span className={styles.eyebrow}>Ensuite · {next.start}</span>
          <span className={styles.nextName}>{next.client}</span>
          <span>{next.service}</span>
          {next.note ? <span className={styles.flag}>{next.note}</span> : null}
        </div>
      </section>

      <section className={styles.dayBlock} aria-labelledby="journee">
        <div className={styles.dayHead}>
          <h1 id="journee" className={styles.dayTitle}>
            Ta journée <span>· 6 rdv</span>
          </h1>
          <a className={styles.link} href="/apercu/directions/studio/agenda">
            Semaine
          </a>
        </div>

        <div className={`${styles.track} ${styles.desktopOnly}`}>
          <div className={styles.ruler} aria-hidden="true">
            {hours.map((h) => (
              <span
                key={h}
                style={{ left: `${pct(`${String(h).padStart(2, "0")}:00`)}%` }}
              >
                {h}h
              </span>
            ))}
          </div>
          {pauses.map((p) => (
            <span
              key={p.id}
              className={styles.blockPause}
              style={{
                left: `${pct(p.start)}%`,
                width: `calc(${pct(p.end) - pct(p.start)}% - 4px)`,
              }}
            >
              {p.label}
            </span>
          ))}
          {visits.map((v) => (
            <article
              key={v.id}
              className={styles.block}
              data-state={stateOf(v)}
              style={{
                left: `${pct(v.start)}%`,
                width: `calc(${pct(v.end) - pct(v.start)}% - 4px)`,
              }}
            >
              <b>{v.client.split(" ")[0]}</b>
              <span>{v.service}</span>
              <span className={styles.paid}>
                {paid[v.id]
                  ? `✓ ${paid[v.id]!.method === "card" ? "Carte" : "Espèces"}`
                  : euros(v.priceCents)}
              </span>
            </article>
          ))}
          <span
            className={styles.nowPin}
            style={{ left: `${pct(today.now)}%` }}
            data-time={today.now}
            aria-hidden="true"
          />
        </div>

        <div className={styles.phoneOnly}>
          <div className={styles.barcode} aria-hidden="true">
            {visits.map((v) => (
              <i
                key={v.id}
                data-state={stateOf(v)}
                style={{
                  left: `${pct(v.start)}%`,
                  width: `calc(${pct(v.end) - pct(v.start)}% - 3px)`,
                }}
              />
            ))}
            <b style={{ left: `${pct(today.now)}%` }} />
          </div>
          <div
            className={`${styles.barcodeScale} ${styles.num}`}
            aria-hidden="true"
          >
            <span>9h</span>
            <span>12h</span>
            <span>15h</span>
            <span>19h</span>
          </div>
          <ol className={styles.rows}>
            {visits.map((v) => (
              <li key={v.id} className={styles.row} data-state={stateOf(v)}>
                <span className={`${styles.rowTime} ${styles.num}`}>
                  {v.start}
                </span>
                <span>
                  <span className={styles.rowName}>{v.client}</span>
                  <br />
                  <span className={styles.rowWhat}>{v.service}</span>
                </span>
                <span className={`${styles.price} ${styles.num}`}>
                  {euros(v.priceCents)}
                  {paid[v.id] ? (
                    <span className={styles.paidMark}>
                      ✓ {paid[v.id]!.method === "card" ? "Carte" : "Espèces"}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={styles.figures} aria-label="Chiffres">
        <div className={styles.figure}>
          <span className={styles.eyebrow}>Encaissé aujourd’hui</span>
          <span className={`${styles.figureValue} ${styles.num}`}>
            {euros(card + cash)}
          </span>
          <span className={styles.split} aria-hidden="true">
            <i style={{ flex: card }} />
            <i style={{ flex: cash }} />
          </span>
          <span className={styles.figureNote}>
            Carte {euros(card)} · Espèces {euros(cash)}
          </span>
        </div>
        <div className={styles.figure}>
          <span className={styles.eyebrow}>À encaisser</span>
          <span
            className={`${styles.figureValue} ${styles.num}`}
            data-tone="sig"
          >
            {euros(owed)}
          </span>
          {owedVisit ? (
            <button
              type="button"
              className={styles.cta}
              onClick={() =>
                setPaid({
                  ...paid,
                  [owedVisit.id]: {
                    method: "card",
                    amountCents: owedVisit.priceCents,
                  },
                })
              }
            >
              Encaisser {owedVisit.client.split(" ")[0]}
            </button>
          ) : (
            <span className={styles.figureNote}>Tout est réglé.</span>
          )}
        </div>
        <div className={styles.figure}>
          <span className={styles.eyebrow}>Cette semaine</span>
          <span className={`${styles.figureValue} ${styles.num}`}>
            {euros(takings.week)}
          </span>
          <span className={styles.figureNote}>
            octobre {euros(takings.month)}
          </span>
        </div>
        <div className={styles.figure}>
          <span className={styles.eyebrow}>Remplissage</span>
          <span className={styles.weekBars} aria-hidden="true">
            {week.map((d) => (
              <i
                key={d.date}
                data-today={d.today ? "" : undefined}
                style={{ height: `${(d.booked / d.open) * 100}%` }}
              />
            ))}
          </span>
          <span className={styles.figureNote}>
            lun. → sam. · vendredi presque complet
          </span>
        </div>
      </section>

      <ol className={styles.memo} aria-label="À ne pas oublier">
        {[
          `${frTime("15:00")} — Léa : colle sensible, yeux réactifs.`,
          ...notes.map((n) => n.text),
        ].map((text, i) => (
          <li key={text}>
            <b>{String(i + 1).padStart(2, "0")}</b>
            {text}
          </li>
        ))}
      </ol>
    </>
  );
}

function sum(paid: Record<string, Payment>, method: Payment["method"]) {
  return Object.values(paid)
    .filter((p) => p.method === method)
    .reduce((t, p) => t + p.amountCents, 0);
}
