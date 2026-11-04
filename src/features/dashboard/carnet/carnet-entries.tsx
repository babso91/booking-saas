"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatDuration, timeOf } from "@/features/agenda/client/dates";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import { zoneOf, type Zone } from "@/features/agenda/client/zone";
import { blockLabel } from "@/features/agenda/components/time-grid";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
} from "@/features/agenda/data/agenda";
import type { AgendaDto } from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import {
  overlappingVisits,
  type DayFlow,
  type FlowItem,
  type FlowVisit,
} from "../agenda/day-flow";
import { visitLookOf, type VisitLookId } from "../agenda/visit-look";
import { minutesUntil } from "../client/today-model";
import styles from "./carnet.module.css";

// A day written down: the hour in the margin, her client's name in ink, what is
// planned under it. Her statuses are stamps; a note is a numbered reference to
// the margin; a pause is hatched; a buffer is said, free time is left blank and
// offered. Same model as every style (dayFlow): the form and the server decide.

/** Her statuses, stamped. A confirmed visit carries none: nothing happened. */
const stampOf: Partial<Record<VisitLookId, string>> = {
  completed: "Terminé",
  noShow: "Absente",
  cancelled: "Annulé",
};

/** Which reference number each visit with a note carries, in the day's order. */
export function referencesOf(flow: DayFlow) {
  const references = new Map<string, number>();
  for (const item of flow.items)
    if (item.kind === "visits")
      for (const { appointment } of item.visits)
        if (
          appointment.internalNotes?.trim() &&
          !references.has(appointment.id)
        )
          references.set(appointment.id, references.size + 1);
  return references;
}

/** Shorter free time is left off today's page; the agenda offers it. */
const PAGE_FREE = 30;

type Actions = {
  /** Set: visits are buttons opening the agenda's card. Otherwise links. */
  onOpenAppointment?: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock?: (block: AgendaBlockDto) => void;
  onCreateAt?: (date: string, time: string) => void;
};

const visitHref = (appointment: AgendaAppointmentDto) =>
  ({
    pathname: "/app",
    query: {
      date: appointment.localStartsAt.slice(0, 10),
      rdv: appointment.id,
    },
  }) as const;

export function CarnetEntries({
  flow,
  data,
  date,
  nowMs,
  page,
  ...actions
}: {
  flow: DayFlow;
  data: AgendaDto;
  date: string;
  nowMs: number | null;
  /** Today's page: it opens on its date, and says only the free time that counts. */
  page?: boolean;
} & Actions) {
  const zone = useMemo(() => zoneOf(data), [data]);
  const references = useMemo(() => referencesOf(flow), [flow]);

  // Open on what matters now, once per day shown.
  const list = useRef<HTMLOListElement>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (page || focused.current === date) return;
    const target = list.current?.querySelector("[data-focus]");
    if (!target) return;
    focused.current = date;
    target.scrollIntoView?.({ block: "center" });
  }, [date, flow, page]);

  const hasVisits = flow.items.some((item) => item.kind === "visits");
  return (
    <ol ref={list} aria-label="Ordre du jour" className={styles.entries}>
      {flow.closed && !hasVisits ? (
        <li className={styles.closed}>
          <b>Fermé.</b> Aucune ouverture ce jour-là.
        </li>
      ) : null}
      {flow.items
        .filter(
          (item) => !page || item.kind !== "free" || item.minutes >= PAGE_FREE,
        )
        .map((item) => (
          <Item
            key={keyOf(item)}
            item={item}
            flow={flow}
            date={date}
            nowMs={nowMs}
            zone={zone}
            references={references}
            {...actions}
          />
        ))}
      {!flow.closed && flow.items.length === 0 ? (
        <li className={styles.closed}>Rien de prévu ce jour-là.</li>
      ) : null}
    </ol>
  );
}

const keyOf = (item: FlowItem) =>
  item.kind === "visits"
    ? `v:${item.visits.map((visit) => visit.appointment.id).join(",")}`
    : item.kind === "block"
      ? `b:${item.block.id}`
      : `${item.kind}:${item.start}`;

