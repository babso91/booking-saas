"use client";

import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
  type TouchEvent,
} from "react";

import {
  dayNumber,
  formatFullDate,
  formatWeekdayShort,
  startOfWeek,
  visibleRange,
} from "@/features/agenda/client/dates";
import { cn } from "@/lib/cn";

import { dayFlow, distinctBookings } from "../agenda/day-flow";
import type { StudioAgendaProps } from "../agenda/studio-agenda";
import { useOptionsMenu } from "../agenda/use-options-menu";
import { todayModel } from "../client/today-model";
import { CarnetEntries } from "./carnet-entries";
import { MarginNotes, Register } from "./carnet-margin";
import { Dateline } from "./carnet-today";
import { CarnetWeek } from "./carnet-week";
import styles from "./carnet.module.css";
import { folioOf, isoWeek, weekMonths, weekSpan } from "./folio";

// The Carnet agenda: the same agenda (AgendaView: its reading, its today checked
// with PostgreSQL, its cards, forms and actions), its own pages. On a computer,
// the week as a double page, or a day as a page with its margin; on a phone, the
// day written down, a strip of dates, "+ Noter" under the thumb. It takes the
// same contract as the Studio presentation.

const WAKE_AFTER_MS = 60_000;

export function CarnetAgenda(props: StudioAgendaProps) {
  const { view, wide, days, anchor, today, data, nowMs, loading } = props;
  const count = data ? distinctBookings(data, days) : null;
  const isOnToday = today !== null && days.includes(today);
  const heading = useRef<HTMLDivElement>(null);

  // Back to the tab after a while: bookings may have come meanwhile.
  const refresh = useRef(props.onRefresh);
  useEffect(() => {
    refresh.current = props.onRefresh;
  });
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onChange = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt > WAKE_AFTER_MS) {
        hiddenAt = null;
        refresh.current?.();
      } else hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const flow = useMemo(
    () => (data && view === "day" ? dayFlow(data, anchor, nowMs) : null),
    [data, view, anchor, nowMs],
  );
  const model = useMemo(
    () =>
      data && view === "day" ? todayModel(data, anchor, nowMs ?? 0) : null,
    [data, view, anchor, nowMs],
  );

  return (
    <div className={styles.agenda}>
      <header className={styles.agendaHead}>
        <div ref={heading} tabIndex={-1} className={styles.agendaTitle}>
          {view === "week" ? (
            <>
              <h1 className={styles.weekTitle} aria-live="polite">
                {weekMonths(days)}, semaine {isoWeek(days[0]!)}
              </h1>
              <p className={styles.weekSub}>
                {weekSpan(days)}
                {count !== null ? ` · ${count} rendez‑vous` : ""}
              </p>
            </>
          ) : (
            <>
              <p className={styles.folio}>
                {folioOf(anchor)}
                {count !== null ? ` · ${count} rdv` : ""}
              </p>
              <div aria-live="polite">
                <Dateline date={anchor} />
              </div>
            </>
          )}
        </div>

        {wide ? (
          <div className={styles.toolbar}>
            <div role="group" aria-label="Affichage" className={styles.views}>
              {(["week", "day"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => props.onView(option)}
                >
                  {option === "week" ? "Semaine" : "Jour"}
                </button>
              ))}
            </div>
            <nav
              aria-label={view === "week" ? "Semaines" : "Jours"}
              className={styles.pager}
            >
              <button
                type="button"
                aria-label={
                  view === "week" ? "Semaine précédente" : "Jour précédent"
                }
                onClick={() => props.onShift(-1)}
              >
                ←
              </button>
              <button
                type="button"
                data-on-today={isOnToday}
                onClick={props.onToday}
              >
                Aujourd’hui
              </button>
              <button
                type="button"
                aria-label={
                  view === "week" ? "Semaine suivante" : "Jour suivant"
                }
                onClick={() => props.onShift(1)}
              >
                →
              </button>
            </nav>
            <label className={styles.cancelled}>
              <input
                type="checkbox"
                checked={props.includeCancelled}
                onChange={(event) =>
                  props.onIncludeCancelled(event.target.checked)
                }
              />
              Annulés
              <span className="sr-only">
                {" "}
                : afficher les rendez-vous annulés
              </span>
            </label>
            <button
              type="button"
              className={styles.link}
              onClick={props.onNewBlock}
            >
              Bloquer un créneau
            </button>
            <button
              type="button"
              className={styles.new}
              onClick={props.onNewAppointment}
            >
              <span aria-hidden="true">+</span> Nouveau rendez-vous
            </button>
          </div>
        ) : (
          <div className={styles.phoneTools}>
            {isOnToday ? null : (
              <button
                type="button"
                className={styles.link}
                data-on-today={false}
                onClick={() => {
                  // This button goes away once on today: focus stays near.
                  heading.current?.focus({ preventScroll: true });
                  props.onToday();
                }}
              >
                Aujourd’hui
              </button>
            )}
            <Options
              includeCancelled={props.includeCancelled}
              onIncludeCancelled={props.onIncludeCancelled}
              onNewBlock={props.onNewBlock}
              fallback={heading}
            />
          </div>
        )}
      </header>

      {wide ? null : (
        <DayStrip
          anchor={anchor}
          today={today}
          onSelect={props.onSelectDay}
          onShift={props.onShift}
        />
      )}

      <div className={styles.agendaBody}>
        {loading ? (
          <div
            className={styles.loading}
            role="progressbar"
            aria-label="Chargement de l’agenda"
          >
            <span className="animate-progress" />
          </div>
        ) : null}
        {props.banners}

        {view === "week" ? (
          <CarnetWeek
            days={days}
            data={data}
            today={today}
            nowMs={nowMs}
            onOpenAppointment={props.onOpenAppointment}
            onOpenBlock={props.onOpenBlock}
            onCreateAt={props.onCreateAt}
            onOpenDay={(date) => {
              props.onSelectDay(date);
              props.onView("day");
            }}
          />
        ) : (
          <Swipe
            enabled={!wide}
            onShift={props.onShift}
            className={styles.scroll}
          >
            <div className={cn(styles.spread, styles.daySpread)}>
              <div className={styles.page}>
                {flow && data ? (
                  <CarnetEntries
                    flow={flow}
                    data={data}
                    date={anchor}
                    nowMs={nowMs}
                    onOpenAppointment={props.onOpenAppointment}
                    onOpenBlock={props.onOpenBlock}
                    onCreateAt={props.onCreateAt}
                  />
                ) : null}
              </div>
              {flow && model ? (
                <aside className={styles.margin} aria-label="En marge">
                  <Register
                    model={model}
                    flow={flow}
                    title={anchor === today ? "Registre du jour" : "Registre"}
                  />
                  <MarginNotes flow={flow} />
                </aside>
              ) : null}
            </div>
          </Swipe>
        )}
      </div>

      {/* Phone: under the thumb, above the ribbon. */}
      {wide ? null : (
        <button
          type="button"
          className={cn(styles.new, styles.noteFloating)}
          onClick={props.onNewAppointment}
        >
          <span aria-hidden="true">+</span> Noter
          <span className="sr-only"> un nouveau rendez-vous</span>
        </button>
      )}

      {props.panels}
    </div>
  );
}

