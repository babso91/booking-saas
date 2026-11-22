"use client";

import { useRef, type Ref } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import { dayLabel, dayParts, wallTime } from "../client/business-time";
import type { BookingFlow } from "../client/use-booking-flow";
import type { BookingFormat } from "../formats";
import {
  linkAction,
  QuoteLine,
  StepHeading,
  TimeZoneNote,
  whatsLeft,
} from "./booking-parts";
import { AvailabilityCalendar } from "./availability-calendar";
import { NextOpeningNote } from "./next-opening";

const WEEK = 7;
export type CalendarPosition = {
  view: "day" | "week" | "month";
  anchor: string;
  fromMonth: boolean;
};

/**
 * Choose a slot in the business time zone, within the booking horizon.
 */
export function SlotStep({
  flow,
  headingRef,
  position,
  onPosition,
  format,
}: {
  flow: BookingFlow;
  position: CalendarPosition;
  onPosition: (next: CalendarPosition) => void;
  format: BookingFormat;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { service, days, date, slots, slot, notice, business } = flow;
  const index = Math.max(0, days.indexOf(date));
  const { view, anchor } = position;
  const daySlots = useRef<HTMLDivElement>(null);
  const inlineMonth = view === "month" && format !== "calendar";
  const clampDate = (day: string) =>
    day < days[0]! ? days[0]! : day > days.at(-1)! ? days.at(-1)! : day;
  const page = Math.floor(Math.max(0, days.indexOf(clampDate(anchor))) / WEEK);
  function goToView(
    next: CalendarPosition["view"],
    day: string,
    fromMonth = false,
  ) {
    const chosen = clampDate(day);
    if ((next === "day" && chosen !== date) || slots.status === "loading")
      flow.actions.chooseDate(chosen);
    onPosition({ view: next, anchor: chosen, fromMonth });
  }
  function chooseDate(day: string) {
    flow.actions.chooseDate(day);
    onPosition({ ...position, anchor: day });
  }

  function selectMonthDay(day: string) {
    if (format === "calendar") {
      goToView("day", day, true);
      return;
    }
    chooseDate(day);
    requestAnimationFrame(() => {
      daySlots.current?.scrollIntoView?.({ block: "start" });
    });
  }

  const pages = Math.ceil(days.length / WEEK);
  const week = days.slice(page * WEEK, page * WEEK + WEEK);
  const nextDay = days[index + 1];

  if (!service) return null;
  return (
    <section aria-labelledby="booking-slot" className="flex flex-col gap-5">
      <div id="booking-slot">
        <StepHeading
          step={flow.stepNumber("slot")}
          total={flow.stepCount}
          left={whatsLeft(flow.stepsAfter("slot"))}
          headingRef={headingRef}
        >
          Choisissez un créneau
        </StepHeading>
      </div>

      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-paper-raised px-4 py-3">
        <p className="text-[15px] font-semibold wrap-anywhere text-ink">
          {service.name}
        </p>
        {slots.status === "ready" && slots.quote.options.length > 0 ? (
          <ul className="text-[14px] text-ink-soft">
            {slots.quote.options.map((option) => (
              <li key={option.optionId} className="wrap-anywhere">
                {option.question} : {option.label}
              </li>
            ))}
          </ul>
        ) : null}
        {/* The server's quote for these answers; the slots are for it. */}
        <div aria-live="polite">
          <QuoteLine slots={slots} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          {service.options.length > 0 ? (
            <button
              type="button"
              className={linkAction}
              onClick={() => flow.actions.goTo("options")}
            >
              Changer les options
            </button>
          ) : null}
          <button
            type="button"
            className={linkAction}
            onClick={() => flow.actions.goTo("service")}
          >
            Changer de prestation
          </button>
        </div>
      </div>

      {notice === "quote_changed" ? (
        <Notice tone="warning" title="Le prix ou la durée a changé">
          L’établissement vient de modifier cette prestation : rien n’a été
          réservé. Le prix et la durée affichés sont à jour ; choisissez votre
          créneau pour continuer, vos coordonnées sont conservées.
        </Notice>
      ) : null}

      {notice === "slot_unavailable" ? (
        <Notice tone="warning" title="Ce créneau n’est plus disponible">
          Il vient d’être réservé ou n’est plus proposé. Les créneaux ont été
          mis à jour : choisissez-en un autre, vos coordonnées sont conservées.
        </Notice>
      ) : null}

      <nav aria-label="Vue des disponibilités" className="flex gap-1">
        {(
          [
            ["day", "Jour"],
            ["week", "Semaine"],
            ["month", "Mois"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => {
              if (view !== value) goToView(value, anchor);
            }}
            className={cn(
              "min-h-11 rounded-xl border px-3 text-sm font-semibold",
              view === value
                ? "border-ink bg-ink text-paper-raised"
                : "border-line bg-paper-raised text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      {position.fromMonth && (
        <button
          type="button"
          className={linkAction + " self-start"}
          onClick={() => goToView("month", date)}
        >
          ← Revenir au mois
        </button>
      )}
      {view !== "day" ? (
        <AvailabilityCalendar
          view={view}
          anchor={anchor}
          onAnchor={(next) => goToView(view, next)}
          flow={flow}
          chronological={format === "chronological"}
          onSelectDate={selectMonthDay}
          // Her month above the day's slots: the day says what is next.
          nextOpening={
            !(inlineMonth && anchor.slice(0, 7) === date.slice(0, 7))
          }
        />
      ) : (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-3 text-[15px] font-medium text-ink">
            Jour
          </legend>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => chooseDate(days[(page - 1) * WEEK]!)}
              disabled={page === 0}
              aria-label="Semaine précédente"
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-soft hover:bg-sand disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeftIcon size={18} />
            </button>
            <p className="text-[14px] text-ink-soft" aria-live="polite">
              {week.length > 0
                ? `Du ${dayLabel(week[0]!)} au ${dayLabel(week.at(-1)!)}`
                : null}
            </p>
            <button
              type="button"
              onClick={() => chooseDate(days[(page + 1) * WEEK]!)}
              disabled={page >= pages - 1}
              aria-label="Semaine suivante"
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-soft hover:bg-sand disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRightIcon size={18} />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 sm:gap-2">
            {week.map((day) => {
              const parts = dayParts(day);
              const selected = day === date;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => chooseDate(day)}
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-2xl border px-0.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                    selected
                      ? "border-ink bg-ink text-paper-raised"
                      : "border-line bg-paper-raised text-ink hover:border-line-strong",
                  )}
                >
                  <span className="text-[11.5px] capitalize opacity-80">
                    {parts.weekday}
                  </span>
                  <span className="text-[17px] leading-none font-semibold">
                    {parts.day}
                  </span>
                  <span className="text-[11.5px] opacity-80">
                    {parts.month}
                  </span>
                  {/* Its name starts with what is written (voice control),
                    then says the day in full. */}
                  <span className="sr-only">, {dayLabel(day)}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {view === "week" ? <TimeZoneNote timezone={business.timezone} /> : null}
      {view === "week" && slots.status === "error" ? (
        <Notice tone="warning" title="Impossible de vérifier ce créneau">
          Sélectionnez à nouveau l’heure pour réessayer.
        </Notice>
      ) : null}
      {view === "day" ||
      (inlineMonth && anchor.slice(0, 7) === date.slice(0, 7)) ? (
        <div ref={daySlots} className="flex min-h-36 flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-[15px] font-medium text-ink first-letter:uppercase">
              {dayLabel(date)}
            </h3>
            <button
              type="button"
              className={linkAction}
              onClick={flow.actions.refreshSlots}
              disabled={slots.status === "loading"}
            >
              Actualiser
            </button>
          </div>
          <TimeZoneNote timezone={business.timezone} />

          {slots.status === "loading" ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <p role="status" className="text-[14px] text-ink-muted">
                Recherche des créneaux disponibles…
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {[0, 1, 2, 3, 4, 5].map((key) => (
                  <span
                    key={key}
                    className="h-12 animate-pulse rounded-xl bg-sand/60"
                  />
                ))}
              </div>
            </div>
          ) : slots.status === "error" ? (
            <Notice
              tone={slots.error.code === "network" ? "offline" : "error"}
              title="Créneaux indisponibles pour le moment"
              action={
                <button
                  type="button"
                  className={linkAction}
                  onClick={flow.actions.refreshSlots}
                >
                  Réessayer
                </button>
              }
            >
              {slots.error.code === "network"
                ? "La connexion a été interrompue."
                : "Les créneaux n’ont pas pu être chargés."}
            </Notice>
          ) : slots.status === "ready" && slots.slots.length === 0 ? (
            <NextOpeningNote
              flow={flow}
              after={date}
              lead="Aucun créneau disponible ce jour-là."
              onGo={chooseDate}
              fallbackDay={nextDay}
            />
          ) : slots.status === "ready" ? (
            <ul
              className="grid grid-cols-3 gap-2 sm:grid-cols-4"
              aria-label={`Créneaux du ${dayLabel(date)}`}
            >
              {slots.slots.map((item) => {
                const selected = item.startsAt === slot?.startsAt;
                return (
                  <li key={item.startsAt}>
                    <button
                      type="button"
                      onClick={() => flow.actions.chooseSlot(item)}
                      aria-pressed={selected}
                      aria-label={`${dayLabel(date)} à ${wallTime(item.localStartsAt)}`}
                      className={cn(
                        "h-12 w-full cursor-pointer rounded-xl border text-[15.5px] font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                        selected
                          ? "border-ink bg-ink text-paper-raised"
                          : "border-line bg-paper-raised text-ink hover:border-line-strong",
                      )}
                    >
                      {wallTime(item.localStartsAt)}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : view === "month" ? (
        <TimeZoneNote timezone={business.timezone} />
      ) : null}
    </section>
  );
}
