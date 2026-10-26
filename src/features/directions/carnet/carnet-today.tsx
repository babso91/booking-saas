"use client";

import { Fragment, useState } from "react";

import {
  duration,
  euros,
  frTime,
  notes,
  pauses,
  stateOf,
  studio,
  takings,
  today,
  visits,
  week,
  type Payment,
  type Visit,
} from "../data";
import styles from "./carnet.module.css";

// Today, as a page of her book: the date set large, one sentence that says
// the day, the entries, and in the margin the ledger and her notes. Notes
// tied to an entry are footnoted on it (¹).

const footnoted = visits.filter((visit) => visit.note);

export function CarnetToday() {
  const [paid, setPaid] = useState<Record<string, Payment>>(() =>
    Object.fromEntries(
      visits.filter((v) => v.payment).map((v) => [v.id, v.payment!]),
    ),
  );
  const [justPaid, setJustPaid] = useState<string | null>(null);

  const card = sum(paid, "card");
  const cash = sum(paid, "cash");
  const owed = visits
    .filter(
      (v) => stateOf(v) !== "later" && stateOf(v) !== "next" && !paid[v.id],
    )
    .reduce((total, v) => total + v.priceCents, 0);

  const rows = [
    ...visits.map((visit) => ({
      kind: "visit" as const,
      start: visit.start,
      visit,
    })),
    ...pauses.map((pause) => ({
      kind: "pause" as const,
      start: pause.start,
      pause,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));

  return (
    <div className={styles.spread}>
      <div>
        <h1 className={styles.dateline}>
          <span className={styles.weekday}>{capitalize(today.weekday)}</span>
          <span className={styles.date}>
            {today.day} {today.month}
            <span className={styles.mono}>{today.year}</span>
          </span>
        </h1>
        <p className={styles.lede}>
          Six rendez-vous, dont <em>deux premières fois</em>. Camille en est à
          sa neuvième visite&nbsp;: la prochaine lui sera offerte. Tu finis à
          18&nbsp;h&nbsp;30.
        </p>

        <section className={styles.section} aria-labelledby="ordre">
          <div className={styles.sectionHead}>
            <h2 id="ordre" className={styles.label}>
              Ordre du jour
            </h2>
            <a href="/apercu/directions/carnet/agenda">Voir la semaine</a>
          </div>
          <ol className={styles.entries}>
            {rows.map((row) =>
              row.kind === "pause" ? (
                <li key={row.pause.id} className={styles.pause}>
                  <span className={styles.time}>{row.pause.start}</span>
                  <span>
                    {row.pause.label}, jusqu’à {frTime(row.pause.end)}
                  </span>
                </li>
              ) : (
                <Fragment key={row.visit.id}>
                  <Entry
                    visit={row.visit}
                    payment={paid[row.visit.id]}
                    fresh={justPaid === row.visit.id}
                    onPay={(payment) => {
                      setPaid({ ...paid, [row.visit.id]: payment });
                      setJustPaid(row.visit.id);
                    }}
                  />
                </Fragment>
              ),
            )}
          </ol>
        </section>
      </div>

      <aside className={styles.margin} aria-label="En marge">
        <section aria-labelledby="caisse">
          <h2 id="caisse" className={styles.label}>
            Caisse du jour
          </h2>
          <table className={styles.ledger}>
            <tbody>
              <tr>
                <td>Carte</td>
                <td>{euros(card)}</td>
              </tr>
              <tr>
                <td>Espèces</td>
                <td>{euros(cash)}</td>
              </tr>
              <tr className={styles.owed}>
                <td>Reste à encaisser</td>
                <td>{euros(owed)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>Encaissé</td>
                <td>{euros(card + cash)}</td>
              </tr>
            </tfoot>
          </table>
          <p className={styles.ledgerFoot}>
            Semaine {euros(takings.week)} · octobre {euros(takings.month)}
          </p>
        </section>

        <section aria-labelledby="notes">
          <h2 id="notes" className={styles.label}>
            Notes
          </h2>
          <ol className={styles.notes}>
            {footnoted.map((visit, index) => (
              <li key={visit.id}>
                <span>{index + 1}</span>
                <span>
                  <i>{visit.client.split(" ")[0]}</i> — {visit.note}.
                </span>
              </li>
            ))}
            {notes.map((note, index) => (
              <li key={note.id}>
                <span>{footnoted.length + index + 1}</span>
                <span>{note.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="semaine">
          <h2 id="semaine" className={styles.label}>
            Ta semaine
          </h2>
          <div className={styles.weekRow}>
            {week.map((day) => (
              <div
                key={day.date}
                className={styles.weekDay}
                data-today={day.today ? "" : undefined}
              >
                <span className={styles.vial} aria-hidden="true">
                  <i style={{ height: `${(day.booked / day.open) * 100}%` }} />
                </span>
                <b>{day.date}</b>
                <span>{day.day}</span>
                <span className="sr-only">
                  , rempli à {Math.round((day.booked / day.open) * 100)} %
                </span>
              </div>
            ))}
          </div>
        </section>
        <p
          className={styles.label}
          style={{ textTransform: "none", letterSpacing: "0.02em" }}
        >
          {studio.trade} · {studio.city}
        </p>
      </aside>
    </div>
  );
}

function Entry({
  visit,
  payment,
  fresh,
  onPay,
}: {
  visit: Visit;
  payment?: Payment;
  fresh: boolean;
  onPay: (payment: Payment) => void;
}) {
  const state = stateOf(visit);
  const [choosing, setChoosing] = useState(false);
  const note = footnoted.findIndex((v) => v.id === visit.id);
  const settled = state === "done" || state === "now";

  return (
    <>
      <li
        className={[
          styles.entry,
          state === "done" ? styles.done : "",
          state === "now" ? styles.now : "",
        ].join(" ")}
      >
        <span className={styles.time}>{visit.start}</span>
        <span>
          <span className={styles.who}>
            {visit.client}
            {note >= 0 ? <span className={styles.sup}>{note + 1}</span> : null}
          </span>
          <span className={styles.what}>
            {visit.service} ·{" "}
            <span className={styles.mono}>
              {duration(visit.start, visit.end)}
            </span>
            {visit.firstVisit ? (
              <>
                {" "}
                · <span className={styles.tag}>première fois</span>
              </>
            ) : null}
            {state === "now" ? (
              <>
                {" "}
                ·{" "}
                <span className={styles.tag}>
                  en cours, fin à {frTime(visit.end)}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <span className={styles.entryAside}>
          <span className={styles.price}>{euros(visit.priceCents)}</span>
          {payment ? (
            <span
              className={[styles.stamp, fresh ? styles.stamped : ""].join(" ")}
            >
              <b>Réglé</b>
              {payment.method === "card" ? "Carte" : "Espèces"}
            </span>
          ) : settled ? (
            choosing ? (
              <span
                className={styles.methods}
                role="group"
                aria-label={`Encaisser ${visit.client}`}
              >
                <button
                  type="button"
                  className={styles.method}
                  onClick={() =>
                    onPay({ method: "card", amountCents: visit.priceCents })
                  }
                >
                  Carte
                </button>
                <button
                  type="button"
                  className={styles.method}
                  onClick={() =>
                    onPay({ method: "cash", amountCents: visit.priceCents })
                  }
                >
                  Espèces
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={styles.stampButton}
                onClick={() => setChoosing(true)}
              >
                Encaisser
              </button>
            )
          ) : null}
        </span>
      </li>
      {state === "now" ? (
        <li
          className={styles.nowLine}
          aria-label={`Il est ${frTime(today.now)}`}
        >
          <span>{today.now}</span>
          <span />
        </li>
      ) : null}
    </>
  );
}

function sum(paid: Record<string, Payment>, method: Payment["method"]) {
  return Object.values(paid)
    .filter((p) => p.method === method)
    .reduce((total, p) => total + p.amountCents, 0);
}

const capitalize = (value: string) => value[0]!.toUpperCase() + value.slice(1);
