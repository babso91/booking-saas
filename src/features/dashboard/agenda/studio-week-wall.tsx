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

import { distinctBookings } from "./day-flow";
import { hatch, visitLookOf, visitLooks } from "./visit-look";

// The Studio week: a wall planner. One row per day, time running left to
// right on one shared axis, so a glance compares the days. Placement is the
// agenda's own (../../agenda/client/layout.ts): real instants, DST strips,
// visits that overlap in rows of their own. Visits and her blocked time are
// real buttons; a click on free time proposes a new appointment there (the
// existing form decides, the server validates).

type Props = {
  days: string[];
  data: AgendaDto | null;
  /** The business's date today, or null while it is being checked. */
  today: string | null;
  /** Current instant (ms), or null before the client clock is known. */
  nowMs: number | null;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
  onOpenDay: (date: string) => void;
};

const ROW = 76; // px, the least a day with visits takes
const LANE = 36; // px per row of overlapping visits

export function StudioWeekWall({
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
  const rows = useMemo(
    () =>
      days.map((date) => {
        const placed = placeAppointments(axis, appointments, date);
        const lanes = Math.max(1, ...placed.map((item) => item.lanes));
        return {
          date,
          placed,
          lanes,
          blocks: placeBlocks(axis, blocks, date),
          allDay: allDayBlocks(axis, blocks, date),
          opens: openSegments(
            axis,
            workingDays.find((day) => day.date === date),
            date,
          ),
          count: data ? distinctBookings(data, [date], true) : 0,
        };
      }),
    [axis, appointments, blocks, workingDays, days, data],
  );

  // The wall spans her week as it is: from the earliest opening or visit
  // to the latest, a little air around, on whole hours (9 h–19 h by
  // default). Nothing she has is ever outside it.
  const { startY, endY } = useMemo(() => {
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const row of rows)
      for (const segment of [...row.opens, ...row.placed, ...row.blocks]) {
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
  }, [rows, axis]);
  const span = Math.max(1, endY - startY);
  const x = (y: number) => `${((y - startY) / span) * 100}%`;
  const w = (top: number, bottom: number) =>
    `calc(${((bottom - top) / span) * 100}% - 3px)`;
  const marks = axis.marks.filter((mark) => mark.y >= startY && mark.y < endY);
  const todayRow = rows.find((row) => row.date === today);
  const todayFrame = today ? axis.frames.get(today) : undefined;
  const nowMark =
    todayRow &&
    todayFrame &&
    nowMs !== null &&
    nowMs >= todayFrame.startMs &&
    nowMs < todayFrame.endMs
      ? yOf(axis, todayRow.date, nowMs)
      : null;

  function createFromClick(event: MouseEvent<HTMLDivElement>, date: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = startY + ((event.clientX - rect.left) / rect.width) * span;
    const time = timeAt(axis, date, Math.floor(y / 15) * 15);
    if (time) onCreateAt(date, time);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-6 lg:px-10">
      {/* The hour scale, shared by every day. */}
      <div className="sticky top-0 z-30 grid grid-cols-[112px_minmax(0,1fr)] bg-paper pt-3 pb-1.5 xl:grid-cols-[136px_minmax(0,1fr)]">
        <span aria-hidden="true" />
        <div className="relative h-5" aria-hidden="true">
          {nowMark !== null && nowMark >= startY && nowMark <= endY ? (
            <span
              className="absolute top-[-2px] z-10 -translate-x-1/2 rounded-full bg-signature px-2 py-0.5 text-[12px] font-extrabold text-on-signature tabular-nums"
              style={{ left: x(nowMark) }}
            >
              {zone ? (wallOf(zone, nowMs!)?.slice(11, 16) ?? "") : ""}
            </span>
          ) : null}
          {marks.map((mark) =>
            (mark.y - startY) / span < 0.97 ? (
              <span
                key={`${mark.y}:${mark.label}`}
                className="font-condensed absolute top-0 -translate-x-px text-[13px] font-extrabold text-ink-muted"
                style={{ left: x(mark.y) }}
              >
                {Number(mark.label.slice(0, 2))}h
                {mark.repeated ? (
                  <span className="text-accent"> bis</span>
                ) : null}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col border-b border-line">
        {rows.map((row) => {
          const isToday = row.date === today;
          const frame = axis.frames.get(row.date);
          const closedAllDay = row.allDay.length > 0;
          const closed = closedAllDay || row.opens.length === 0;
          const nowY =
            isToday &&
            nowMs !== null &&
            frame &&
            nowMs >= frame.startMs &&
            nowMs < frame.endMs
              ? yOf(axis, row.date, nowMs)
              : null;
          const height = Math.max(
            closed && row.placed.length === 0 ? 56 : ROW,
            row.lanes * LANE + 16,
          );
          return (
            <section
              key={row.date}
              aria-label={`${formatFullDate(row.date)}, ${row.count} rendez-vous`}
              className={cn(
                "grid grid-cols-[112px_minmax(0,1fr)] border-t border-line xl:grid-cols-[136px_minmax(0,1fr)]",
                closed && row.placed.length === 0 ? "flex-[0.6]" : "flex-1",
                isToday &&
                  "bg-[color-mix(in_srgb,var(--signature)_9%,transparent)]",
              )}
              style={{ minHeight: height }}
            >
              <button
                type="button"
                onClick={() => onOpenDay(row.date)}
                aria-label={`Voir le ${formatFullDate(row.date)} en détail`}
                className="group flex cursor-pointer flex-col justify-center gap-0.5 pr-3 text-left focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-accent"
              >
                <span
                  className={cn(
                    "font-condensed text-[46px] leading-[0.82] font-black tracking-[-0.02em] tabular-nums transition-transform group-hover:translate-x-0.5",
                    isToday ? "text-accent" : "text-ink",
                  )}
                >
                  {dayNumber(row.date)}
                </span>
                <span className="font-expanded text-[11.5px] font-bold tracking-[0.08em] text-ink-soft uppercase">
                  {formatWeekdayShort(row.date)}
                  {isToday ? " · auj." : ""}
                </span>
                <span className="text-[12.5px] text-ink-soft">
                  {closed && row.count === 0
                    ? closedAllDay
                      ? "Fermé"
                      : "Pas d’ouverture"
                    : `${row.count} rdv`}
                </span>
              </button>

              <div
                role="group"
                aria-label={`Journée du ${formatFullDate(row.date)}`}
                onClick={(event) => createFromClick(event, row.date)}
                className={cn(
                  "relative my-2 cursor-copy overflow-hidden rounded-[14px] bg-sand/70",
                  closedAllDay && hatch,
                )}
              >
                {/* Her opening, lighter; the rest of the day, sand. */}
                {closedAllDay
                  ? null
                  : row.opens.flatMap((segment, index) =>
                      segment.pieces.map((piece, part) => (
                        <span
                          key={`${index}:${part}`}
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 bg-paper-raised"
                          style={{
                            left: x(piece.top),
                            width: w(piece.top, piece.bottom),
                          }}
                        />
                      )),
                    )}
                {marks.map((mark) => (
                  <span
                    key={`${mark.y}:${mark.label}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 border-l border-line"
                    style={{ left: x(mark.y) }}
                  />
                ))}
                {/* Strips holding no time this day (DST). */}
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
                      "pointer-events-none absolute inset-y-0 z-[5] bg-sand",
                      hatch,
                    )}
                    style={{ left: x(gap.top), width: w(gap.top, gap.bottom) }}
                  />
                ))}

                {row.allDay.map((block) => (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => onOpenBlock(block)}
                    className="absolute inset-0 z-10 flex cursor-pointer items-center px-4 text-left text-[14px] font-bold text-ink-soft focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-accent"
                  >
                    {blockLabel(block)}
                    <span className="sr-only"> — journée entière</span>
                  </button>
                ))}

                {row.blocks.flatMap(({ block, pieces }) =>
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
                        "absolute inset-y-1 z-10 flex cursor-pointer items-end overflow-hidden rounded-[10px] bg-sand px-2 pb-1.5 text-left text-[12px] font-bold text-ink-soft transition-colors hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-accent",
                        hatch,
                      )}
                      style={{
                        left: x(piece.top),
                        width: w(piece.top, piece.bottom),
                      }}
                    >
                      {part === 0 &&
                      (piece.bottom - piece.top) / span > 0.07 ? (
                        <span className="truncate">
                          {block.reason?.trim() ||
                            (block.kind === "closed" ? "Fermé" : "Bloqué")}
                        </span>
                      ) : null}
                    </button>
                  )),
                )}

                {row.placed.flatMap(
                  ({
                    appointment,
                    pieces,
                    lane,
                    lanes,
                    continuesBefore,
                    continuesAfter,
                  }) =>
                    pieces.map((piece, part) => {
                      const look = visitLooks[visitLookOf(appointment, nowMs)];
                      const start = timeWithOccurrence(
                        timeOf(appointment.localStartsAt),
                        appointment.startOccurrence,
                        appointment.localStartsAt.slice(0, 10),
                        zone,
                      );
                      const style = {
                        left: x(piece.top),
                        width: w(piece.top, piece.bottom),
                        top: `calc(4px + ${lane} * ((100% - 8px) / ${lanes}))`,
                        height: `calc((100% - 8px) / ${lanes} - 3px)`,
                      };
                      return (
                        <button
                          key={`${appointment.id}:${part}`}
                          type="button"
                          tabIndex={part === 0 ? undefined : -1}
                          aria-hidden={part === 0 ? undefined : true}
                          onClick={() => onOpenAppointment(appointment)}
                          aria-label={
                            part === 0
                              ? `${start}, ${appointment.client.displayName}, ${appointment.service.name}, ${formatDuration(appointment.durationMinutes)}, ${look.label}`
                              : undefined
                          }
                          className={cn(
                            "@container absolute z-20 flex cursor-pointer flex-col justify-center overflow-hidden rounded-[11px] px-2 text-left transition-[transform,box-shadow] duration-150 hover:z-30 hover:-translate-y-px hover:shadow-[0_10px_22px_-12px_rgb(var(--shadow-rgb)/0.6)] focus-visible:z-30 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent active:translate-y-0 motion-reduce:transition-none",
                            look.className,
                            (continuesBefore || part > 0) && "rounded-l-[3px]",
                            (continuesAfter || part < pieces.length - 1) &&
                              "rounded-r-[3px]",
                          )}
                          style={style}
                        >
                          {part === 0 ? (
                            <>
                              {/* Too narrow for a name: her initials. */}
                              <span
                                data-name=""
                                className="hidden text-[13px] leading-tight font-extrabold @max-[34px]:block"
                              >
                                {initials(appointment.client.displayName)}
                              </span>
                              <span
                                data-name=""
                                className="truncate text-[13.5px] leading-tight font-extrabold @max-[34px]:hidden @[150px]:hidden"
                              >
                                {appointment.client.displayName.split(" ")[0]}
                              </span>
                              <span
                                data-name=""
                                className="font-expanded hidden truncate text-[14px] leading-tight font-extrabold @[150px]:block"
                              >
                                {appointment.client.displayName}
                              </span>
                              {lanes === 1 ? (
                                <span className="hidden truncate text-[12px] leading-tight @[96px]:block">
                                  {start}
                                  <span className="hidden @[170px]:inline">
                                    {" · "}
                                    {appointment.service.name}
                                  </span>
                                </span>
                              ) : null}
                            </>
                          ) : null}
                        </button>
                      );
                    }),
                )}

                {nowY !== null && nowY >= startY && nowY <= endY ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 z-[15] border-l-[3px] border-signature"
                    style={{ left: x(nowY) }}
                  />
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase();
