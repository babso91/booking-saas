"use client";

import { useMemo, type MouseEvent } from "react";

import {
  dayNumber,
  formatDuration,
  formatFullDate,
  formatWeekdayShort,
  timeOf,
} from "@/features/agenda/client/dates";
import {
  allDayBlocks,
  buildAxis,
  openSegments,
  placeAppointments,
  placeBlocks,
  timeAt,
  yOf,
} from "@/features/agenda/client/layout";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import { wallOf, zoneOf } from "@/features/agenda/client/zone";
import { blockLabel } from "@/features/agenda/components/time-grid";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import { distinctBookings } from "../agenda/day-flow";
import { hatch, visitLookOf } from "../agenda/visit-look";
import { todayModel } from "../client/today-model";
import { EcrinDial } from "./ecrin-dial";
import { ecrinLookClass, ecrinLookLabel } from "./looks";

// The Écrin week: seven tubes side by side, a small dial on top of each.
// Time runs downward; the day's opening is the lit part of its tube; visits
// are capsules set in it, side by side when they overlap; today's tube is
// wider. Placement is the agenda's own (layout.ts: real instants, DST
// strips, lanes). Visits and blocks are real buttons opening the agenda's
// panels; a click on free time proposes a new appointment there, and the
// existing form and the server decide.

type Props = {
  days: string[];
  data: AgendaDto | null;
  today: string | null;
  nowMs: number | null;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
  onOpenDay: (date: string) => void;
};

