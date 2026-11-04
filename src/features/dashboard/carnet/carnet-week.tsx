"use client";

import { Fragment, useMemo, useState, type MouseEvent } from "react";

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
  segmentOn,
  timeAt,
  yOf,
} from "@/features/agenda/client/layout";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import { wallOf, zoneOf } from "@/features/agenda/client/zone";
import { Sheet } from "@/components/ui/sheet";
import { blockLabel } from "@/features/agenda/components/time-grid";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

import { distinctBookings } from "../agenda/day-flow";
import { visitLookOf, visitLooks } from "../agenda/visit-look";
import { closeVisitsOf, pieceKey, type CloseVisits } from "./close-visits";
import styles from "./carnet.module.css";

// The week as a planner's double page: Monday to Wednesday on the left, Thursday
// to Sunday on the right, the fold between them, the hours on each page. Visits
// are written, not boxed: a stroke of ink as long as the visit. Placement is the
// agenda's own (layout.ts: real instants, DST strips, lanes). A click on free
// time proposes a new appointment; the form and the server decide.

/** Pixels a minute of her day takes on the page. */
const PPM = 1.2;
const LEFT_PAGE = 3;

/** Her statuses, in words, where a stroke alone would only be a colour. */
const mark = { completed: "✓ ", noShow: "abs. " } as const;

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

