"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { CalendarGrid } from "@/components/ui/calendar-grid";
import type {
  AgendaAppointmentDto,
  AgendaDto,
  AgendaBlockDto,
} from "@/features/agenda/data/agenda";
import { dayFlow } from "@/features/dashboard/agenda/day-flow";
import type { AgendaFormat } from "../formats";
import { TimeGrid } from "./time-grid";
import { ServiceOpenings } from "./service-openings";
import { cn } from "@/lib/cn";

import {
  dayNumber,
  formatDuration,
  formatFullDate,
  periodLabel,
  timeOf,
  type VisibleRange,
} from "../client/dates";

export function AgendaOverview({
  view,
  format,
  slug,
  nowMs,
  today,
  onNewBlock,
  onOpenBlock,
  onCreateAt,
  onDayView,
  range,
  selected,
  data,
  loading,
  includeCancelled,
  onIncludeCancelled,
  onSelect,
  onShift,
  onOpen,
  onToday,
  onNew,
}: {
  view: "day" | "month" | "week";
  format: AgendaFormat;
  slug?: string;
  nowMs: number | null;
  today: string | null;
  onNewBlock: () => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
  onDayView: (date: string) => void;
  range: VisibleRange;
  selected: string;
  data: AgendaDto | null;
  loading: boolean;
  includeCancelled: boolean;
  onIncludeCancelled: (include: boolean) => void;
  onSelect: (day: string) => void;
  onShift: (direction: -1 | 1) => void;
  onOpen: (appointment: AgendaAppointmentDto) => void;
  onToday: () => void;
  onNew: () => void;
}) {
  const { startDate, endDate } = range;
  const flows = useMemo(() => {
    if (!data || (format === "salon" && view !== "month")) return null;
    return new Map(
      data.workingHours.days
        .filter((day) => day.date >= startDate && day.date <= endDate)
        .map(({ date }) => [
          date,
          dayFlow(data, date, format === "classic" ? null : nowMs),
        ]),
    );
  }, [data, format, view, nowMs, startDate, endDate]);
  const calendar = format === "classic" || format === "visual";
  const flow = flows?.get(selected);
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6"
      aria-label="Calendrier de l’agenda"
      data-agenda-format={format}
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 py-4">
        <header className="flex items-center justify-between gap-2">
          <Button
            size="md"
            variant="secondary"
            aria-label={
              view === "month"
                ? "Mois précédent"
                : view === "week"
                  ? "Semaine précédente"
                  : "Jour précédent"
            }
            onClick={() => onShift(-1)}
          >
            ‹
          </Button>
          <h1
            className="text-center font-display text-2xl capitalize text-ink"
            aria-live="polite"
          >
            {periodLabel(view, range)}
          </h1>
          <Button
            size="md"
            variant="secondary"
            aria-label={
              view === "month"
                ? "Mois suivant"
                : view === "week"
                  ? "Semaine suivante"
                  : "Jour suivant"
            }
            onClick={() => onShift(1)}
          >
            ›
          </Button>
        </header>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="md" variant="secondary" onClick={onToday}>
            Aujourd’hui
          </Button>
          <Button size="md" onClick={onNew}>
            Nouveau rendez-vous
          </Button>
          {format !== "classic" ? (
            <Button size="md" variant="secondary" onClick={onNewBlock}>
              Bloquer un créneau
            </Button>
          ) : null}
          {format === "availability" ? (
            <Link
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
              href="/app/settings/hours"
            >
              Modifier mes horaires
            </Link>
          ) : null}
          {format !== "availability" ? (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={includeCancelled}
                onChange={(event) => onIncludeCancelled(event.target.checked)}
              />
              Afficher les rendez-vous annulés
            </label>
          ) : null}
        </div>
        {loading ? (
          <p role="status" className="text-sm text-ink-muted">
            Chargement de l’agenda…
          </p>
        ) : null}
        {format === "availability" && slug ? (
          <ServiceOpenings
            slug={slug}
            flows={flows}
            range={range}
            data={data}
          />
        ) : null}
        {format === "salon" && view !== "month" ? (
          <div className="flex h-[68dvh] min-h-80 flex-col overflow-auto rounded-xl border border-line bg-paper-raised glass-surface">
            <TimeGrid
              days={range.days}
              data={data}
              today={today}
              nowMs={nowMs}
              hourHeight={view === "day" ? 72 : 60}
              onOpenAppointment={onOpen}
              onOpenBlock={onOpenBlock}
              onCreateAt={onCreateAt}
            />
          </div>
        ) : null}
        {format === "salon" && view === "month" && flows ? (
          <div className="divide-y divide-line rounded-2xl border border-line bg-paper-raised px-4 glass-surface">
            {range.days.map((date) => {
              const day = flows.get(date);
              const visits =
                day?.items.flatMap((item) =>
                  item.kind === "visits" ? item.visits : [],
                ) ?? [];
              return (
                <section
                  key={date}
                  className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]"
                >
                  <h2>
                    <button
                      type="button"
                      className="min-h-11 text-left text-sm font-semibold capitalize text-ink underline decoration-line-strong underline-offset-4"
                      onClick={() => onDayView(date)}
                    >
                      {formatFullDate(date)}
                    </button>
                  </h2>
                  <div>
                    {visits.length ? (
                      visits.map(({ appointment }) => (
                        <button
                          type="button"
                          key={appointment.id}
                          onClick={() => onOpen(appointment)}
                          className="flex min-h-11 w-full flex-wrap items-baseline gap-x-3 py-2 text-left text-sm text-ink"
                        >
                          <strong className="tabular-nums">
                            {timeOf(appointment.localStartsAt)}
                          </strong>
                          <span>
                            {appointment.client.displayName} ·{" "}
                            {appointment.service.name}
                          </span>
                          <span className="text-ink-muted">
                            {formatDuration(appointment.durationMinutes)}
                            {appointment.status === "cancelled"
                              ? " · Annulé"
                              : ""}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="py-3 text-sm text-ink-muted">
                        {day?.closed ? "Fermé" : "Aucun rendez-vous"}
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
        {calendar && view !== "day" ? (
          <CalendarGrid days={range.days}>
            {(day) => {
              const summary = flows?.get(day);
              const visits =
                summary?.items.flatMap((item) =>
                  item.kind === "visits" ? item.visits : [],
                ) ?? [];
              const openings =
                summary?.items.filter((item) => item.kind === "free") ?? [];
              const free = openings[0];
              return (
                <button
                  type="button"
                  aria-pressed={selected === day}
                  onClick={() => onSelect(day)}
                  className={cn(
                    "flex min-h-16 w-full flex-col items-center gap-0.5 rounded-lg border p-0.5 text-xs",
                    selected === day
                      ? "border-ink bg-sand text-ink"
                      : "border-line bg-paper-raised text-ink",
                  )}
                >
                  <span className="font-semibold">{dayNumber(day)}</span>
                  {visits.length ? (
                    <span className="text-[10px] font-medium">
                      {visits.length} RDV
                    </span>
                  ) : null}
                  {free?.kind === "free" ? (
                    <span className="flex flex-col text-[10px] text-ink-soft">
                      {free.time}
                      {format === "visual" && openings[1] ? (
                        <span>{openings[1].time}</span>
                      ) : null}
                      {format === "visual" && openings.length > 2 ? (
                        <span>+{openings.length - 2}</span>
                      ) : null}
                    </span>
                  ) : summary ? (
                    <span className="text-ink-muted">
                      {format === "visual" && summary.closed ? "Fermé" : "—"}
                    </span>
                  ) : null}
                  <span className="sr-only">
                    {formatFullDate(day) +
                      (summary
                        ? `, ${visits.length} rendez-vous, ${free?.kind === "free" ? "libre dès " + free.time : "aucune plage libre"}`
                        : "")}
                  </span>
                </button>
              );
            }}
          </CalendarGrid>
        ) : null}
        {calendar && view !== "day" ? (
          <p className="text-xs text-ink-muted">
            {format === "visual"
              ? "Les heures indiquent le début des plages libres. Choisis une date pour voir le détail."
              : "RDV = rendez-vous. L’heure indique le début de la première plage libre."}
          </p>
        ) : null}
        {calendar && flow ? (
          <div className="rounded-xl border border-line bg-paper-raised p-4 glass-surface">
            <h2 className="mb-2 font-semibold capitalize text-ink">
              {formatFullDate(selected)}
            </h2>
            {flow.items.length === 0 ? (
              <p className="text-sm text-ink-muted">
                Aucun rendez-vous ni plage libre.
              </p>
            ) : null}
            <ul className="flex flex-col gap-2 text-sm text-ink">
              {flow.items.flatMap((item) =>
                item.kind === "visits"
                  ? item.visits.map(({ appointment }) => (
                      <li key={appointment.id}>
                        <button
                          type="button"
                          className="min-h-11 text-left underline"
                          onClick={() => onOpen(appointment)}
                        >
                          {timeOf(appointment.localStartsAt)} ·{" "}
                          {appointment.client.displayName} ·{" "}
                          {appointment.service.name}
                          {appointment.status === "cancelled"
                            ? " · Annulé"
                            : ""}
                        </button>
                      </li>
                    ))
                  : item.kind === "free"
                    ? [
                        <li key={item.start}>
                          {format === "visual" && item.ahead ? (
                            <button
                              type="button"
                              className="min-h-11 text-left underline"
                              onClick={() => onCreateAt(selected, item.time)}
                            >
                              Libre dès {item.time} ·{" "}
                              {formatDuration(item.minutes)}
                            </button>
                          ) : (
                            <>
                              Libre dès {item.time} ·{" "}
                              {formatDuration(item.minutes)}
                            </>
                          )}
                        </li>,
                      ]
                    : item.kind === "block"
                      ? [
                          <li key={item.block.id}>
                            <button
                              type="button"
                              onClick={() => onOpenBlock(item.block)}
                              className="min-h-11 text-left underline"
                            >
                              {item.block.reason || "Créneau bloqué"}
                            </button>
                          </li>,
                        ]
                      : [],
              )}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