function Item({
  item,
  flow,
  date,
  nowMs,
  zone,
  references,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: {
  item: FlowItem;
  flow: DayFlow;
  date: string;
  nowMs: number | null;
  zone: Zone;
  references: Map<string, number>;
} & Actions) {
  if (item.kind === "now")
    return (
      <li data-focus="" className={styles.nowLine}>
        <span>{item.time}</span>
        <span aria-hidden="true" />
        <span className="sr-only">Il est {item.time}</span>
      </li>
    );

  if (item.kind === "free") {
    const said = `Temps libre · ${formatDuration(item.minutes)}`;
    return (
      <li className={styles.free}>
        {item.ahead && onCreateAt ? (
          <button
            type="button"
            className={styles.freeRow}
            onClick={() => onCreateAt(date, item.time)}
          >
            <span className={styles.time}>{item.time}</span>
            <span>
              {said}
              <span className="sr-only">
                , à partir de {item.time} : proposer un rendez-vous ici
              </span>
            </span>
            <span aria-hidden="true" className={styles.freeNote}>
              + noter
            </span>
          </button>
        ) : (
          <p className={styles.freeRow}>
            <span className={styles.time}>{item.time}</span>
            <span>{said}</span>
          </p>
        )}
      </li>
    );
  }

  if (item.kind === "block") {
    const { block } = item;
    const content = (
      <>
        <span className={styles.time}>
          {item.startsBefore ? "veille" : timeOf(block.localStartsAt)}
        </span>
        <span className={styles.pauseLabel}>
          {blockLabel(block)}, jusqu’à {item.endsAfter ? "demain " : ""}
          {timeOf(block.localEndsAt)}
        </span>
      </>
    );
    return (
      <li>
        {onOpenBlock ? (
          <button
            type="button"
            className={styles.pause}
            onClick={() => onOpenBlock(block)}
          >
            {content}
          </button>
        ) : (
          <p className={styles.pause}>{content}</p>
        )}
      </li>
    );
  }

  const { visits } = item;
  const overlapping = overlappingVisits(visits);
  const isFocus = visits.some(
    (visit) =>
      visitLookOf(visit.appointment, nowMs) === "now" ||
      visit.appointment.id === flow.next?.appointment.id,
  );
  return (
    <li data-focus={isFocus ? "" : undefined}>
      {overlapping > 1 ? (
        <p className={styles.overlapSays}>
          {overlapping} rendez-vous se chevauchent
        </p>
      ) : null}
      <ul className={cn(overlapping > 1 && styles.overlap)}>
        {visits.map((visit) => (
          <li key={visit.appointment.id}>
            <Entry
              visit={visit}
              isNext={visit.appointment.id === flow.next?.appointment.id}
              nowMs={nowMs}
              zone={zone}
              reference={references.get(visit.appointment.id)}
              onOpen={onOpenAppointment}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

function Entry({
  visit,
  isNext,
  nowMs,
  zone,
  reference,
  onOpen,
}: {
  visit: FlowVisit;
  isNext: boolean;
  nowMs: number | null;
  zone: Zone;
  reference?: number;
  onOpen?: (appointment: AgendaAppointmentDto) => void;
}) {
  const { appointment } = visit;
  const look = visitLookOf(appointment, nowMs);
  const start = timeWithOccurrence(
    timeOf(appointment.localStartsAt),
    appointment.startOccurrence,
    appointment.localStartsAt.slice(0, 10),
    zone,
  );
  const end = timeOf(appointment.localEndsAt);
  const stamp = stampOf[look];

  // Pressed in front of her: a status she just gave lands like a stamp.
  const [lastStamp, setLastStamp] = useState(stamp);
  const [fresh, setFresh] = useState(false);
  if (lastStamp !== stamp) {
    setLastStamp(stamp);
    setFresh(stamp !== undefined);
  }

  const content: ReactNode = (
    <>
      <span className={styles.time}>
        {visit.startsBefore ? "veille" : start}
      </span>
      <span className={styles.written}>
        <span className={styles.who}>
          <span data-name="">{appointment.client.displayName}</span>
          {reference ? (
            <sup className={styles.sup}>
              <span className="sr-only">, note </span>
              {reference}
            </sup>
          ) : null}
        </span>
        <span className={styles.what}>
          {appointment.service.name} ·{" "}
          <span className={styles.mono}>
            {formatDuration(appointment.durationMinutes)}
          </span>
          {appointment.bufferMinutes > 0 && look !== "cancelled" ? (
            <> · puis {formatDuration(appointment.bufferMinutes)} gardées</>
          ) : null}
          {appointment.source === "public" ? (
            <>
              {" "}
              · <span className={styles.tag}>en ligne</span>
            </>
          ) : null}
        </span>
        {look === "now" && nowMs !== null ? (
          <span className={styles.annotation}>
            {visit.endsAfter
              ? `Créneau en cours, jusqu’à demain ${end}`
              : `Créneau en cours, fin prévue dans ${formatDuration(minutesUntil(visit.end, nowMs))}`}
          </span>
        ) : isNext && nowMs !== null ? (
          <span className={styles.annotation}>
            Prochain, dans {formatDuration(minutesUntil(visit.start, nowMs))}
          </span>
        ) : null}
        {look === "past" ? (
          <span className={styles.annotationSoft}>Passé</span>
        ) : null}
        {visit.startsBefore || visit.endsAfter ? (
          <span className={styles.annotationSoft}>
            {visit.startsBefore ? `depuis hier ${start}` : null}
            {visit.startsBefore && visit.endsAfter ? " · " : null}
            {visit.endsAfter && look !== "now" ? `jusqu’à demain ${end}` : null}
          </span>
        ) : null}
      </span>
      {stamp ? (
        <span
          className={cn(styles.stamp, fresh && styles.stamped)}
          data-look={look}
        >
          {stamp}
        </span>
      ) : null}
    </>
  );

  const className = styles.entry;
  return onOpen ? (
    <button
      type="button"
      className={className}
      data-look={look}
      onClick={() => onOpen(appointment)}
    >
      {content}
    </button>
  ) : (
    <Link href={visitHref(appointment)} className={className} data-look={look}>
      {content}
    </Link>
  );
}