export function EcrinWeek({
  days,
  data,
  today,
  nowMs,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
  onOpenDay,
}: Props) {
  const appointments = useMemo(() => data?.appointments ?? [], [data]);
  const blocks = useMemo(() => data?.blocks ?? [], [data]);
  const workingDays = useMemo(() => data?.workingHours.days ?? [], [data]);
  const zone = useMemo(() => (data ? zoneOf(data) : null), [data]);
  const axis = useMemo(() => buildAxis(days, zone), [days, zone]);

  const columns = useMemo(
    () =>
      days.map((date) => ({
        date,
        placed: placeAppointments(axis, appointments, date),
        blocks: placeBlocks(axis, blocks, date),
        allDay: allDayBlocks(axis, blocks, date),
        opens: openSegments(
          axis,
          workingDays.find((day) => day.date === date),
          date,
        ),
        count: data ? distinctBookings(data, [date], true) : 0,
        model: data ? todayModel(data, date, nowMs ?? 0) : null,
      })),
    [axis, appointments, blocks, workingDays, days, data, nowMs],
  );

  // Her week as it is: first opening or visit to the last, on whole hours.
  const { startY, endY } = useMemo(() => {
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const column of columns)
      for (const segment of [
        ...column.opens,
        ...column.placed,
        ...column.blocks,
      ]) {
        tops.push(segment.top);
        bottoms.push(segment.bottom);
      }
    const first = tops.length ? Math.min(...tops) : 9 * 60;
    const last = bottoms.length ? Math.max(...bottoms) : 19 * 60;
    const marks = axis.marks.map((mark) => mark.y);
    const start = Math.max(0, ...marks.filter((y) => y <= first - 20));
    const after = marks.filter((y) => y >= last + 20);
    const end = after.length
      ? Math.min(...after)
      : Math.max(...[...axis.frames.values()].map((frame) => frame.endY), last);
    return { startY: start, endY: end };
  }, [columns, axis]);

  const span = Math.max(1, endY - startY);
  const y = (value: number) => `${((value - startY) / span) * 100}%`;
  const h = (top: number, bottom: number) =>
    `calc(${((bottom - top) / span) * 100}% - 3px)`;
  const marks = axis.marks.filter((mark) => mark.y >= startY && mark.y < endY);

  const template = `48px ${days
    .map((date) => (date === today ? "minmax(0,1.5fr)" : "minmax(0,1fr)"))
    .join(" ")}`;

  const todayFrame = today ? axis.frames.get(today) : undefined;
  const nowY =
    today &&
    todayFrame &&
    nowMs !== null &&
    nowMs >= todayFrame.startMs &&
    nowMs < todayFrame.endMs
      ? yOf(axis, today, nowMs)
      : null;
  const nowLabel =
    nowY !== null && zone ? (wallOf(zone, nowMs!)?.slice(11, 16) ?? "") : "";

  function createFromClick(event: MouseEvent<HTMLDivElement>, date: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = startY + ((event.clientY - rect.top) / rect.height) * span;
    const time = timeAt(axis, date, Math.floor(at / 15) * 15);
    if (time) onCreateAt(date, time);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-6 md:px-8">
      {/* Each day's dial, its number and name: a door to that day. */}
      <div
        className="sticky top-0 z-40 grid gap-1.5 pt-1 pb-2"
        style={{ gridTemplateColumns: template }}
      >
        <span aria-hidden="true" />
        {columns.map((column) => {
          const isToday = column.date === today;
          return (
            <button
              key={column.date}
              type="button"
              onClick={() => onOpenDay(column.date)}
              aria-label={`Voir le ${formatFullDate(column.date)} en détail`}
              className={cn(
                "ecrin-press flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-[20px] px-1 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                isToday ? "bg-accent-soft" : "bg-paper/80",
              )}
            >
              {column.model ? (
                <EcrinDial
                  compact
                  model={column.model}
                  now={isToday ? nowMs : null}
                  className="hidden size-11 shrink-0 lg:block"
                />
              ) : null}
              <span className="flex flex-col items-start leading-none">
                <span
                  className={cn(
                    "text-[22px] font-light tabular-nums",
                    isToday ? "text-accent-strong" : "text-ink",
                  )}
                >
                  {dayNumber(column.date)}
                </span>
                <span className="font-engraved text-[10.5px] tracking-[0.14em] text-ink-soft uppercase">
                  {formatWeekdayShort(column.date)}
                </span>
                <span className="text-[11.5px] text-ink-soft">
                  {column.count} rdv
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        className="relative grid min-h-[560px] flex-1 gap-1.5"
        style={{ gridTemplateColumns: template }}
      >
        {/* The hours, and "now" among them. */}
        <div className="relative" aria-hidden="true">
          {marks.map((mark) => (
            <span
              key={`${mark.y}:${mark.label}`}
              className="absolute right-1.5 -translate-y-1/2 text-[12px] text-ink-soft tabular-nums"
              style={{ top: y(mark.y) }}
            >
              {Number(mark.label.slice(0, 2))}h
              {mark.repeated ? (
                <span className="block text-[9.5px] text-accent">2ᵉ fois</span>
              ) : null}
            </span>
          ))}
          {nowY !== null && nowY >= startY && nowY <= endY ? (
            <span
              className="absolute right-0 z-20 -translate-y-1/2 rounded-full bg-accent px-1.5 py-0.5 text-[11.5px] font-medium text-paper-raised tabular-nums"
              style={{ top: y(nowY) }}
            >
              {nowLabel}
            </span>
          ) : null}
        </div>

        {columns.map((column) => {
          const frame = axis.frames.get(column.date);
          const closedAllDay = column.allDay.length > 0;
          const isToday = column.date === today;
          return (
            <div
              key={column.date}
              role="group"
              aria-label={`Journée du ${formatFullDate(column.date)}, ${column.count} rendez-vous`}
              onClick={(event) => createFromClick(event, column.date)}
              className={cn(
                "relative cursor-copy overflow-hidden rounded-[22px] bg-sand/60",
                (closedAllDay || column.opens.length === 0) && hatch,
              )}
            >
              {!closedAllDay &&
              column.opens.length === 0 &&
              column.placed.length === 0 &&
              column.blocks.length === 0 ? (
                <span className="font-engraved pointer-events-none absolute top-1/2 left-1/2 z-[6] -translate-x-1/2 -translate-y-1/2 rounded-full bg-paper-raised px-3 py-1 text-[14px] text-ink">
                  Fermé
                </span>
              ) : null}
              {closedAllDay
                ? null
                : column.opens.flatMap((segment, index) =>
                    segment.pieces.map((piece, part) => (
                      <span
                        key={`${index}:${part}`}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 rounded-[22px] bg-paper-raised shadow-[inset_0_0_0_1px_var(--line)]"
                        style={{
                          top: y(piece.top),
                          height: h(piece.top, piece.bottom),
                        }}
                      />
                    )),
                  )}
              {marks.map((mark) => (
                <span
                  key={`${mark.y}:${mark.label}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-3 border-t border-line"
                  style={{ top: y(mark.y) }}
                />
              ))}
              {frame?.gaps.map((gap) => (
                <span
                  key={gap.top}
                  aria-hidden="true"
                  title={
                    frame.skipped?.top === gap.top
                      ? "Heure inexistante ce jour-là (passage à l’heure d’été)"
                      : "Heure répétée un autre jour de la semaine"
                  }
                  className={cn(
                    "pointer-events-none absolute inset-x-0 z-[5] bg-sand",
                    hatch,
                  )}
                  style={{ top: y(gap.top), height: h(gap.top, gap.bottom) }}
                />
              ))}

              {column.allDay.map((block) => (
                <button
                  key={block.id}
                  type="button"
                  onClick={() => onOpenBlock(block)}
                  className="font-engraved absolute inset-0 z-10 flex cursor-pointer items-center justify-center p-2 text-center text-[14px] text-ink [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-accent"
                >
                  {blockLabel(block)}
                  <span className="sr-only"> — journée entière</span>
                </button>
              ))}

              {column.blocks.flatMap(({ block, pieces }) =>
                pieces.map((piece, part) => (
                  <button
                    key={`${block.id}:${part}`}
                    type="button"
                    tabIndex={part === 0 ? undefined : -1}
                    aria-hidden={part === 0 ? undefined : true}
                    onClick={() => onOpenBlock(block)}
                    aria-label={
                      part === 0
                        ? `${blockLabel(block)}, ${timeOf(block.localStartsAt)} – ${timeOf(block.localEndsAt)}`
                        : undefined
                    }
                    className={cn(
                      "absolute inset-x-1 z-10 flex cursor-pointer items-center justify-center overflow-hidden rounded-[14px] bg-sand px-1 text-[11.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                      hatch,
                    )}
                    style={{
                      top: y(piece.top),
                      height: h(piece.top, piece.bottom),
                    }}
                  >
                    {part === 0 && (piece.bottom - piece.top) / span > 0.06 ? (
                      <span className="truncate">
                        {block.reason?.trim() ||
                          (block.kind === "closed" ? "Fermé" : "Bloqué")}
                      </span>
                    ) : null}
                  </button>
                )),
              )}

              {column.placed.flatMap(
                ({
                  appointment,
                  pieces,
                  lane,
                  lanes,
                  continuesBefore,
                  continuesAfter,
                }) =>
                  pieces.map((piece, part) => {
                    const lookId = visitLookOf(appointment, nowMs);
                    const start = timeWithOccurrence(
                      timeOf(appointment.localStartsAt),
                      appointment.startOccurrence,
                      appointment.localStartsAt.slice(0, 10),
                      zone,
                    );
                    const minutes = piece.bottom - piece.top;
                    return (
                      <button
                        key={`${appointment.id}:${part}`}
                        type="button"
                        tabIndex={part === 0 ? undefined : -1}
                        aria-hidden={part === 0 ? undefined : true}
                        onClick={() => onOpenAppointment(appointment)}
                        aria-label={
                          part === 0
                            ? `${start}, ${appointment.client.displayName}, ${appointment.service.name}, ${formatDuration(appointment.durationMinutes)}, ${ecrinLookLabel[lookId]}`
                            : undefined
                        }
                        className={cn(
                          "@container ecrin-press absolute z-20 flex cursor-pointer flex-col justify-center overflow-hidden rounded-[14px] px-2 text-left hover:z-30 focus-visible:z-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                          ecrinLookClass[lookId],
                          (continuesBefore || part > 0) && "rounded-t-[3px]",
                          (continuesAfter || part < pieces.length - 1) &&
                            "rounded-b-[3px]",
                        )}
                        style={{
                          top: y(piece.top),
                          height: h(piece.top, piece.bottom),
                          minHeight: 22,
                          left: `calc(${(lane / lanes) * 100}% + 3px)`,
                          width: `calc(${100 / lanes}% - 6px)`,
                        }}
                      >
                        {part === 0 ? (
                          <>
                            <span
                              data-name=""
                              className="font-engraved truncate text-[13.5px] leading-tight tracking-[0.01em]"
                            >
                              {isToday
                                ? appointment.client.displayName
                                : appointment.client.displayName.split(" ")[0]}
                            </span>
                            {minutes >= 40 ? (
                              <span className="truncate text-[11.5px] leading-tight tabular-nums">
                                {start}
                              </span>
                            ) : null}
                            {minutes >= 70 ? (
                              <span className="hidden truncate text-[11.5px] leading-tight @[110px]:block">
                                {appointment.service.name}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </button>
                    );
                  }),
              )}

              {isToday && nowY !== null && nowY >= startY && nowY <= endY ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-[15] h-0.5 bg-accent"
                  style={{ top: y(nowY) }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
