import Link from "next/link";

import { minutes, pauses, slotsOf, today, weekDays } from "../data";
import styles from "./ecrin.module.css";

// Days as pearls on a string; the chosen day in the middle, its neighbours
// smaller on each side (on a large screen). Each day is a rail where the
// visits hang, as long as they last.

const OPEN = minutes(today.dayStart);
const SPAN = minutes(today.dayEnd) - OPEN;
const PX = 1.18; // pixels per minute
const top = (time: string) => (minutes(time) - OPEN) * PX;
const now = minutes(today.now);

function stateOfSlot(date: number, start: string, end: string) {
  if (date < today.day) return "done";
  if (date > today.day) return "later";
  if (minutes(end) <= now) return "done";
  if (minutes(start) <= now) return "now";
  return "later";
}

export function EcrinWeek({ shown }: { shown: number }) {
  const index = weekDays.findIndex((d) => d.date === shown);
  const before = weekDays[index - 1];
  const after = weekDays[index + 1];
  return (
    <>
      <nav className={styles.beads} aria-label="Jours de la semaine">
        {weekDays.map((day) => (
          <Link
            key={day.date}
            href={{
              pathname: "/apercu/directions/ecrin/agenda",
              query: { jour: day.date },
            }}
            className={`${styles.bead} ${day.date === shown ? "" : styles.object}`}
            aria-current={day.date === shown ? "date" : undefined}
          >
            <b className={styles.num}>{day.date}</b>
            <span>{day.weekday.slice(0, 3)}</span>
          </Link>
        ))}
      </nav>
      <div className={styles.days}>
        {before ? (
          <Day date={before.date} weekday={before.weekday} side />
        ) : (
          <Spacer />
        )}
        <Day date={shown} weekday={weekDays[index]!.weekday} />
        {after ? (
          <Day date={after.date} weekday={after.weekday} side />
        ) : (
          <Spacer />
        )}
      </div>
    </>
  );
}

function Spacer() {
  return (
    <div
      className={styles.dayCol}
      data-side=""
      aria-hidden="true"
      style={{ visibility: "hidden" }}
    />
  );
}

function Day({
  date,
  weekday,
  side,
}: {
  date: number;
  weekday: string;
  side?: boolean;
}) {
  return (
    <section
      className={styles.dayCol}
      data-side={side ? "" : undefined}
      aria-label={`${weekday} ${date}`}
    >
      <h2 className={styles.dayTitle}>
        <b className={styles.num}>{date}</b>
        <span>{weekday}</span>
      </h2>
      <div className={styles.rail} style={{ height: SPAN * PX }}>
        {!side ? (
          <div className={styles.railHours} aria-hidden="true">
            {[9, 11, 13, 15, 17, 19].map((h) => (
              <span
                key={h}
                style={{ top: top(`${String(h).padStart(2, "0")}:00`) }}
              >
                {h} h
              </span>
            ))}
          </div>
        ) : null}
        {pauses.map((p) => (
          <span
            key={p.id}
            className={styles.hangPause}
            style={{
              top: top(p.start) + 6,
              height: top(p.end) - top(p.start) - 12,
            }}
          >
            {p.label}
          </span>
        ))}
        {slotsOf(date).map((slot) => {
          const length = minutes(slot.end) - minutes(slot.start);
          return (
            <article
              key={slot.start}
              className={`${styles.hang} ${styles.object}`}
              data-state={stateOfSlot(date, slot.start, slot.end)}
              data-short={length < 60 ? "" : undefined}
              style={{ top: top(slot.start) + 2, height: length * PX - 6 }}
            >
              <b>{slot.client}</b>
              <span className={styles.num}>
                {slot.start} · {slot.service}
              </span>
            </article>
          );
        })}
        {date === today.day ? (
          <span
            className={styles.railNow}
            style={{ top: top(today.now) }}
            data-time={today.now}
            role="img"
            aria-label={`Il est ${today.now}`}
          />
        ) : null}
      </div>
    </section>
  );
}
