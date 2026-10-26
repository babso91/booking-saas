import Link from "next/link";

import { minutes, pauses, slotsOf, today, weekDays } from "../data";
import styles from "./studio.module.css";

// The week as a wall planner: one row per day, time running left to right,
// so a glance compares the days. On a phone, one day at a time, as tall
// slabs whose height is the visit's length.

const OPEN = minutes(today.dayStart);
const SPAN = minutes(today.dayEnd) - OPEN;
const pct = (time: string) => ((minutes(time) - OPEN) / SPAN) * 100;
const hours = Array.from({ length: 10 }, (_, i) => 9 + i);
const now = minutes(today.now);

function stateOfSlot(date: number, start: string, end: string) {
  if (date < today.day) return "done";
  if (date > today.day) return "later";
  if (minutes(end) <= now) return "done";
  if (minutes(start) <= now) return "now";
  return "later";
}

export function StudioWeek({ shown }: { shown: number }) {
  return (
    <>
      <div className={styles.weekHead}>
        <h1 className={styles.weekTitle}>
          Semaine <span>44</span>
        </h1>
        <nav className={styles.weekArrows} aria-label="Semaines">
          <a href="#precedente" aria-label="Semaine précédente">
            ←
          </a>
          <a href="#suivante" aria-label="Semaine suivante">
            →
          </a>
        </nav>
      </div>

      <div className={styles.gantt}>
        <div className={styles.ganttScale} aria-hidden="true">
          {hours.map((h) => (
            <span
              key={h}
              style={{ left: `${pct(`${String(h).padStart(2, "0")}:00`)}%` }}
            >
              {h}h
            </span>
          ))}
        </div>
        {weekDays.map((day) => (
          <section
            key={day.date}
            className={styles.ganttRow}
            data-today={day.date === today.day ? "" : undefined}
            aria-label={`${day.weekday} ${day.date}`}
          >
            <div className={styles.ganttDay}>
              <b>{day.date}</b>
              <span>{day.weekday}</span>
            </div>
            <div className={styles.ganttLane}>
              {pauses.map((p) => (
                <span
                  key={p.id}
                  className={styles.blockPause}
                  style={{
                    left: `${pct(p.start)}%`,
                    width: `calc(${pct(p.end) - pct(p.start)}% - 4px)`,
                  }}
                />
              ))}
              {slotsOf(day.date).map((slot) => (
                <article
                  key={slot.start}
                  className={styles.block}
                  data-state={stateOfSlot(day.date, slot.start, slot.end)}
                  style={{
                    left: `${pct(slot.start)}%`,
                    width: `calc(${pct(slot.end) - pct(slot.start)}% - 4px)`,
                  }}
                >
                  <b>{slot.client.split(" ")[0]}</b>
                  <span>{slot.service}</span>
                </article>
              ))}
              {day.date === today.day ? (
                <span
                  className={styles.nowPin}
                  style={{ left: `${pct(today.now)}%`, top: 0, bottom: 0 }}
                  data-time={today.now}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <nav className={styles.dayPicker} aria-label="Jours">
        {weekDays.map((day) => (
          <Link
            key={day.date}
            href={{
              pathname: "/apercu/directions/studio/agenda",
              query: { jour: day.date },
            }}
            aria-current={day.date === shown ? "date" : undefined}
          >
            <span>{day.weekday.slice(0, 3)}</span>
            <b>{day.date}</b>
          </Link>
        ))}
      </nav>

      <div className={styles.slabs} style={{ height: 600 * 1.5 }}>
        <div className={styles.slabScale} aria-hidden="true">
          {[...hours, 19].map((h) => (
            <span
              key={h}
              style={{ top: `${pct(`${String(h).padStart(2, "0")}:00`)}%` }}
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
              top: `${pct(p.start)}%`,
              height: `calc(${pct(p.end) - pct(p.start)}% - 4px)`,
            }}
          >
            {p.label}
          </span>
        ))}
        {slotsOf(shown).map((slot) => (
          <article
            key={slot.start}
            className={styles.block}
            data-state={stateOfSlot(shown, slot.start, slot.end)}
            style={{
              top: `${pct(slot.start)}%`,
              height: `calc(${pct(slot.end) - pct(slot.start)}% - 4px)`,
            }}
          >
            <b>{slot.client}</b>
            <span>
              {slot.start}–{slot.end} · {slot.service}
            </span>
          </article>
        ))}
        {shown === today.day ? (
          <span
            className={styles.nowPin}
            style={{ top: `${pct(today.now)}%` }}
            data-time={today.now}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </>
  );
}
