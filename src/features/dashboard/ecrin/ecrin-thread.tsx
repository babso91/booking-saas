"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";

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

import { dayFlow, type FlowItem, type FlowVisit } from "../agenda/day-flow";
import { hatch, visitLookOf } from "../agenda/visit-look";
import { ecrinLookClass, ecrinLookLabel } from "./looks";

// The Écrin day: a thread of pearls. Each thing of the day is a pearl on one
// vertical thread, its hour beside it: filled for a visit, hollow for free
// time, a jewel for now. Same model as every style (dayFlow): nothing
// invented; visits open the agenda's card, free time ahead its form.

type Props = {
  data: AgendaDto | null;
  date: string;
  nowMs: number | null;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
};

const MINUTE = 60_000;
const minutesUntil = (at: number, now: number) =>
  Math.max(0, Math.ceil((at - now) / MINUTE));

export function EcrinThread({
  data,
  date,
  nowMs,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: Props) {
  const flow = useMemo(
    () => (data ? dayFlow(data, date, nowMs) : null),
    [data, date, nowMs],
  );
  const zone = useMemo(() => (data ? zoneOf(data) : null), [data]);

  // Today: open on what matters now, once per day shown.
  const list = useRef<HTMLOListElement>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!flow || focused.current === date) return;
    const target = list.current?.querySelector("[data-focus]");
    if (!target) return;
    focused.current = date;
    target.scrollIntoView?.({ block: "center" });
  }, [flow, date]);

  if (!flow) return null;
  const hasVisits = flow.items.some((item) => item.kind === "visits");

  return (
    <ol
      ref={list}
      aria-label="Déroulé de la journée"
      className="relative flex flex-col gap-2.5 before:absolute before:top-3 before:bottom-3 before:left-[61px] before:w-px before:bg-line-strong"
    >
      {flow.closed && !hasVisits ? (
        <Row hour="" pearl="hollow">
          <p className={cn("rounded-[22px] bg-sand px-5 py-4", hatch)}>
            <span className="font-engraved block text-[18px] text-ink">
              Fermé
            </span>
            <span className="text-[14px] text-ink">
              Aucune ouverture ce jour-là.
            </span>
          </p>
        </Row>
      ) : null}
      {flow.items.map((item) => (
        <Item
          key={keyOf(item)}
          item={item}
          next={flow.next}
          date={date}
          nowMs={nowMs}
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

/** One place on the thread: the hour, its pearl, what is there. */
function Row({
  hour,
  pearl,
  focus,
  children,
  label,
}: {
  hour: string;
  pearl: "full" | "hollow" | "held" | "jewel" | "stone";
  focus?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <li
      data-focus={focus ? "" : undefined}
      aria-label={label}
      className="relative grid grid-cols-[46px_30px_minmax(0,1fr)] items-start"
    >
      <span className="pt-3.5 text-right text-[13.5px] text-ink-soft tabular-nums">
        {hour}
      </span>
      <span
        className="relative flex justify-center pt-[17px]"
        aria-hidden="true"
      >
        <span
          className={cn(
            "relative z-[1] block rounded-full",
            pearl === "full" && "size-3 bg-ink",
            pearl === "stone" &&
              "size-4 -translate-y-0.5 bg-accent ring-4 ring-accent-soft",
            pearl === "jewel" &&
              "size-3.5 bg-accent ring-[3px] ring-paper-raised",
            pearl === "hollow" &&
              "size-2.5 translate-y-0.5 border-[1.5px] border-line-strong bg-paper",
            pearl === "held" && "size-1.5 translate-y-1 bg-ink-muted",
          )}
        />
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function Item({
  item,
  next,
  date,
  nowMs,
  zone,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: {
  item: FlowItem;
  next: FlowVisit | null;
  date: string;
  nowMs: number | null;
  zone: ReturnType<typeof zoneOf> | null;
} & Pick<Props, "onOpenAppointment" | "onOpenBlock" | "onCreateAt">) {
  if (item.kind === "now")
    return (
      <Row hour={item.time} pearl="jewel" focus label={`Il est ${item.time}`}>
        <span
          aria-hidden="true"
          className="mt-[22px] block h-0.5 rounded-full bg-accent"
        />
      </Row>
    );

  if (item.kind === "free") {
    const label = `Libre · ${formatDuration(item.minutes)}`;
    return (
      <Row hour={item.time} pearl="hollow">
        {item.bookable ? (
          <button
            type="button"
            onClick={() => onCreateAt(date, item.time)}
            aria-label={`${label} à partir de ${item.time} : nouveau rendez-vous`}
            className="group flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 rounded-[22px] px-4 text-left text-[14.5px] text-ink-soft transition-colors hover:bg-paper-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {label}
            <span
              aria-hidden="true"
              className="ecrin-object grid size-9 place-items-center rounded-full text-[18px] leading-none text-ink transition-transform group-hover:scale-105"
            >
              +
            </span>
          </button>
        ) : (
          <p className="px-4 pt-3 text-[13.5px] text-ink-soft">{label}</p>
        )}
      </Row>
    );
  }

  if (item.kind === "block") {
    const { block } = item;
    return (
      <Row
        hour={item.startsBefore ? "veille" : timeOf(block.localStartsAt)}
        pearl="held"
      >
        <button
          type="button"
          onClick={() => onOpenBlock(block)}
          className={cn(
            "ecrin-press flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 rounded-[22px] bg-sand px-4 py-2 text-left text-[14.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            hatch,
          )}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {blockLabel(block)}
          </span>
          <span className="shrink-0 text-[13px] tabular-nums">
            → {item.endsAfter ? "lendemain" : timeOf(block.localEndsAt)}
          </span>
        </button>
      </Row>
    );
  }

  const { visits } = item;
  // What is shown as going on: a cancelled or completed visit is not.
  const going = visits.some(
    (visit) => visitLookOf(visit.appointment, nowMs) === "now",
  );
  const isNext = visits.some(
    (visit) => visit.appointment.id === next?.appointment.id,
  );
  const allBehind = visits.every((visit) => visit.timing === "past");
  return (
    <Row
      hour={
        visits[0]!.startsBefore
          ? "veille"
          : timeOf(visits[0]!.appointment.localStartsAt)
      }
      pearl={going ? "stone" : allBehind ? "hollow" : "full"}
      focus={going || isNext}
    >
      <div className="flex flex-col gap-2">
        {visits.length > 1 ? (
          <p className="font-engraved px-1 pt-1 text-[11.5px] tracking-[0.16em] text-ink-soft uppercase">
            En même temps · {visits.length}
          </p>
        ) : null}
        {visits.map((visit) => (
          <VisitCapsule
            key={visit.appointment.id}
            visit={visit}
            isNext={next?.appointment.id === visit.appointment.id}
            nowMs={nowMs}
            zone={zone}
            onOpen={() => onOpenAppointment(visit.appointment)}
          />
        ))}
      </div>
    </Row>
  );
}

function VisitCapsule({
  visit,
  isNext,
  nowMs,
  zone,
  onOpen,
}: {
  visit: FlowVisit;
  isNext: boolean;
  nowMs: number | null;
  zone: ReturnType<typeof zoneOf> | null;
  onOpen: () => void;
}) {
  const { appointment } = visit;
  const lookId = visitLookOf(appointment, nowMs);
  const start = timeWithOccurrence(
    timeOf(appointment.localStartsAt),
    appointment.startOccurrence,
    appointment.localStartsAt.slice(0, 10),
    zone,
  );
  const end = timeOf(appointment.localEndsAt);
  const minutes = Math.round((visit.end - visit.start) / MINUTE);
  const behind = lookId !== "now" && lookId !== "ahead";
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
      aria-label={`${start} à ${end}, ${appointment.client.displayName}, ${appointment.service.name}, ${ecrinLookLabel[lookId]}${isNext ? ", prochain rendez-vous" : ""}`}
      className={cn(
        "ecrin-press flex w-full cursor-pointer flex-col justify-center gap-0.5 rounded-[24px] px-5 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        ecrinLookClass[lookId],
        isNext && "outline-2 outline-offset-2 outline-accent",
      )}
      style={{
        minHeight: behind
          ? undefined
          : Math.round(Math.min(220, Math.max(72, 46 + minutes * 0.75))),
      }}
    >
      <span className="text-[11px] tracking-[0.05em] uppercase">
        {isNext && nowMs !== null
          ? `Prochain · dans ${formatDuration(minutesUntil(visit.start, nowMs))}`
          : ecrinLookLabel[lookId]}
        {appointment.source === "public" ? " · en ligne" : ""}
        {appointment.internalNotes?.trim() ? " · note" : ""}
      </span>
      <span
        data-name=""
        className="font-engraved text-[19px] leading-tight tracking-[0.015em] [overflow-wrap:anywhere]"
      >
        {appointment.client.displayName}
      </span>
      <span className="truncate text-[14px]">{appointment.service.name}</span>
      <span className="text-[13px] tabular-nums">
        {start}
        {visit.endsAfter ? "" : ` → ${end}`} · {formatDuration(minutes)}
      </span>
      {visit.startsBefore || visit.endsAfter ? (
        <span className="text-[13px] font-medium">
          {visit.startsBefore ? `depuis hier ${start}` : null}
          {visit.startsBefore && visit.endsAfter ? " · " : null}
          {visit.endsAfter ? `jusqu’à demain ${end}` : null}
        </span>
      ) : null}
      {progress !== null ? (
        <span className="mt-1.5 flex flex-col gap-1">
          <span
            role="progressbar"
            aria-label="Avancement théorique du créneau"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuetext={`fin prévue dans ${formatDuration(minutesUntil(visit.end, nowMs!))}`}
            className="h-1 overflow-hidden rounded-full bg-on-signature/25"
          >
            <span
              className="block h-full rounded-full bg-on-signature"
              style={{ width: `${progress * 100}%` }}
            />
          </span>
          <span className="text-[12.5px]">
            fin prévue dans {formatDuration(minutesUntil(visit.end, nowMs!))}
          </span>
        </span>
      ) : null}
    </button>
  );
}
