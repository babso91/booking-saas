"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { dayNumber, formatWeekdayLong } from "@/features/agenda/client/dates";
import type { AgendaDto } from "@/features/agenda/data/agenda";

import { dayFlow } from "../agenda/day-flow";
import { todayModel } from "../client/today-model";
import { sectionHref } from "../sections";
import { CarnetEntries } from "./carnet-entries";
import { MarginNotes, Register, WeekVials } from "./carnet-margin";
import styles from "./carnet.module.css";
import { folioOf, ledeOf, monthOf } from "./folio";

// "Aujourd’hui" in Carnet: today's page. The date set large, one sentence that
// says the day, the entries, and in the margin the register, her notes and her
// week. Everything comes from her agenda's reading (TodayModel and dayFlow, as
// in every style): no money before the payment record exists, nothing invented.

function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;
const REFRESH_MS = 5 * 60_000;

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function Dateline({ date, level = 1 }: { date: string; level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <Heading className={styles.dateline}>
      <span className={styles.weekday}>
        {capitalize(formatWeekdayLong(date))}
      </span>
      <span className={styles.date}>
        {dayNumber(date)} {monthOf(date)}
        <span className={styles.year}>{date.slice(0, 4)}</span>
      </span>
    </Heading>
  );
}

export function CarnetToday({
  agenda,
  date,
  serverNow,
  frozenNow,
}: {
  agenda: AgendaDto;
  date: string;
  serverNow: number;
  /** A fixed instant, for previews: the clock is not consulted. */
  frozenNow?: number;
}) {
  const router = useRouter();
  const ticking = useSyncExternalStore(
    subscribeClock,
    clockNow,
    () => serverNow,
  );
  const now = frozenNow ?? ticking;
  const model = useMemo(
    () => todayModel(agenda, date, now),
    [agenda, date, now],
  );
  const flow = useMemo(() => dayFlow(agenda, date, now), [agenda, date, now]);

  const rolledOver = model.nowTime === null && now > model.span.start;
  useEffect(() => {
    if (rolledOver && frozenNow === undefined) router.refresh();
  }, [rolledOver, frozenNow, router]);

  useEffect(() => {
    if (frozenNow !== undefined) return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [frozenNow, router]);

  return (
    <div tabIndex={0} className={styles.scroll}>
      <div className={styles.spread}>
        <div className={styles.page}>
          <p className={styles.folio}>{folioOf(date)}</p>
          <Dateline date={date} />
          <p className={styles.lede}>
            {ledeOf(model).map((part, index) =>
              part.marked ? (
                <em key={index}>{part.text}</em>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </p>
          {model.closures.length ? (
            <p className={styles.closureNote}>
              {model.closures
                .map(
                  (closure) =>
                    `Fermé de ${closure.from} à ${closure.to}${closure.reason ? ` · ${closure.reason}` : ""}`,
                )
                .join(" ; ")}
            </p>
          ) : null}

          <section className={styles.section} aria-label="Rendez-vous du jour">
            <div className={styles.sectionHead}>
              <h2 className={styles.label}>Ordre du jour</h2>
              <Link href={sectionHref.agenda} className={styles.link}>
                Voir la semaine
              </Link>
            </div>
            <CarnetEntries
              page
              flow={flow}
              data={agenda}
              date={date}
              nowMs={now}
            />
          </section>
        </div>

        <aside className={styles.margin} aria-label="En marge">
          <Register model={model} flow={flow} />
          <MarginNotes flow={flow} />
          <WeekVials model={model} />
        </aside>
      </div>
    </div>
  );
}
