"use client";

import { useEffect, useMemo, useRef, type MouseEvent } from "react";

import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import {
  dayNumber,
  formatDuration,
  formatFullDate,
  formatWeekdayShort,
  timeOf,
} from "../client/dates";
import {
  allDayBlocks,
  buildAxis,
  openSegments,
  placeAppointments,
  placeBlocks,
  timeAt,
  visibleWindow,
  yOf,
  type Interval,
} from "../client/layout";
import { formatPrice } from "../client/money";
import { timeWithOccurrence } from "../client/occurrence";
import { zoneOf, type Zone } from "../client/zone";
import { StatusBadge, statusMeta } from "./status-badge";

type TimeGridProps = {
  days: string[];
  data: AgendaDto | null;
  /** The business's date today, or null while it is being checked. */
  today: string | null;
  /** Current instant (ms), or null before the client clock is known. */
  nowMs: number | null;
  hourHeight: number;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
};

export function blockLabel(block: AgendaBlockDto) {
  const kind = block.kind === "closed" ? "Fermé" : "Bloqué";
  return block.reason ? `${kind} · ${block.reason}` : kind;
}

/**
 * Day columns on a vertical time axis (7 for the week, 1 for the day view).
 * Placement comes from real instants (see ../client/layout.ts): an item
 * never changes day, duration, disappears or repeats across DST changes.
 * Items are real buttons; clicking an empty slot (pointer) proposes a new
 * appointment at that time.
 */
