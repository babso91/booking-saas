"use client";

import Link from "next/link";
import { useState } from "react";

import {
  dayNumber,
  formatDuration,
  formatWeekdayLong,
  formatWeekdayShort,
  timeOf,
} from "@/features/agenda/client/dates";

import type { DayFlow } from "../agenda/day-flow";
import type { TodayModel } from "../client/today-model";
import { referencesOf } from "./carnet-entries";
import styles from "./carnet.module.css";

// The margin of a page: the register of the day, her notes by reference, her
// week as vials. The register counts visits and time, never money: none is
// known until the payment record exists.

export function Register({
  model,
  flow,
  title = "Registre du jour",
}: {
  model: TodayModel;
  flow: DayFlow;
  title?: string;
}) {
  const { counts } = model;
  return (
    <section aria-label={title}>
      <h2 className={styles.label}>{title}</h2>
      <table className={styles.ledger}>
        <tbody>
          <tr>
            <th scope="row">Rendez-vous</th>
            <td>{counts.total}</td>
          </tr>
          <tr>
            <th scope="row">Passés</th>
            <td>{counts.done}</td>
          </tr>
          <tr>
            <th scope="row">À venir</th>
            <td>{counts.left}</td>
          </tr>
          <tr>
            <th scope="row">Pris en ligne</th>
            <td>{counts.online}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Temps libre à venir</th>
            <td>{flow.freeMinutes ? formatDuration(flow.freeMinutes) : "—"}</td>
          </tr>
        </tfoot>
      </table>
      {flow.freeStretches > 1 ? (
        <p className={styles.ledgerFoot}>en {flow.freeStretches} plages</p>
      ) : null}
    </section>
  );
}

/** Her notes stay folded until she asks: a client may be looking at the page. */
export function MarginNotes({ flow }: { flow: DayFlow }) {
  const [shown, setShown] = useState(false);
  const references = referencesOf(flow);
  if (references.size === 0) return null;
  const visits = flow.items.flatMap((item) =>
    item.kind === "visits" ? item.visits : [],
  );
  return (
    <section aria-label="Notes">
      <div className={styles.labelRow}>
        <h2 className={styles.label}>Notes · {references.size}</h2>
        <button
          type="button"
          aria-expanded={shown}
          className={styles.link}
          onClick={() => setShown(!shown)}
        >
          {shown ? "Masquer" : "Afficher"}
        </button>
      </div>
      {shown ? (
        <ol className={styles.notes}>
          {[...references].map(([id, reference]) => {
            const { appointment } = visits.find(
              (visit) => visit.appointment.id === id,
            )!;
            return (
              <li key={id}>
                <span>{reference}</span>
                <span>
                  <i>{appointment.client.displayName.split(" ")[0]}</i>,{" "}
                  {timeOf(appointment.localStartsAt)} —{" "}
                  {appointment.internalNotes!.trim()}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** The week, each day a vial of ink: how much of what can be booked is. */
export function WeekVials({ model }: { model: TodayModel }) {
  return (
    <section aria-label="Ta semaine">
      <h2 className={styles.label}>Ta semaine</h2>
      <p className={styles.ledgerFoot}>
        {model.weekVisits} rendez-vous commençant cette semaine
      </p>
      <ul className={styles.weekRow}>
        {model.week.map((day) => {
          const fill =
            day.bookableMinutes > 0
              ? Math.min(
                  100,
                  Math.round((day.bookedMinutes / day.bookableMinutes) * 100),
                )
              : 0;
          return (
            <li key={day.date}>
              <Link
                href={{ pathname: "/app", query: { date: day.date } }}
                className={styles.weekDay}
                data-today={day.isToday ? "" : undefined}
              >
                <span
                  aria-hidden="true"
                  className={styles.vial}
                  data-closed={day.closed ? "" : undefined}
                >
                  <i style={{ height: `${fill}%` }} />
                </span>
                <b>{dayNumber(day.date)}</b>
                <span aria-hidden="true">
                  {formatWeekdayShort(day.date).slice(0, 2)}
                </span>
                <span className="sr-only">
                  {formatWeekdayLong(day.date)} :{" "}
                  {day.closed ? "fermé" : `${fill} % réservé`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
