"use client";

import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

/**
 * What the agenda says first (art direction: one hero datum per screen).
 * On a range holding today: the visit in progress or the next one, its time
 * large, and how many visits today. On any other range: how many visits it
 * holds. Cancelled visits never count. Display only, from the data already
 * read; `nowMs` is the agenda's clock (null while unknown: nothing is said
 * about "next").
 */
export type Pulse =
  | {
      kind: "today";
      count: number;
      left: number;
      focus: { appointment: AgendaAppointmentDto; ongoing: boolean } | null;
    }
  | { kind: "range"; count: number };

export function agendaPulse(
  data: AgendaDto,
  days: string[],
  today: string | null,
  nowMs: number | null,
): Pulse {
  const live = data.appointments
    .filter((appointment) => appointment.status !== "cancelled")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  if (today === null || !days.includes(today) || nowMs === null)
    return { kind: "range", count: live.length };

  const todays = live.filter((a) => a.localStartsAt.slice(0, 10) === today);
  const ongoing = todays.find(
    (a) => Date.parse(a.startsAt) <= nowMs && nowMs < Date.parse(a.endsAt),
  );
  const upcoming = todays.filter((a) => Date.parse(a.startsAt) > nowMs);
  const next = ongoing ?? upcoming[0];
  return {
    kind: "today",
    count: todays.length,
    // Visits still to start after the one shown.
    left: next ? upcoming.length - (next === ongoing ? 0 : 1) : 0,
    focus: next ? { appointment: next, ongoing: next === ongoing } : null,
  };
}

const hour = (local: string) => local.slice(11, 16).replace(":", "h");
const visits = (n: number) => `${n} rendez-vous`;

export function AgendaPulse({
  pulse,
  view,
  onOpen,
}: {
  pulse: Pulse;
  view: "day" | "week";
  onOpen: (appointment: AgendaAppointmentDto) => void;
}) {
  if (pulse.kind === "range") {
    if (pulse.count === 0) return null;
    return (
      <p className="flex items-baseline gap-2.5 text-ink-soft">
        <span className="text-[32px] leading-none font-bold tracking-[-0.03em] text-ink tabular-nums">
          {pulse.count}
        </span>
        <span className="text-[15px]">
          rendez-vous {view === "week" ? "cette semaine" : "ce jour-là"}
        </span>
      </p>
    );
  }

  const { focus } = pulse;
  if (!focus)
    return pulse.count === 0 ? null : (
      <p className="text-[15px] text-ink-soft">
        <span className="font-semibold text-ink">Plus rien aujourd’hui</span>
        {" · "}
        {visits(pulse.count)} dans la journée
      </p>
    );

  const { appointment, ongoing } = focus;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <button
        type="button"
        onClick={() => onOpen(appointment)}
        className="group flex min-w-0 cursor-pointer items-end gap-4 rounded-lg text-left transition-transform duration-150 ease-soft focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent active:scale-[0.98]"
      >
        <span className="text-[44px] leading-[0.85] font-bold tracking-[-0.035em] text-ink tabular-nums sm:text-[52px]">
          {hour(appointment.localStartsAt)}
        </span>
        <span className="flex min-w-0 flex-col pb-0.5">
          <span className="text-[13px] font-medium text-ink-muted">
            {ongoing
              ? `En cours, jusqu’à ${hour(appointment.localEndsAt)}`
              : "Prochain rendez-vous"}
          </span>
          <span className="truncate text-[16px] font-semibold text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">
            {appointment.client.displayName}
            <span className="font-normal text-ink-soft">
              {" · "}
              {appointment.service.name}
            </span>
          </span>
        </span>
      </button>
      <p className="pb-0.5 text-[14px] text-ink-soft tabular-nums">
        {pulse.left === 0
          ? "Le dernier de la journée"
          : `Encore ${pulse.left} après · ${visits(pulse.count)} aujourd’hui`}
      </p>
    </div>
  );
}