export function TimeGrid({
  days,
  data,
  today,
  nowMs,
  hourHeight,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const appointments = data?.appointments ?? [];
  const blocks = data?.blocks ?? [];
  const workingDays = data?.workingHours.days ?? [];
  // The zone comes with the data (PostgreSQL's day bounds and offsets).
  const zone = useMemo(() => (data ? zoneOf(data) : null), [data]);
  const axis = useMemo(() => buildAxis(days, zone), [days, zone]);
  const { startY, endY } = visibleWindow(
    axis,
    days,
    appointments,
    blocks,
    workingDays,
  );
  const pxPerMinute = hourHeight / 60;
  const single = days.length === 1;
  const hasAllDay = days.some(
    (date) => allDayBlocks(axis, blocks, date).length > 0,
  );
  const scrollKey = `${days[0]}:${data ? "ready" : "empty"}`;
  const marks = axis.marks.filter((mark) => mark.y > startY && mark.y < endY);

  // Bring the start of the working day into view once data is there.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !data) return;
    const firstOpen = Math.min(
      ...days.flatMap((date) =>
        openSegments(
          axis,
          workingDays.find((day) => day.date === date),
          date,
        ).map((segment) => segment.top),
      ),
      9 * 60,
    );
    container.scrollTop = Math.max(0, (firstOpen - startY - 30) * pxPerMinute);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per period
  }, [scrollKey]);

  const top = (y: number) => (y - startY) * pxPerMinute;
  const height = (piece: Interval) => (piece.bottom - piece.top) * pxPerMinute;

  function createFromClick(event: MouseEvent<HTMLDivElement>, date: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = startY + (event.clientY - rect.top) / pxPerMinute;
    const time = timeAt(axis, date, Math.floor(y / 15) * 15);
    if (time) onCreateAt(date, time);
  }

  const columns = single
    ? "grid-cols-[3.5rem_minmax(0,1fr)]"
    : "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers (week view) and all-day row */}
      {!single || hasAllDay ? (
        <div className={cn("grid border-b border-line bg-paper", columns)}>
          <div aria-hidden="true" />
          {days.map((date) => {
            const isToday = date === today;
            return (
              <div
                key={date}
                className="flex min-w-0 flex-col gap-1.5 border-l border-line/70 px-1.5 pt-2 pb-2"
              >
                {!single ? (
                  <p
                    className="flex items-baseline gap-1.5"
                    aria-label={formatFullDate(date)}
                  >
                    <span
                      className={cn(
                        "text-[12px] font-medium tracking-wide uppercase",
                        isToday ? "text-accent" : "text-ink-muted",
                      )}
                    >
                      {formatWeekdayShort(date)}
                    </span>
                    <span
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full text-[15px] font-semibold tabular-nums",
                        isToday ? "bg-ink text-paper-raised" : "text-ink",
                      )}
                    >
                      {dayNumber(date)}
                    </span>
                  </p>
                ) : null}
                {allDayBlocks(axis, blocks, date).map((block) => (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => onOpenBlock(block)}
                    className="agenda-hatch w-full cursor-pointer truncate rounded-lg border border-line-strong/60 px-2 py-1 text-left text-[12px] font-medium text-ink-soft transition-colors hover:border-ink"
                  >
                    {blockLabel(block)}
                    <span className="sr-only"> — journée entière</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className={cn("grid", columns)}
          style={{ height: (endY - startY) * pxPerMinute }}
        >
          {/* Hour axis: wall-clock marks; the repeated autumn hour has its own band. */}
          <div className="relative" aria-hidden="true">
            {marks.map((mark) => (
              <span
                key={`${mark.y}:${mark.label}`}
                className="absolute right-2 flex -translate-y-1/2 flex-col items-end text-[11.5px] leading-none text-ink-muted tabular-nums"
                style={{ top: top(mark.y) }}
              >
                {mark.label}
                {mark.repeated ? (
                  <span className="mt-0.5 text-[9.5px] text-accent">
                    2ᵉ fois
                  </span>
                ) : null}
              </span>
            ))}
          </div>

          {days.map((date) => {
            const frame = axis.frames.get(date);
            const isToday = date === today;
            const nowY =
              isToday &&
              nowMs !== null &&
              frame &&
              nowMs >= frame.startMs &&
              nowMs < frame.endMs
                ? yOf(axis, date, nowMs)
                : null;
            const closedAllDay = allDayBlocks(axis, blocks, date).length > 0;
            const placedBlocks = placeBlocks(axis, blocks, date);
            const placedAppointments = placeAppointments(
              axis,
              appointments,
              date,
            );
            const opens = openSegments(
              axis,
              workingDays.find((day) => day.date === date),
              date,
            );

            return (
              <div
                key={date}
                role="group"
                aria-label={formatFullDate(date)}
                onClick={(event) => createFromClick(event, date)}
                className="relative cursor-copy border-l border-line/70 bg-sand/35"
              >
                {/* Hour lines */}
                {marks.map((mark) => (
                  <div
                    key={`${mark.y}:${mark.label}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 border-t border-line-strong/35"
                    style={{ top: top(mark.y) }}
                  />
                ))}

                {closedAllDay ? (
                  <div
                    aria-hidden="true"
                    className="agenda-hatch pointer-events-none absolute inset-0 opacity-60"
                  />
                ) : (
                  opens.flatMap((segment, index) =>
                    segment.pieces.map((piece, part) => (
                      <div
                        key={`${index}:${part}`}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bg-paper-raised/85"
                        style={{ top: top(piece.top), height: height(piece) }}
                      />
                    )),
                  )
                )}

                {/* Strips holding no time on this day (DST). */}
                {frame?.gaps.map((gap) => (
                  <div
                    key={gap.top}
                    title={
                      frame.skipped?.top === gap.top
                        ? "Heure inexistante ce jour-là (passage à l’heure d’été)"
                        : "Heure répétée un autre jour de la semaine"
                    }
                    aria-hidden="true"
                    className="agenda-gap pointer-events-none absolute inset-x-0 z-[5]"
                    style={{ top: top(gap.top), height: height(gap) }}
                  />
                ))}

                {placedBlocks.flatMap(
                  ({ block, pieces, continuesBefore, continuesAfter }) =>
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
                          "agenda-hatch absolute inset-x-0.5 z-10 flex cursor-pointer flex-col items-start justify-start overflow-hidden rounded-lg border border-line-strong/70 px-2 py-1 text-left transition-colors hover:border-ink",
                          (continuesBefore || part > 0) && "rounded-t-none",
                          (continuesAfter || part < pieces.length - 1) &&
                            "rounded-b-none",
                        )}
                        style={{
                          top: top(piece.top),
                          height: Math.max(height(piece), 18),
                        }}
                      >
                        {part === 0 ? (
                          <>
                            <span className="block truncate text-[12px] font-semibold text-ink-soft">
                              {blockLabel(block)}
                            </span>
                            {height(piece) >= 40 ? (
                              <span className="block text-[11px] text-ink-muted tabular-nums">
                                {timeOf(block.localStartsAt)} –{" "}
                                {timeOf(block.localEndsAt)}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </button>
                    )),
                )}

                {placedAppointments.flatMap(
                  ({ appointment, pieces, lane, lanes }) =>
                    pieces.map((piece, part) => {
                      const style = {
                        top: top(piece.top),
                        height: Math.max(height(piece), 22),
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      };
                      return part === 0 ? (
                        <AppointmentCard
                          key={appointment.id}
                          appointment={appointment}
                          zone={zone}
                          heightPx={style.height}
                          roomy={single}
                          onOpen={() => onOpenAppointment(appointment)}
                          style={style}
                        />
                      ) : (
                        <button
                          key={`${appointment.id}:${part}`}
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          onClick={() => onOpenAppointment(appointment)}
                          className={cn(
                            "absolute z-20 cursor-pointer rounded-b-lg border border-t-0 border-l-[3px] border-line/80",
                            statusMeta[appointment.status].card,
                          )}
                          style={style}
                        />
                      );
                    }),
                )}

                {nowY !== null && nowY >= startY && nowY <= endY ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 z-30 flex items-center"
                    style={{ top: top(nowY) }}
                  >
                    <span className="-ml-1 size-2 rounded-full bg-accent" />
                    <span className="h-px flex-1 bg-accent" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AppointmentCard({
  appointment,
  zone,
  heightPx,
  roomy,
  onOpen,
  style,
}: {
  appointment: AgendaAppointmentDto;
  zone: Zone | null;
  heightPx: number;
  roomy: boolean;
  onOpen: () => void;
  style: React.CSSProperties;
}) {
  const meta = statusMeta[appointment.status];
  const start = timeWithOccurrence(
    timeOf(appointment.localStartsAt),
    appointment.startOccurrence,
    appointment.localStartsAt.slice(0, 10),
    zone,
  );
  const cancelled = appointment.status === "cancelled";
  const price = formatPrice(appointment.priceCents, appointment.currency);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${start}, ${appointment.client.displayName}, ${appointment.service.name}, ${meta.label}`}
      className={cn(
        "@container absolute z-20 flex cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg border border-l-[3px] border-line/80 px-2 py-1 text-left shadow-[0_6px_16px_-12px_rgba(35,28,24,0.5)] transition-[box-shadow,transform] duration-150 hover:shadow-[0_10px_24px_-12px_rgba(35,28,24,0.55)] active:scale-[0.99]",
        meta.card,
      )}
      style={style}
    >
      <span className="flex items-center justify-between gap-1">
        <span
          className={cn(
            "shrink-0 text-[11.5px] font-semibold text-ink-soft tabular-nums",
            cancelled && "line-through",
          )}
        >
          {start}
        </span>
        {heightPx >= 40 || roomy ? (
          <StatusBadge status={appointment.status} compact collapsible />
        ) : null}
      </span>
      <span
        className={cn(
          "truncate text-[13px] leading-tight font-semibold text-ink",
          cancelled && "line-through",
        )}
      >
        {appointment.client.displayName}
      </span>
      {heightPx >= 56 ? (
        <span className="truncate text-[12px] leading-tight text-ink-soft">
          {appointment.service.name}
        </span>
      ) : null}
      {heightPx >= 76 ? (
        <span className="truncate text-[11.5px] text-ink-muted">
          {formatDuration(appointment.durationMinutes)} · {price}
        </span>
      ) : null}
    </button>
  );
}
