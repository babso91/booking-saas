"use client";

import { useMemo } from "react";

import { formatDuration, timeOf } from "@/features/agenda/client/dates";
import { blockLabel } from "@/features/agenda/components/time-grid";
import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

import { dayFlow } from "./day-flow";

// Beside the day, on a computer: what the day holds, at a glance. Only
// what the agenda read says: visits (not cancelled), the time they take,
// the free time still bookable, the next one, her pauses and closures.

const MINUTE = 60_000;

export function StudioDaySummary({
  data,
  date,
  nowMs,
  onOpenAppointment,
}: {
  data: AgendaDto | null;
  date: string;
  nowMs: number | null;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
}) {
  const flow = useMemo(
    () => (data ? dayFlow(data, date, nowMs) : null),
    [data, date, nowMs],
  );
  if (!flow) return null;

  const visits = flow.items.flatMap((item) =>
    item.kind === "visits"
      ? item.visits.filter((visit) => visit.appointment.status !== "cancelled")
      : [],
  );
  const booked = visits.reduce(
    (total, visit) =>
      total +
      (Math.min(visit.end, flow.bounds.end) -
        Math.max(visit.start, flow.bounds.start)) /
        MINUTE,
    0,
  );
  const free = flow.items.reduce(
    (total, item) =>
      item.kind === "free" && item.bookable ? total + item.minutes : total,
    0,
  );
  const held = flow.items.flatMap((item) =>
    item.kind === "block" ? [item.block] : [],
  );

  return (
    <aside
      aria-label="La journée en bref"
      className="flex flex-col gap-5 rounded-[24px] bg-paper-raised p-6 shadow-[0_0_0_1px_var(--line)]"
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Figure label="Rendez-vous" value={String(visits.length)} />
        <Figure label="Réservé" value={formatDuration(Math.round(booked))} />
        <Figure
          label={nowMs !== null && flow.next ? "Libre, à venir" : "Libre"}
          value={formatDuration(free)}
        />
        <Figure label="Statut" value={flow.closed ? "Fermé" : "Ouvert"} />
      </dl>

      {flow.next ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="font-expanded text-[11.5px] font-bold tracking-[0.08em] text-ink-soft uppercase">
            Prochain
          </span>
          <button
            type="button"
            onClick={() => onOpenAppointment(flow.next!.appointment)}
            className="flex cursor-pointer flex-col items-start rounded-[14px] text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="font-condensed text-[34px] leading-none font-black text-accent tabular-nums">
              {timeOf(flow.next.appointment.localStartsAt)}
            </span>
            <span className="font-expanded text-[17px] leading-tight font-extrabold text-ink [overflow-wrap:anywhere]">
              {flow.next.appointment.client.displayName}
            </span>
            <span className="text-[14px] text-ink-soft">
              {flow.next.appointment.service.name}
            </span>
          </button>
        </div>
      ) : null}

      {held.length ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="font-expanded text-[11.5px] font-bold tracking-[0.08em] text-ink-soft uppercase">
            Temps bloqué
          </span>
          <ul className="flex flex-col gap-1 text-[14px] text-ink">
            {held.map((block) => (
              <li key={block.id} className="[overflow-wrap:anywhere]">
                <span className="font-bold tabular-nums">
                  {timeOf(block.localStartsAt)}–{timeOf(block.localEndsAt)}
                </span>{" "}
                {blockLabel(block)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-expanded text-[11px] font-bold tracking-[0.08em] text-ink-soft uppercase">
        {label}
      </dt>
      <dd className="font-condensed text-[34px] leading-none font-black text-ink tabular-nums">
        {value}
      </dd>
    </div>
  );
}