export function CarnetWeek({
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
        // The buffer after each visit: held, so not free.
        held: appointments.flatMap((appointment) =>
          appointment.status === "cancelled" || !appointment.bufferMinutes
            ? []
            : (segmentOn(
                axis,
                {
                  startsAt: appointment.endsAt,
                  endsAt: new Date(
                    Date.parse(appointment.endsAt) +
                      appointment.bufferMinutes * 60_000,
                  ).toISOString(),
                },
                date,
              )?.pieces.map((piece) => ({ id: appointment.id, piece })) ?? []),
        ),
        count: data ? distinctBookings(data, [date], true) : 0,
      })),
    [axis, appointments, blocks, workingDays, days, data],
  );

  // Her week as it is: first opening or visit to the last, on whole hours.
  const { startY, endY } = useMemo(() => {
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const column of columns) {
      for (const segment of [
        ...column.opens,
        ...column.placed,
        ...column.blocks,
      ]) {
        tops.push(segment.top);
        bottoms.push(segment.bottom);
      }
      for (const { piece } of column.held) bottoms.push(piece.bottom);
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
    `calc(${((bottom - top) / span) * 100}% - 2px)`;
  const marks = axis.marks.filter((mark) => mark.y >= startY && mark.y < endY);

  // The page is at least PPM pixels a minute (taller when it fills 560 px):
  // visits too close for a target each share one, never an overlapping one.
  const scale = Math.max(PPM, 560 / span);
  const close = useMemo(
    () => columns.map((column) => closeVisitsOf(column.placed, scale)),
    [columns, scale],
  );
  // The close visits listed, found again in each new reading (or gone).
  const [listed, setListed] = useState<{ date: string; top: number } | null>(
    null,
  );
  const listedGroup = listed
    ? (close[days.indexOf(listed.date)]?.groups.find(
        (group) => group.top === listed.top,
      ) ?? null)
    : null;
  const at = (
    local: string,
    occurrence: AgendaAppointmentDto["startOccurrence"],
  ) => timeWithOccurrence(timeOf(local), occurrence, local.slice(0, 10), zone);
  const spanOf = (group: CloseVisits) => {
    const first = group.appointments[0]!;
    const last = group.appointments.reduce((latest, item) =>
      Date.parse(item.endsAt) > Date.parse(latest.endsAt) ? item : latest,
    );
    return `de ${at(first.localStartsAt, first.startOccurrence)} à ${timeOf(last.localEndsAt)}`;
  };

  const todayFrame = today ? axis.frames.get(today) : undefined;
  const nowY =
    today &&
    todayFrame &&
    nowMs !== null &&
    nowMs >= todayFrame.startMs &&
    nowMs < todayFrame.endMs
      ? yOf(axis, today, nowMs)
      : null;
  const nowShown = nowY !== null && nowY >= startY && nowY <= endY;
  const nowLabel =
    nowShown && zone ? (wallOf(zone, nowMs!)?.slice(11, 16) ?? "") : "";

  function createFromClick(event: MouseEvent<HTMLDivElement>, date: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = startY + ((event.clientY - rect.top) / rect.height) * span;
    const time = timeAt(axis, date, Math.floor(at / 15) * 15);
    if (time) onCreateAt(date, time);
  }

  // "Now" is written in the margin of the page that holds today, not over
  // the visits.
  const todayPage = today ? (days.indexOf(today) >= LEFT_PAGE ? 1 : 0) : -1;
  const hoursColumn = (page: number) => (
    <div className={styles.hours} aria-hidden="true">
      {marks.map((mark) => (
        <span
          key={`${mark.y}:${mark.label}`}
          className={styles.hourLabel}
          style={{ top: y(mark.y) }}
        >
          {Number(mark.label.slice(0, 2))} h
          {mark.repeated ? <small>2ᵉ fois</small> : null}
        </span>
      ))}
      {nowShown && page === todayPage ? (
        <span className={styles.hourNow} style={{ top: y(nowY) }}>
          {nowLabel}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <div tabIndex={0} className={styles.plannerScroll}>
        <div className={styles.planner}>
          {/* Each day's head: a door to that day. */}
          <div className={styles.plannerHeads}>
            {columns.map((column, index) => (
              <Fragment key={column.date}>
                {index === LEFT_PAGE ? (
                  <span aria-hidden="true" className={styles.headsFold} />
                ) : null}
                {index === 0 || index === LEFT_PAGE ? (
                  <span aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  className={styles.dayHead}
                  data-today={column.date === today ? "" : undefined}
                  onClick={() => onOpenDay(column.date)}
                >
                  <b>{dayNumber(column.date)}</b>
                  <span>{formatWeekdayShort(column.date)}</span>
                  <small>{column.count ? `${column.count} rdv` : " "}</small>
                  <span className="sr-only">
                    , voir le {formatFullDate(column.date)} en détail
                  </span>
                </button>
              </Fragment>
            ))}
          </div>

          <div
            className={styles.plannerBody}
            style={{ height: `max(560px, ${Math.round(span * PPM)}px)` }}
          >
            {columns.map((column, index) => {
              const frame = axis.frames.get(column.date);
              const closedAllDay = column.allDay.length > 0;
              const isToday = column.date === today;
              const nothingOpen = closedAllDay || column.opens.length === 0;
              return (
                <Fragment key={column.date}>
                  {index === LEFT_PAGE ? (
                    <div className={styles.gutter} aria-hidden="true" />
                  ) : null}
                  {index === 0 || index === LEFT_PAGE
                    ? hoursColumn(index === 0 ? 0 : 1)
                    : null}
                  <div
                    role="group"
                    aria-label={`Journée du ${formatFullDate(column.date)}, ${column.count} rendez-vous`}
                    className={styles.day}
                    data-today={isToday ? "" : undefined}
                    data-closed={nothingOpen ? "" : undefined}
                    onClick={(event) => createFromClick(event, column.date)}
                  >
                    {!closedAllDay &&
                    column.opens.length === 0 &&
                    column.placed.length === 0 &&
                    column.blocks.length === 0 ? (
                      <span className={styles.dayClosed}>Fermé</span>
                    ) : null}
                    {closedAllDay
                      ? null
                      : column.opens.flatMap((segment, open) =>
                          segment.pieces.map((piece, part) => (
                            <span
                              key={`${open}:${part}`}
                              aria-hidden="true"
                              className={styles.open}
                              style={{
                                top: y(piece.top),
                                height: `${((piece.bottom - piece.top) / span) * 100}%`,
                              }}
                            />
                          )),
                        )}
                    {marks.map((mark) => (
                      <Fragment key={`${mark.y}:${mark.label}`}>
                        <span
                          aria-hidden="true"
                          className={styles.hourRule}
                          style={{ top: y(mark.y) }}
                        />
                        <span
                          aria-hidden="true"
                          className={styles.halfRule}
                          style={{ top: y(mark.y + 30) }}
                        />
                      </Fragment>
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
                        className={styles.gap}
                        style={{
                          top: y(gap.top),
                          height: h(gap.top, gap.bottom),
                        }}
                      />
                    ))}

                    {/* A dotted tail under the visit: held, not a pause, and
                      not a click target (free time is what is left). */}
                    {column.held.map(({ id, piece }) => (
                      <span
                        key={`${id}:${piece.top}`}
                        aria-hidden="true"
                        data-buffer=""
                        title="Temps gardé après le rendez-vous"
                        className={styles.buffer}
                        style={{
                          top: y(piece.top),
                          height: `${((piece.bottom - piece.top) / span) * 100}%`,
                        }}
                      />
                    ))}

                    {column.allDay.map((block) => (
                      <button
                        key={block.id}
                        type="button"
                        className={styles.allDay}
                        onClick={() => onOpenBlock(block)}
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
                          aria-label={
                            part === 0
                              ? `${blockLabel(block)}, ${timeOf(block.localStartsAt)} – ${timeOf(block.localEndsAt)}`
                              : undefined
                          }
                          className={styles.dayPause}
                          style={{
                            top: y(piece.top),
                            height: h(piece.top, piece.bottom),
                          }}
                          onClick={() => onOpenBlock(block)}
                        >
                          {part === 0 && piece.bottom - piece.top >= 25 ? (
                            <span>
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
                          const look = visitLookOf(appointment, nowMs);
                          const start = timeWithOccurrence(
                            timeOf(appointment.localStartsAt),
                            appointment.startOccurrence,
                            appointment.localStartsAt.slice(0, 10),
                            zone,
                          );
                          const minutes = piece.bottom - piece.top;
                          const said =
                            look === "completed" || look === "noShow"
                              ? mark[look]
                              : "";
                          const drawn = {
                            className: styles.slot,
                            "data-look": look,
                            "data-short": minutes < 60 ? "" : undefined,
                            "data-before":
                              continuesBefore || part > 0 ? "" : undefined,
                            "data-after":
                              continuesAfter || part < pieces.length - 1
                                ? ""
                                : undefined,
                            style: {
                              top: y(piece.top),
                              height: h(piece.top, piece.bottom),
                              left: `calc(${(lane / lanes) * 100}% + 2px)`,
                              width: `calc(${100 / lanes}% - 4px)`,
                            },
                          };
                          const written =
                            part === 0 ? (
                              <>
                                <b data-name="">
                                  {said}
                                  {appointment.client.displayName.split(" ")[0]}
                                </b>
                                {minutes >= 30 ? (
                                  <span className={styles.slotTime}>
                                    {start}
                                  </span>
                                ) : null}
                                {minutes >= 60 ? (
                                  <span className={styles.slotService}>
                                    {appointment.service.name}
                                  </span>
                                ) : null}
                              </>
                            ) : null;
                          // Too close to its neighbours for a target of its
                          // own: still written at its exact place, reached
                          // through theirs (CloseVisits, below).
                          if (
                            close[index]!.shared.has(
                              pieceKey(appointment, part),
                            )
                          )
                            return (
                              <span
                                key={`${appointment.id}:${part}`}
                                aria-hidden="true"
                                data-shared=""
                                {...drawn}
                              >
                                {written}
                              </span>
                            );
                          return (
                            <button
                              key={`${appointment.id}:${part}`}
                              type="button"
                              tabIndex={part === 0 ? undefined : -1}
                              aria-hidden={part === 0 ? undefined : true}
                              {...drawn}
                              onClick={() => onOpenAppointment(appointment)}
                            >
                              {written}
                              {part === 0 ? (
                                <span className="sr-only">
                                  , {start}, {appointment.client.displayName},{" "}
                                  {appointment.service.name},{" "}
                                  {formatDuration(appointment.durationMinutes)},{" "}
                                  {visitLooks[look].label}
                                </span>
                              ) : null}
                            </button>
                          );
                        }),
                    )}

                    {close[index]!.groups.map((group) => {
                      const count = group.appointments.length;
                      return (
                        <button
                          key={`close:${group.top}`}
                          type="button"
                          className={styles.closeVisits}
                          aria-haspopup="dialog"
                          style={{
                            top: y(group.top),
                            height: h(group.top, group.bottom),
                          }}
                          onClick={() =>
                            setListed({ date: column.date, top: group.top })
                          }
                        >
                          <span
                            aria-hidden="true"
                            className={styles.closeCount}
                          >
                            {count}
                          </span>
                          <span className="sr-only">
                            {count} rendez-vous rapprochés, {spanOf(group)},
                            voir la liste
                          </span>
                        </button>
                      );
                    })}

                    {isToday && nowShown ? (
                      <span
                        role="img"
                        aria-label={`Il est ${nowLabel}`}
                        className={styles.nowRule}
                        style={{ top: y(nowY) }}
                      />
                    ) : null}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      {/* Close visits, one per line, each a whole line to touch. */}
      <Sheet
        open={listedGroup !== null}
        onClose={() => setListed(null)}
        placement="center"
        title="Rendez-vous rapprochés"
        description={
          listed && listedGroup
            ? `${formatFullDate(listed.date)}, ${spanOf(listedGroup)}`
            : undefined
        }
      >
        {listedGroup ? (
          <ul className={styles.closeList}>
            {listedGroup.appointments.map((appointment) => {
              const look = visitLookOf(appointment, nowMs);
              return (
                <li key={appointment.id}>
                  <button
                    type="button"
                    className={styles.closeRow}
                    data-look={look}
                    onClick={() => {
                      setListed(null);
                      onOpenAppointment(appointment);
                    }}
                  >
                    <span className={styles.closeTime}>
                      {at(
                        appointment.localStartsAt,
                        appointment.startOccurrence,
                      )}
                    </span>
                    <span className={styles.closeWho}>
                      <b>{appointment.client.displayName}</b>
                      <small>
                        {appointment.service.name},{" "}
                        {formatDuration(appointment.durationMinutes)}
                      </small>
                    </span>
                    <span className={styles.closeLook}>
                      {visitLooks[look].label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Sheet>
    </>
  );
}
