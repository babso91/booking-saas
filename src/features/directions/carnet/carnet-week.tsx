import Link from "next/link";

import { minutes, pauses, slotsOf, today, weekDays } from "../data";
import styles from "./carnet.module.css";

// The week as a planner spread: Monday to Wednesday on the left page,
// Thursday to Saturday on the right, the fold between them. Entries are
// written, not boxed: a stroke of ink as long as the visit. On a phone, one
// day at a time, picked from a strip of dates.

const OPEN = minutes(today.dayStart);
const SPAN = minutes(today.dayEnd) - OPEN;
const at = (time: string) => `${((minutes(time) - OPEN) / SPAN) * 100}%`;
const hours = Array.from({ length: 11 }, (_, i) => 9 + i);

export function CarnetWeek({ shown }: { shown: number }) {
  const left = weekDays.slice(0, 3);
  const right = weekDays.slice(3);
  return (
    <>
      <div className={styles.weekTitle}>
        <h1>
          <span className={styles.wide}>Octobre, s</span>
          <span className={styles.narrow}>S</span>emaine 44
        </h1>
        <nav className={styles.weekNav} aria-label="Semaines">
          <a href="#precedente" aria-label="Semaine précédente">
            ←<span className={styles.wide}> Précédente</span>
          </a>
          <a href="#suivante" aria-label="Semaine suivante">
            <span className={styles.wide}>Suivante </span>→
          </a>
        </nav>
      </div>

      <nav className={styles.dayStrip} aria-label="Jours">
        {weekDays.map((day) => (
          <Link
            key={day.date}
            href={{
              pathname: "/apercu/directions/carnet/agenda",
              query: { jour: day.date },
            }}
            aria-current={day.date === shown ? "date" : undefined}
          >
            {day.weekday.slice(0, 3)}.<b>{day.date}</b>
          </Link>
        ))}
      </nav>

      <div className={styles.planner} style={{ height: "auto" }}>
        <Hours />
        {left.map((day) => (
          <Day
            key={day.date}
            date={day.date}
            weekday={day.weekday}
            shown={shown}
          />
        ))}
        <div className={styles.gutter} aria-hidden="true" />
        <Hours second />
        {right.map((day) => (
          <Day
            key={day.date}
            date={day.date}
            weekday={day.weekday}
            shown={shown}
          />
        ))}
      </div>
    </>
  );
}

function Hours({ second }: { second?: boolean }) {
  return (
    <div
      className={styles.hours}
      aria-hidden="true"
      style={second ? undefined : undefined}
      data-second={second ? "" : undefined}
    >
      {hours.map((hour) => (
        <span
          key={hour}
          className={styles.hourLabel}
          style={{ top: at(`${String(hour).padStart(2, "0")}:00`) }}
        >
          {hour} h
        </span>
      ))}
    </div>
  );
}

function Day({
  date,
  weekday,
  shown,
}: {
  date: number;
  weekday: string;
  shown: number;
}) {
  const isToday = date === today.day;
  const now = minutes(today.now);
  return (
    <section
      className={styles.day}
      aria-label={`${weekday} ${date}`}
      data-today={isToday ? "" : undefined}
      data-show={date === shown ? "" : undefined}
      style={{ height: "calc(600 * var(--ppm))" }}
    >
      <h2 className={styles.dayHead}>
        <b>{date}</b>
        <span>{weekday}</span>
      </h2>
      {hours.map((hour) => (
        <span
          key={hour}
          className={styles.hourRule}
          style={{ top: at(`${String(hour).padStart(2, "0")}:00`) }}
          aria-hidden="true"
        />
      ))}
      {hours.slice(0, -1).map((hour) => (
        <span
          key={`h${hour}`}
          className={styles.halfRule}
          style={{ top: at(`${String(hour).padStart(2, "0")}:30`) }}
          aria-hidden="true"
        />
      ))}
      {pauses.map((pause) => (
        <span
          key={pause.id}
          className={styles.dayPause}
          style={{
            top: at(pause.start),
            height: `calc(${at(pause.end)} - ${at(pause.start)})`,
          }}
        >
          {pause.label}
        </span>
      ))}
      {slotsOf(date).map((slot) => {
        const past = date < today.day || (isToday && minutes(slot.end) <= now);
        const live =
          isToday && minutes(slot.start) <= now && now < minutes(slot.end);
        return (
          <article
            key={slot.start}
            className={styles.slot}
            data-past={past ? "" : undefined}
            data-now={live ? "" : undefined}
            data-short={
              minutes(slot.end) - minutes(slot.start) < 60 ? "" : undefined
            }
            style={{
              top: at(slot.start),
              height: `calc(${at(slot.end)} - ${at(slot.start)} - 3px)`,
            }}
          >
            <b>{slot.client}</b>
            <span>{slot.service}</span>
            <span className={styles.mono}>
              {slot.start}–{slot.end}
            </span>
          </article>
        );
      })}
      {isToday ? (
        <span
          className={styles.nowRule}
          style={{ top: at(today.now) }}
          role="img"
          aria-label={`Il est ${today.now}`}
        />
      ) : null}
    </section>
  );
}
