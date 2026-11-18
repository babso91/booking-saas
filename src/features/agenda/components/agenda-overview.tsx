"use client";

import { Button } from "@/components/ui/button";
import { CalendarGrid } from "@/components/ui/calendar-grid";
import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { dayFlow } from "@/features/dashboard/agenda/day-flow";
import { cn } from "@/lib/cn";

import {
  dayNumber,
  formatFullDate,
  periodLabel,
  timeOf,
  type VisibleRange,
} from "../client/dates";

export function AgendaOverview({
  view,
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
  view: "month" | "week";
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
  const flows =
    data &&
    new Map(range.days.map((date) => [date, dayFlow(data, date, null)]));
  const flow = flows?.get(selected);
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6"
      aria-label="Calendrier de l’agenda"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 py-4">
        <header className="flex items-center justify-between gap-2">
          <Button
            size="md"
            variant="secondary"
            aria-label={
              view === "month" ? "Mois précédent" : "Semaine précédente"
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
            aria-label={view === "month" ? "Mois suivant" : "Semaine suivante"}
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
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(event) => onIncludeCancelled(event.target.checked)}
            />
            Afficher les rendez-vous annulés
          </label>
        </div>
        {loading ? (
          <p role="status" className="text-sm text-ink-muted">
            Chargement de l’agenda…
          </p>
        ) : null}
        <CalendarGrid days={range.days}>
          {(day) => {
            const summary = flows?.get(day);
            const visits =
              summary?.items.flatMap((item) =>
                item.kind === "visits" ? item.visits : [],
              ) ?? [];
            const free = summary?.items.find((item) => item.kind === "free");
            return (
              <button
                type="button"
                aria-pressed={selected === day}
                aria-label={
                  formatFullDate(day) +
                  (summary
                    ? `, ${visits.length} rendez-vous, ${free?.kind === "free" ? "libre dès " + free.time : "aucune plage libre"}`
                    : "")
                }
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
                  <span className="text-[10px] text-ink-muted">
                    {free.time}
                  </span>
                ) : summary ? (
                  <span className="text-ink-muted">—</span>
                ) : null}
              </button>
            );
          }}
        </CalendarGrid>
        <p className="text-xs text-ink-muted">
          RDV = rendez-vous. L’heure indique le début de la première plage
          libre.
        </p>
        {flow ? (
          <div className="rounded-xl border border-line bg-paper-raised p-4">
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
                          Libre dès {item.time} · {item.minutes} min
                        </li>,
                      ]
                    : item.kind === "block"
                      ? [
                          <li key={item.block.id}>
                            {item.block.reason || "Créneau bloqué"}
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
