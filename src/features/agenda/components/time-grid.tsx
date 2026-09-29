"use client";

import { useEffect, useRef, type MouseEvent } from "react";

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
  minutesOf,
  timeFromMinutes,
  timeOf,
} from "../client/dates";
import {
  allDayBlocks,
  openSegments,
  placeAppointments,
  placeBlocks,
  visibleHours,
} from "../client/layout";
import { formatPrice } from "../client/money";
import { timeWithOccurrence } from "../client/occurrence";
import { StatusBadge, statusMeta } from "./status-badge";

type TimeGridProps = {
  days: string[];
  data: AgendaDto | null;
  timezone: string;
  today: string;
  now: string;
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
 * Items are real buttons: every appointment and block is reachable with the
 * keyboard. Clicking an empty slot (pointer) proposes a new appointment.
 */
export function TimeGrid({
  days,
  data,
  timezone,
  today,
  now,
  hourHeight,
  onOpenAppointment,
  onOpenBlock,
  onCreateAt,
}: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const appointments = data?.appointments ?? [];
  const blocks = data?.blocks ?? [];
  const workingDays = data?.workingHours.days ?? [];
  const { startHour, endHour } = visibleHours(
    days,
    appointments,
    blocks,
    workingDays,
  );
  const gridMinutes = (endHour - startHour) * 60;
  const pxPerMinute = hourHeight / 60;
  const single = days.length === 1;
  const hasAllDay = days.some((date) => allDayBlocks(blocks, date).length > 0);
  const scrollKey = `${days[0]}:${data ? "ready" : "empty"}`;

  // Bring the start of the working day into view once data is there.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !data) return;
    const firstOpen = Math.min(
      ...days.flatMap((date) =>
        openSegments(
          workingDays.find((day) => day.date === date),
          date,
        ).map((segment) => segment.top),
      ),
      9 * 60,
    );
    container.scrollTop = Math.max(
      0,
      (firstOpen - startHour * 60 - 30) * pxPerMinute,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per period
  }, [scrollKey]);

  const top = (minutes: number) => (minutes - startHour * 60) * pxPerMinute;

  function createFromClick(event: MouseEvent<HTMLDivElement>, date: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = startHour * 60 + (event.clientY - rect.top) / pxPerMinute;
    onCreateAt(date, timeFromMinutes(Math.floor(minutes / 15) * 15));
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
                {allDayBlocks(blocks, date).map((block) => (
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
          style={{ height: gridMinutes * pxPerMinute }}
        >
          {/* Hour axis */}
          <div className="relative" aria-hidden="true">
            {Array.from({ length: endHour - startHour }, (_, index) => (
              <span
                key={index}
                className="absolute right-2 -translate-y-1/2 text-[11.5px] text-ink-muted tabular-nums"
                style={{ top: index * hourHeight }}
              >
                {index === 0
                  ? ""
                  : `${String(startHour + index).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>

          {days.map((date) => {
            const isToday = date === today;
            const nowMinutes = isToday ? minutesOf(now) : null;
            const placedBlocks = placeBlocks(blocks, date);
            const placedAppointments = placeAppointments(appointments, date);
            const opens = openSegments(
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
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${hourHeight - 1}px, rgba(201,182,162,0.35) ${hourHeight - 1}px, rgba(201,182,162,0.35) ${hourHeight}px)`,
                }}
              >
                {/* Working hours: lighter background */}
                {allDayBlocks(blocks, date).length > 0 ? (
                  <div
                    aria-hidden="true"
                    className="agenda-hatch pointer-events-none absolute inset-0 opacity-60"
                  />
                ) : null}
                {allDayBlocks(blocks, date).length === 0 &&
                  opens.map((segment, index) => (
                    <div
                      key={index}
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bg-paper-raised/85"
                      style={{
                        top: top(segment.top),
                        height: segment.height * pxPerMinute,
                      }}
                    />
                  ))}

                {placedBlocks.map(
                  ({
                    block,
                    top: start,
                    height,
                    continuesBefore,
                    continuesAfter,
                  }) => (
                    <button
                      key={block.id}
                      type="button"
                      onClick={() => onOpenBlock(block)}
                      aria-label={`${blockLabel(block)}, ${timeOf(block.localStartsAt)} – ${timeOf(block.localEndsAt)}`}
                      className={cn(
                        "agenda-hatch absolute inset-x-0.5 z-10 cursor-pointer overflow-hidden rounded-lg border border-line-strong/70 px-2 py-1 text-left transition-colors hover:border-ink",
                        continuesBefore && "rounded-t-none",
                        continuesAfter && "rounded-b-none",
                      )}
                      style={{
                        top: top(start),
                        height: Math.max(height * pxPerMinute, 18),
                      }}
                    >
                      <span className="block truncate text-[12px] font-semibold text-ink-soft">
                        {blockLabel(block)}
                      </span>
                      {height >= 40 ? (
                        <span className="block text-[11px] text-ink-muted tabular-nums">
                          {timeOf(block.localStartsAt)} –{" "}
                          {timeOf(block.localEndsAt)}
                        </span>
                      ) : null}
                    </button>
                  ),
                )}

                {placedAppointments.map(
                  ({ appointment, top: start, height, lane, lanes }) => (
                    <AppointmentCard
                      key={appointment.id}
                      appointment={appointment}
                      timezone={timezone}
                      heightPx={Math.max(height * pxPerMinute, 22)}
                      roomy={single}
                      onOpen={() => onOpenAppointment(appointment)}
                      style={{
                        top: top(start),
                        height: Math.max(height * pxPerMinute, 22),
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                    />
                  ),
                )}

                {nowMinutes !== null &&
                nowMinutes >= startHour * 60 &&
                nowMinutes <= endHour * 60 ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 z-30 flex items-center"
                    style={{ top: top(nowMinutes) }}
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
  timezone,
  heightPx,
  roomy,
  onOpen,
  style,
}: {
  appointment: AgendaAppointmentDto;
  timezone: string;
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
    timezone,
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
