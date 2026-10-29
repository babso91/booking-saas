"use client";

import { useEffect, useMemo, useRef } from "react";

import { formatDuration, timeOf } from "@/features/agenda/client/dates";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import { zoneOf } from "@/features/agenda/client/zone";
import { blockLabel } from "@/features/agenda/components/time-grid";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import { dayFlow, type FlowItem, type FlowVisit } from "./day-flow";
import { hatch, visitLookOf, visitLooks } from "./visit-look";

// The Studio day: her visits in order, taller when longer, overlaps side by
// side, pauses and closures where they fall, free time offered when it is
// still ahead, "now" where it is. One hand, one column: every visit is a
// big target that opens its existing card; every free stretch ahead is a
// target that opens the existing form at that time.

type Props = {
  data: AgendaDto | null;
  date: string;
  nowMs: number | null;
  /** Roomier cards (computer). */
  roomy?: boolean;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
};

const MINUTE = 60_000;
const minutesUntil = (at: number, now: number) =>
  Math.max(0, Math.ceil((at - now) / MINUTE));

/** Height grows with length: 30 min ≈ 76 px, 4 h capped. */
const heightOf = (minutes: number, roomy: boolean) =>
  Math.round(
    Math.min(roomy ? 280 : 240, Math.max(roomy ? 84 : 76, 52 + minutes * 0.8)),
  );