/** Phone: blocking time and cancelled visits, in one small menu. */
function Options({
  includeCancelled,
  onIncludeCancelled,
  onNewBlock,
  fallback,
}: {
  includeCancelled: boolean;
  onIncludeCancelled: (value: boolean) => void;
  onNewBlock: () => void;
  fallback: RefObject<HTMLElement | null>;
}) {
  const { open, root, trigger, toggle, leaveFor } = useOptionsMenu(fallback);
  return (
    <div ref={root} className={styles.optionsRoot}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls="carnet-agenda-options"
        aria-label="Options de l’agenda"
        className={styles.link}
        onClick={toggle}
      >
        Options
      </button>
      {open ? (
        <div id="carnet-agenda-options" className={styles.options}>
          <button type="button" onClick={() => leaveFor(onNewBlock)}>
            Bloquer un créneau
          </button>
          <label>
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(event) => onIncludeCancelled(event.target.checked)}
            />
            Afficher les annulés
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** The days of the week shown; the arrows turn a week of pages. */
function DayStrip({
  anchor,
  today,
  onSelect,
  onShift,
}: {
  anchor: string;
  today: string | null;
  onSelect: (date: string) => void;
  onShift: StudioAgendaProps["onShift"];
}) {
  const { days } = visibleRange("week", startOfWeek(anchor));
  return (
    <div className={styles.dayStrip}>
      <button
        type="button"
        aria-label="Semaine précédente"
        className={styles.stripArrow}
        onClick={() => onShift(-7)}
      >
        ←
      </button>
      <div
        role="group"
        aria-label="Jours de la semaine"
        className={styles.stripDays}
      >
        {days.map((date) => (
          <button
            key={date}
            type="button"
            aria-pressed={date === anchor}
            data-today={date === today ? "" : undefined}
            onClick={() => onSelect(date)}
          >
            <span aria-hidden="true">
              {formatWeekdayShort(date).slice(0, 2)}
            </span>
            <b>{dayNumber(date)}</b>
            <span className="sr-only">, {formatFullDate(date)}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Semaine suivante"
        className={styles.stripArrow}
        onClick={() => onShift(7)}
      >
        →
      </button>
    </div>
  );
}

/** A horizontal swipe turns the page (phone); vertical scrolling is left alone. */
function Swipe({
  enabled,
  onShift,
  className,
  children,
}: {
  enabled: boolean;
  onShift: StudioAgendaProps["onShift"];
  className?: string;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const from = start.current;
    const touch = event.changedTouches[0];
    start.current = null;
    if (!from || !touch) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) onShift(dx < 0 ? 1 : -1);
  };
  return (
    <div
      tabIndex={0}
      className={className}
      onTouchStart={enabled ? onTouchStart : undefined}
      onTouchEnd={enabled ? onTouchEnd : undefined}
    >
      {children}
    </div>
  );
}
