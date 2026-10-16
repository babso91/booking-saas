"use client";

import { useState, type Ref } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import { dayLabel, dayParts, wallTime } from "../client/business-time";
import type { BookingFlow } from "../client/use-booking-flow";
import {
  linkAction,
  serviceLine,
  StepHeading,
  TimeZoneNote,
} from "./booking-parts";

const WEEK = 7;

/**
 * Step 2: a civil day (business time zone), then one of its real slots, as
 * returned by the backend. Days are shown a week at a time, up to the
 * booking horizon.
 */
export function SlotStep({
  flow,
  headingRef,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { service, days, date, slots, slot, notice, business } = flow;
  const index = Math.max(0, days.indexOf(date));
  const [page, setPage] = useState(Math.floor(index / WEEK));
  const [shownDate, setShownDate] = useState(date);
  // The day can change from the flow (a slot refused): show its week.
  if (shownDate !== date) {
    setShownDate(date);
    setPage(Math.floor(index / WEEK));
  }
  const pages = Math.ceil(days.length / WEEK);
  const week = days.slice(page * WEEK, page * WEEK + WEEK);
  const nextDay = days[index + 1];

  if (!service) return null;
  return (
    <section aria-labelledby="booking-slot" className="flex flex-col gap-5">
      <div id="booking-slot">
        <StepHeading step={2} total={4} headingRef={headingRef}>
          Choisissez un créneau
        </StepHeading>
      </div>

      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-paper-raised px-4 py-3">
        <p className="text-[15px] font-semibold wrap-anywhere text-ink">
          {service.name}
        </p>
        <p className="text-[14px] text-ink-soft">
          {serviceLine(
            service.durationMinutes,
            service.priceCents,
            service.currency,
          )}
        </p>
        <button
          type="button"
          className={cn(linkAction, "mt-1 self-start")}
          onClick={() => flow.actions.goTo("service")}
        >
          Changer de prestation
        </button>
      </div>

      {notice === "slot_unavailable" ? (
        <Notice tone="warning" title="Ce créneau n’est plus disponible">
          Il vient d’être réservé ou n’est plus proposé. Les créneaux ont été
          mis à jour : choisissez-en un autre, vos coordonnées sont conservées.
        </Notice>
      ) : null}

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-3 text-[15px] font-medium text-ink">Jour</legend>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage((value) => Math.max(0, value - 1))}
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
            onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}
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
                onClick={() => flow.actions.chooseDate(day)}
                aria-pressed={selected}
                aria-label={dayLabel(day)}
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
                <span className="text-[11.5px] opacity-80">{parts.month}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3">
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
          <div className="flex flex-col items-start gap-2 rounded-2xl border border-line bg-paper-raised px-4 py-4">
            <p className="text-[14.5px] text-ink-soft">
              Aucun créneau disponible ce jour-là.
            </p>
            {nextDay ? (
              <button
                type="button"
                className={linkAction}
                onClick={() => flow.actions.chooseDate(nextDay)}
              >
                Voir le {dayLabel(nextDay)}
              </button>
            ) : null}
          </div>
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
    </section>
  );
}
