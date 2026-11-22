"use client";

import { useEffect, useState } from "react";

import { CalendarGrid } from "@/components/ui/calendar-grid";
import {
  dayNumber,
  periodLabel,
  shiftAnchor,
  visibleRange,
  type VisibleRange,
} from "@/features/agenda/client/dates";
import { cn } from "@/lib/cn";

import {
  fetchAvailabilityCalendar,
  type CalendarAvailabilityDay,
} from "../client/api";
import { dayLabel, wallTime } from "../client/business-time";
import { choiceIdsOf, type BookingFlow } from "../client/use-booking-flow";
import { NextOpeningNote } from "./next-opening";

export function AvailabilityCalendar({
  view,
  anchor,
  onAnchor,
  flow,
  chronological = false,
  onSelectDate,
  nextOpening = true,
}: {
  view: "week" | "month";
  anchor: string;
  onAnchor: (date: string) => void;
  flow: BookingFlow;
  chronological?: boolean;
  onSelectDate: (date: string) => void;
  /** An empty period offers her next slot (Higani point 60). */
  nextOpening?: boolean;
}) {
  // Chronological: the next seven bookable days from the one shown, not
  // the calendar week (on a Saturday evening, a calendar week would leave
  // one day to compare). Its arrows move by seven days.
  const rolling = chronological && view === "week";
  const range = rolling
    ? rollingRange(flow.days, anchor)
    : visibleRange(view, anchor);
  const days = range.days.filter(
    (day) => day >= flow.days[0]! && day <= flow.days.at(-1)!,
  );
  const shift = (direction: 1 | -1) =>
    rolling
      ? shiftRolling(flow.days, range.startDate, direction)
      : shiftAnchor(view, anchor, direction);
  const from = days[0];
  const through = days.at(-1);
  const { slug } = flow.business;
  const serviceId = flow.service?.id;
  const choices = flow.service
    ? choiceIdsOf(flow.service, flow.answers).join(",")
    : "";
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState<{
    key: string;
    start: string;
  } | null>(null);
  const stale = flow.notice === "slot_unavailable";
  const key = `${slug}:${serviceId}:${from}:${through}:${choices}:${revision}:${stale}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    days: CalendarAvailabilityDay[] | null;
  } | null>(null);
  useEffect(() => {
    if (!serviceId || !from || !through) return;
    const controller = new AbortController();
    void fetchAvailabilityCalendar(
      slug,
      serviceId,
      from,
      through,
      choices ? choices.split(",") : [],
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted)
        setLoaded({ key, days: result.ok ? result.data.days : null });
    });
    return () => controller.abort();
  }, [key, slug, serviceId, from, through, choices]);
  const result = loaded?.key === key ? loaded : null;
  const byDate = new Map(result?.days?.map((day) => [day.date, day.slots]));
  const empty =
    !!result?.days && result.days.every((day) => day.slots.length === 0);
  const listedDays = chronological
    ? result?.days?.filter((day) => day.slots.length > 0)
    : result?.days;
  const pendingStart =
    checking?.key === key && flow.slots.status === "loading"
      ? checking.start
      : undefined;
  function chooseTime(day: string, start: string) {
    setChecking({ key, start });
    flow.actions.chooseCalendarSlot(day, start);
  }
  const navClass =
    "min-h-11 min-w-11 rounded-xl border border-line bg-paper-raised text-ink disabled:opacity-40";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={navClass}
          aria-label={
            view === "month"
              ? "Mois précédent"
              : rolling
                ? "Sept jours précédents"
                : "Semaine précédente"
          }
          disabled={range.startDate <= flow.days[0]!}
          onClick={() => onAnchor(shift(-1))}
        >
          ‹
        </button>
        <p
          className="text-center text-sm font-semibold capitalize text-ink"
          aria-live="polite"
        >
          {periodLabel(view, range)}
        </p>
        <button
          type="button"
          className={navClass}
          aria-label={
            view === "month"
              ? "Mois suivant"
              : rolling
                ? "Sept jours suivants"
                : "Semaine suivante"
          }
          disabled={range.endDate >= flow.days.at(-1)!}
          onClick={() => onAnchor(shift(1))}
        >
          ›
        </button>
      </header>
      <p role="status" className="min-h-5 text-xs text-ink-muted">
        {!result
          ? "Recherche des créneaux disponibles…"
          : pendingStart
            ? "Vérification de l’horaire…"
            : result.days && !empty
              ? view === "month"
                ? "Choisissez un jour pour voir ses horaires."
                : "Choisissez un horaire."
              : ""}
      </p>
      {result?.days === null ? (
        <p role="alert" className="text-sm text-ink">
          Calendrier indisponible.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setRevision((value) => value + 1)}
          >
            Réessayer
          </button>
        </p>
      ) : null}
      {empty && nextOpening && through ? (
        <NextOpeningNote
          flow={flow}
          after={through}
          lead={
            view === "month"
              ? "Aucun créneau disponible ce mois-ci."
              : "Aucun créneau disponible sur cette période."
          }
          onGo={onAnchor}
        />
      ) : null}
      {view === "month" ? (
        <>
          <CalendarGrid days={range.days}>
            {(date) => {
              const slots = byDate.get(date) ?? [];
              return (
                <button
                  type="button"
                  aria-pressed={date === flow.date}
                  disabled={!slots.length}
                  onClick={() => onSelectDate(date)}
                  className={cn(
                    "flex min-h-16 w-full flex-col items-center rounded-lg border p-0.5 text-[10px] text-ink disabled:text-ink-muted",
                    date === flow.date
                      ? "border-ink bg-sand"
                      : "border-line bg-paper-raised",
                  )}
                >
                  <span className="text-sm font-semibold">
                    {dayNumber(date)}
                  </span>
                  {slots.slice(0, 2).map((slot) => (
                    <span key={slot.startsAt}>
                      {wallTime(slot.localStartsAt)}
                    </span>
                  ))}
                  {slots.length > 2 ? <span>+{slots.length - 2}</span> : null}
                  <span className="sr-only">{` · ${dayLabel(date)}, ${slots.length} créneaux`}</span>
                </button>
              );
            }}
          </CalendarGrid>
        </>
      ) : !result ? (
        <div aria-hidden="true" className="grid gap-3">
          {days.map((day) => (
            <div
              key={day}
              className="min-h-24 rounded-xl border border-line bg-paper-raised p-3"
            >
              <p className="mb-3 text-sm font-semibold capitalize">
                {dayLabel(day)}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-9 rounded-lg bg-sand motion-safe:animate-pulse"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : chronological && listedDays?.length === 0 ? (
        nextOpening ? null : (
          <p role="status" className="text-sm text-ink-muted">
            Aucun créneau disponible sur cette période.
          </p>
        )
      ) : (
        listedDays?.map(({ date, slots }) => (
          <section
            key={date}
            className="rounded-xl border border-line bg-paper-raised p-3"
          >
            <h3 className="mb-2 text-sm font-semibold capitalize text-ink">
              {dayLabel(date)}
            </h3>
            {slots.length ? (
              <div>
                <SlotTimes
                  selected={flow.slot?.startsAt}
                  date={date}
                  slots={chronological ? slots.slice(0, 6) : slots}
                  onChoose={chooseTime}
                  pending={pendingStart}
                />
                {chronological && slots.length > 6 ? (
                  <details>
                    <summary className="my-1 min-h-11 cursor-pointer py-3 text-sm font-medium text-ink-soft">
                      Voir les {slots.length - 6} autres horaires
                    </summary>
                    <SlotTimes
                      selected={flow.slot?.startsAt}
                      date={date}
                      slots={slots.slice(6)}
                      onChoose={chooseTime}
                      pending={pendingStart}
                    />
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                Aucun créneau disponible.
              </p>
            )}
          </section>
        ))
      )}
    </div>
  );
}

const ROLLING_DAYS = 7;

/** Seven bookable days from `anchor` (or the first bookable after it). */
export function rollingRange(
  bookable: readonly string[],
  anchor: string,
): VisibleRange {
  const found = bookable.findIndex((day) => day >= anchor);
  const start = Math.max(
    0,
    Math.min(
      found === -1 ? bookable.length - 1 : found,
      bookable.length - ROLLING_DAYS,
    ),
  );
  const days = bookable.slice(start, start + ROLLING_DAYS);
  return { startDate: days[0]!, endDate: days.at(-1)!, days };
}

/** The first day of the seven before or after those starting at `start`. */
export function shiftRolling(
  bookable: readonly string[],
  start: string,
  direction: 1 | -1,
): string {
  const index = Math.max(0, bookable.indexOf(start));
  const next = Math.min(
    Math.max(0, index + direction * ROLLING_DAYS),
    Math.max(0, bookable.length - ROLLING_DAYS),
  );
  return bookable[next]!;
}

function SlotTimes({
  date,
  slots,
  onChoose,
  selected,
  pending,
}: {
  date: string;
  slots: CalendarAvailabilityDay["slots"];
  onChoose: (date: string, startsAt: string) => void;
  selected?: string;
  pending?: string;
}) {
  return (
    <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
      {slots.map((slot) => (
        <li key={slot.startsAt}>
          <button
            type="button"
            aria-label={`${dayLabel(date)} à ${wallTime(slot.localStartsAt)}`}
            aria-pressed={Boolean(
              selected && Date.parse(slot.startsAt) === Date.parse(selected),
            )}
            aria-busy={slot.startsAt === pending || undefined}
            onClick={() => onChoose(date, slot.startsAt)}
            className="min-h-11 w-full rounded-lg border border-line text-sm font-medium text-ink aria-busy:bg-sand aria-pressed:border-ink aria-pressed:bg-sand"
          >
            {wallTime(slot.localStartsAt)}
          </button>
        </li>
      ))}
    </ul>
  );
}