export function StudioDayFlow({
  data,
  date,
  nowMs,
  roomy = false,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: Props) {
  const flow = useMemo(
    () => (data ? dayFlow(data, date, nowMs) : null),
    [data, date, nowMs],
  );
  const zone = useMemo(() => (data ? zoneOf(data) : null), [data]);

  // Today: open on what matters now (the slot going on, "now", or the
  // next visit), once per day shown — never again under her fingers.
  const list = useRef<HTMLOListElement>(null);
  const focusedDate = useRef<string | null>(null);
  useEffect(() => {
    if (!flow || focusedDate.current === date) return;
    const target = list.current?.querySelector("[data-focus]");
    if (!target) return;
    focusedDate.current = date;
    target.scrollIntoView?.({ block: "center" });
  }, [flow, date]);

  if (!flow) return null;

  const hasVisits = flow.items.some((item) => item.kind === "visits");

  return (
    <ol
      ref={list}
      aria-label="Déroulé de la journée"
      className={cn("flex flex-col gap-2", roomy && "gap-2.5")}
    >
      {flow.closed && !hasVisits ? (
        <li className={cn("rounded-[18px] bg-sand px-4 py-5", hatch)}>
          <p className="font-expanded text-[17px] font-extrabold text-ink">
            Fermé
          </p>
          <p className="text-[14px] text-ink-soft">
            Aucune ouverture ce jour-là.
          </p>
        </li>
      ) : null}
      {flow.items.map((item) => (
        <Row
          key={keyOf(item)}
          item={item}
          flow={flow}
          date={date}
          nowMs={nowMs}
          roomy={roomy}
          zone={zone}
          onOpenAppointment={onOpenAppointment}
          onOpenBlock={onOpenBlock}
          onCreateAt={onCreateAt}
        />
      ))}
    </ol>
  );
}

const keyOf = (item: FlowItem) =>
  item.kind === "visits"
    ? `v:${item.visits.map((visit) => visit.appointment.id).join(",")}`
    : item.kind === "block"
      ? `b:${item.block.id}`
      : `${item.kind}:${item.start}`;

function Row({
  item,
  flow,
  date,
  nowMs,
  roomy,
  zone,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: {
  item: FlowItem;
  flow: ReturnType<typeof dayFlow>;
  date: string;
  nowMs: number | null;
  roomy: boolean;
  zone: ReturnType<typeof zoneOf> | null;
  onOpenAppointment: Props["onOpenAppointment"];
  onOpenBlock: Props["onOpenBlock"];
  onCreateAt: Props["onCreateAt"];
}) {
  if (item.kind === "now") {
    return (
      <li
        data-focus=""
        className="relative flex items-center gap-2 py-1"
        aria-label={`Il est ${item.time}`}
      >
        <span className="rounded-full bg-signature px-2.5 py-0.5 text-[12.5px] font-extrabold text-on-signature tabular-nums">
          {item.time}
        </span>
        <span
          aria-hidden="true"
          className="h-[3px] flex-1 rounded-full bg-signature"
        />
      </li>
    );
  }

  if (item.kind === "free") {
    const label = `Libre · ${formatDuration(item.minutes)}`;
    return item.bookable ? (
      <li>
        <button
          type="button"
          onClick={() => onCreateAt(date, item.time)}
          aria-label={`${label} à partir de ${item.time} : nouveau rendez-vous`}
          className="group flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[16px] border-[1.5px] border-dashed border-line-strong px-4 text-left text-[14px] font-bold text-ink-soft transition-colors hover:border-ink hover:bg-paper-raised hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature"
        >
          <span className="w-12 shrink-0 tabular-nums">{item.time}</span>
          <span className="flex-1">{label}</span>
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-full bg-ink text-[18px] leading-none text-paper transition-transform group-hover:scale-105"
          >
            +
          </span>
        </button>
      </li>
    ) : (
      <li className="px-4 py-1 text-[13px] text-ink-soft">
        <span className="inline-block w-12 tabular-nums">{item.time}</span>
        {label}
      </li>
    );
  }

  if (item.kind === "block") {
    const { block } = item;
    return (
      <li>
        <button
          type="button"
          onClick={() => onOpenBlock(block)}
          className={cn(
            "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[16px] bg-sand px-4 py-2 text-left text-[14px] font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature",
            hatch,
          )}
        >
          <span className="w-12 shrink-0 text-ink-soft tabular-nums">
            {item.startsBefore ? "veille" : timeOf(block.localStartsAt)}
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {blockLabel(block)}
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-ink-soft tabular-nums">
            → {item.endsAfter ? "lendemain" : timeOf(block.localEndsAt)}
          </span>
        </button>
      </li>
    );
  }

  const { visits } = item;
  const together = visits.length > 1;
  const sideBySide = together && visits.length <= (roomy ? 3 : 2);
  return (
    <li className="flex flex-col gap-1.5">
      {together ? (
        <p className="font-expanded px-1 text-[11.5px] font-bold tracking-[0.08em] text-ink-soft uppercase">
          En même temps · {visits.length}
        </p>
      ) : null}
      <div
        className={cn(
          "grid gap-2",
          sideBySide && (visits.length === 2 ? "grid-cols-2" : "grid-cols-3"),
        )}
      >
        {visits.map((visit) => (
          <VisitCard
            key={visit.appointment.id}
            visit={visit}
            isNext={flow.next?.appointment.id === visit.appointment.id}
            nowMs={nowMs}
            roomy={roomy}
            compact={sideBySide}
            zone={zone}
            onOpen={() => onOpenAppointment(visit.appointment)}
          />
        ))}
      </div>
    </li>
  );
}

function VisitCard({
  visit,
  isNext,
  nowMs,
  roomy,
  compact,
  zone,
  onOpen,
}: {
  visit: FlowVisit;
  isNext: boolean;
  nowMs: number | null;
  roomy: boolean;
  compact: boolean;
  zone: ReturnType<typeof zoneOf> | null;
  onOpen: () => void;
}) {
  const { appointment } = visit;
  const lookId = visitLookOf(appointment, nowMs);
  const look = visitLooks[lookId];
  const start = timeWithOccurrence(
    timeOf(appointment.localStartsAt),
    appointment.startOccurrence,
    appointment.localStartsAt.slice(0, 10),
    zone,
  );
  const end = timeOf(appointment.localEndsAt);
  const minutes = Math.round((visit.end - visit.start) / MINUTE);
  // What is behind her stays readable but compact; ahead, length shows.
  const behind = lookId !== "now" && lookId !== "ahead";
  const height = behind ? 0 : heightOf(minutes, roomy);
  const hasNote = Boolean(appointment.internalNotes?.trim());
  const progress =
    lookId === "now" && nowMs !== null
      ? Math.min(
          1,
          (nowMs - visit.start) / Math.max(1, visit.end - visit.start),
        )
      : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-focus={lookId === "now" || isNext ? "" : undefined}
      aria-label={`${start} à ${end}, ${appointment.client.displayName}, ${appointment.service.name}, ${look.label}${isNext ? ", prochain rendez-vous" : ""}`}
      className={cn(
        "relative flex w-full cursor-pointer flex-col justify-between gap-2 overflow-hidden rounded-[18px] p-3.5 text-left transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[0_14px_28px_-16px_rgb(var(--shadow-rgb)/0.6)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature active:translate-y-0 motion-reduce:transition-none",
        roomy && "p-4",
        behind && "gap-1.5 py-3",
        look.className,
        isNext && "ring-[3px] ring-signature ring-offset-2 ring-offset-paper",
      )}
      style={{ minHeight: height }}
    >
      <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <span className="font-condensed text-[30px] leading-[0.85] font-black tabular-nums">
          {start}
        </span>
        <span className="font-expanded ml-auto text-right text-[11px] leading-tight font-bold tracking-[0.06em] uppercase">
          {isNext && nowMs !== null
            ? `Prochain · dans ${formatDuration(minutesUntil(visit.start, nowMs))}`
            : look.label}
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          data-name=""
          className={cn(
            "font-expanded leading-tight font-extrabold [overflow-wrap:anywhere]",
            compact ? "text-[15px]" : "text-[19px]",
            roomy && !compact && "text-[22px]",
          )}
        >
          {appointment.client.displayName}
        </span>
        <span className="truncate text-[14px] opacity-90">
          {appointment.service.name}
        </span>
        <span className="text-[13px] font-semibold tabular-nums">
          {formatDuration(minutes)}
          {visit.endsAfter ? "" : ` · jusqu’à ${end}`}
          {appointment.source === "public" ? " · en ligne" : ""}
          {hasNote ? " · note" : ""}
        </span>
        {visit.startsBefore || visit.endsAfter ? (
          <span className="text-[13px] font-bold">
            {visit.startsBefore ? `depuis hier ${start}` : null}
            {visit.startsBefore && visit.endsAfter ? " · " : null}
            {visit.endsAfter ? `jusqu’à demain ${end}` : null}
          </span>
        ) : null}
      </span>

      {progress !== null ? (
        <span className="flex flex-col gap-1">
          <span
            role="progressbar"
            aria-label="Avancement théorique du créneau"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuetext={`fin prévue dans ${formatDuration(minutesUntil(visit.end, nowMs!))}`}
            className="h-1.5 overflow-hidden rounded-full bg-on-signature/25"
          >
            <span
              className="block h-full rounded-full bg-on-signature"
              style={{ width: `${progress * 100}%` }}
            />
          </span>
          <span className="text-[12.5px] font-semibold">
            fin prévue dans {formatDuration(minutesUntil(visit.end, nowMs!))}
          </span>
        </span>
      ) : null}
    </button>
  );
}
