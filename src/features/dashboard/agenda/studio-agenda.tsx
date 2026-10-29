"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from "react";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "@/components/ui/icons";
import {
  dayNumber,
  formatDayMonth,
  formatFullDate,
  formatWeekdayLong,
  formatWeekdayShort,
  startOfWeek,
  visibleRange,
} from "@/features/agenda/client/dates";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import { distinctBookings } from "./day-flow";
import { StudioDayFlow } from "./studio-day-flow";
import { StudioDaySummary } from "./studio-day-summary";
import { StudioWeekWall } from "./studio-week-wall";

// The Studio agenda: the same agenda (its reading, its "today" checked with
// PostgreSQL, its cards, forms and actions: AgendaView), set as a poster. On
// a computer, the week as a wall planner, or one day in depth; on a phone,
// one day at a time, in one column, within one thumb: days in a strip, a
// swipe to the next day, a button to create always at hand.

export type StudioView = "week" | "day";

export type StudioAgendaProps = {
  view: StudioView;
  /** Computer (≥ 768 px): both views; phone: the day. */
  wide: boolean;
  onView: (view: StudioView) => void;
  days: string[];
  anchor: string;
  today: string | null;
  data: AgendaDto | null;
  nowMs: number | null;
  loading: boolean;
  includeCancelled: boolean;
  onIncludeCancelled: (value: boolean) => void;
  /** Days (phone, ±7 for a week) or the period shown (±1). */
  onShift: (direction: -7 | -1 | 1 | 7) => void;
  onToday: () => void;
  onSelectDay: (date: string) => void;
  onNewAppointment: () => void;
  onNewBlock: () => void;
  onOpenAppointment: (appointment: AgendaAppointmentDto) => void;
  onOpenBlock: (block: AgendaBlockDto) => void;
  onCreateAt: (date: string, time: string) => void;
  /** Notices and errors, as the agenda says them. */
  banners: ReactNode;
  /** The agenda's own panels (details, forms). */
  panels: ReactNode;
};

/** ISO 8601 week number of a local date. */
export function isoWeek(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(value.getUTCFullYear(), 0, 1);
  return Math.ceil(((value.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function StudioAgenda(props: StudioAgendaProps) {
  const {
    view,
    wide,
    days,
    anchor,
    today,
    data,
    nowMs,
    loading,
    banners,
    panels,
  } = props;
  const count = data ? distinctBookings(data, days) : null;
  const onToday = today !== null && days.includes(today);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-2.5 px-4 pt-1 pb-3 lg:px-10 lg:pt-2">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1
              className="font-condensed text-[clamp(38px,10.5vw,76px)] leading-[0.84] font-black tracking-[-0.025em] text-ink uppercase"
              aria-live="polite"
            >
              {view === "week" ? (
                <>
                  Semaine{" "}
                  <span className="text-accent">{isoWeek(days[0]!)}</span>
                </>
              ) : (
                <>
                  {formatWeekdayLong(anchor)}{" "}
                  <span className="text-accent">{dayNumber(anchor)}</span>
                </>
              )}
            </h1>
            <p className="mt-1.5 text-[14px] text-ink-soft">
              {view === "week"
                ? `${formatDayMonth(days[0]!)} – ${formatDayMonth(days[days.length - 1]!)} ${days[0]!.slice(0, 4)}`
                : capitalize(
                    formatFullDate(anchor).split(" ").slice(2).join(" "),
                  )}
              {count !== null ? ` · ${count} rendez${"\u2011"}vous` : ""}
            </p>
          </div>

          {wide ? (
            <div className="flex flex-wrap items-center gap-2">
              <ViewSwitch view={view} onView={props.onView} />
              <Navigation
                {...props}
                onToday={props.onToday}
                isOnToday={onToday}
              />
              <button
                type="button"
                onClick={props.onNewBlock}
                className="h-11 cursor-pointer rounded-full px-4 text-[14px] font-bold text-ink-soft transition-colors hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature"
              >
                Bloquer un créneau
              </button>
              <button
                type="button"
                onClick={props.onNewAppointment}
                className="flex h-11 cursor-pointer items-center gap-2 rounded-full bg-signature px-5 text-[14.5px] font-extrabold text-on-signature shadow-[0_12px_26px_-14px_rgb(var(--shadow-rgb)/0.7)] transition-transform hover:-translate-y-px focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink active:translate-y-0 motion-reduce:transition-none"
              >
                <PlusIcon size={18} />
                Nouveau rendez-vous
              </button>
            </div>
          ) : (
            // Phone: the least above her day. Back to today when away from
            // it; the rest in one menu.
            <div className="flex items-center gap-1.5 self-start pt-1">
              {onToday ? null : (
                <button
                  type="button"
                  onClick={props.onToday}
                  data-on-today={false}
                  className="h-11 cursor-pointer rounded-full px-3.5 text-[13.5px] font-bold text-ink shadow-[inset_0_0_0_2px_var(--ink)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature"
                >
                  Aujourd’hui
                </button>
              )}
              <Options
                includeCancelled={props.includeCancelled}
                onIncludeCancelled={props.onIncludeCancelled}
                onNewBlock={props.onNewBlock}
              />
            </div>
          )}
        </div>

        {view === "day" ? (
          <div className="flex items-center gap-1 md:max-w-[640px]">
            {wide ? null : (
              <RoundButton
                small
                label="Semaine précédente"
                onClick={() => props.onShift(-7)}
              >
                <ChevronLeftIcon size={18} />
              </RoundButton>
            )}
            <DayStrip
              anchor={anchor}
              today={today}
              onSelect={props.onSelectDay}
            />
            {wide ? null : (
              <RoundButton
                small
                label="Semaine suivante"
                onClick={() => props.onShift(7)}
              >
                <ChevronRightIcon size={18} />
              </RoundButton>
            )}
          </div>
        ) : null}

        {wide ? (
          <div>
            <CancelledChip
              on={props.includeCancelled}
              onChange={props.onIncludeCancelled}
            />
          </div>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div
            className="absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-sand"
            role="progressbar"
            aria-label="Chargement de l’agenda"
          >
            <span className="block h-full w-1/3 animate-progress bg-signature" />
          </div>
        ) : null}
        {banners}

        {view === "week" ? (
          <StudioWeekWall
            days={days}
            data={data}
            today={today}
            nowMs={nowMs}
            onOpenAppointment={props.onOpenAppointment}
            onOpenBlock={props.onOpenBlock}
            onCreateAt={props.onCreateAt}
            onOpenDay={(date) => {
              props.onSelectDay(date);
              props.onView("day");
            }}
          />
        ) : (
          <SwipeDays
            enabled={!wide}
            onShift={props.onShift}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-28 md:pb-8 lg:px-10"
          >
            <div
              className={cn(
                wide &&
                  "mx-auto grid max-w-[1180px] items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px]",
              )}
            >
              <StudioDayFlow
                data={data}
                date={anchor}
                nowMs={nowMs}
                roomy={wide}
                onOpenAppointment={props.onOpenAppointment}
                onOpenBlock={props.onOpenBlock}
                onCreateAt={props.onCreateAt}
              />
              {wide ? (
                <div className="sticky top-2 hidden self-start lg:block">
                  <StudioDaySummary
                    data={data}
                    date={anchor}
                    nowMs={nowMs}
                    onOpenAppointment={props.onOpenAppointment}
                  />
                </div>
              ) : null}
            </div>
          </SwipeDays>
        )}
      </div>

      {/* Phone: create, always within the thumb's reach, above the dock. */}
      {wide ? null : (
        <button
          type="button"
          onClick={props.onNewAppointment}
          aria-label="Nouveau rendez-vous"
          className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-30 grid size-14 cursor-pointer place-items-center rounded-full bg-signature text-on-signature shadow-[0_16px_32px_-12px_rgb(var(--shadow-rgb)/0.7)] transition-transform active:scale-95 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink motion-reduce:transition-none"
        >
          <PlusIcon size={26} />
        </button>
      )}

      {panels}
    </div>
  );
}

function ViewSwitch({
  view,
  onView,
}: {
  view: StudioView;
  onView: (view: StudioView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Affichage"
      className="flex rounded-full bg-sand p-1"
    >
      {(["week", "day"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onView(option)}
          className={cn(
            "h-9 cursor-pointer rounded-full px-4 text-[14px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature",
            view === option
              ? "bg-ink text-paper"
              : "text-ink-soft hover:text-ink",
          )}
        >
          {option === "week" ? "Semaine" : "Jour"}
        </button>
      ))}
    </div>
  );
}

/** Previous, today, next: the same three gestures everywhere. */
function Navigation({
  view,
  wide,
  onShift,
  onToday,
  isOnToday,
}: Pick<StudioAgendaProps, "view" | "wide" | "onShift" | "onToday"> & {
  isOnToday: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <RoundButton
        small={!wide}
        label={view === "week" ? "Semaine précédente" : "Jour précédent"}
        onClick={() => onShift(-1)}
      >
        <ChevronLeftIcon size={19} />
      </RoundButton>
      <button
        type="button"
        onClick={onToday}
        data-on-today={isOnToday}
        className={cn(
          "h-11 cursor-pointer rounded-full px-4 text-[14px] font-bold shadow-[inset_0_0_0_2px_var(--ink)] transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature",
          isOnToday
            ? "text-ink-soft"
            : "text-ink hover:bg-ink hover:text-paper",
        )}
      >
        Aujourd’hui
      </button>
      <RoundButton
        small={!wide}
        label={view === "week" ? "Semaine suivante" : "Jour suivant"}
        onClick={() => onShift(1)}
      >
        <ChevronRightIcon size={19} />
      </RoundButton>
    </div>
  );
}

/** Cancelled visits, on demand: a real checkbox, drawn as a chip. */
function CancelledChip({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-bold transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signature",
        on ? "bg-ink text-paper" : "bg-sand text-ink hover:bg-sand-deep",
      )}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span aria-hidden="true">{on ? "✓" : "+"}</span>
      Annulés
      <span className="sr-only"> : afficher les rendez-vous annulés</span>
    </label>
  );
}

/** Phone: blocking time and cancelled visits, in one small menu. */
function Options({
  includeCancelled,
  onIncludeCancelled,
  onNewBlock,
}: {
  includeCancelled: boolean;
  onIncludeCancelled: (value: boolean) => void;
  onNewBlock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="agenda-options"
        aria-label="Options de l’agenda"
        onClick={() => setOpen(!open)}
        className="grid size-11 cursor-pointer place-items-center rounded-full bg-sand text-[20px] leading-none font-black text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature"
      >
        ⋯
      </button>
      {open ? (
        <div
          id="agenda-options"
          className="absolute top-12 right-0 z-50 flex w-64 flex-col gap-1 rounded-[20px] bg-paper-raised p-2 shadow-[0_24px_48px_-20px_rgb(var(--shadow-rgb)/0.6),0_0_0_1px_var(--line)]"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewBlock();
            }}
            className="flex min-h-12 cursor-pointer items-center rounded-[14px] px-3 text-left text-[15px] font-bold text-ink hover:bg-sand focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-signature"
          >
            Bloquer un créneau
          </button>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[14px] px-3 text-[15px] font-bold text-ink hover:bg-sand has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-[-3px] has-[:focus-visible]:outline-signature">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(event) => onIncludeCancelled(event.target.checked)}
              className="size-5 accent-[var(--ink)]"
            />
            Afficher les annulés
          </label>
        </div>
      ) : null}
    </div>
  );
}

function RoundButton({
  label,
  small,
  onClick,
  children,
}: {
  label: string;
  /** Phone: 44 px tall, narrower. */
  small?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        small ? "h-11 w-9" : "size-11",
        "grid cursor-pointer place-items-center rounded-full text-ink shadow-[inset_0_0_0_2px_var(--line-strong)] transition-colors hover:shadow-[inset_0_0_0_2px_var(--ink)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature",
      )}
    >
      {children}
    </button>
  );
}

/** The week of the day shown: one tap to any of its days. */
function DayStrip({
  anchor,
  today,
  onSelect,
}: {
  anchor: string;
  today: string | null;
  onSelect: (date: string) => void;
}) {
  const { days } = visibleRange("week", startOfWeek(anchor));
  return (
    <div
      className="grid min-w-0 flex-1 grid-cols-7 gap-0.5 min-[360px]:gap-1"
      role="group"
      aria-label="Jours de la semaine"
    >
      {days.map((date) => {
        const selected = date === anchor;
        return (
          <button
            key={date}
            type="button"
            onClick={() => onSelect(date)}
            aria-pressed={selected}
            aria-label={formatFullDate(date)}
            className={cn(
              "flex h-[60px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[14px] transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-signature",
              selected ? "bg-ink text-paper" : "text-ink-soft hover:bg-sand",
            )}
          >
            <span className="font-expanded text-[10.5px] font-bold tracking-[0.04em] uppercase">
              <span className="min-[400px]:hidden">
                {formatWeekdayShort(date).slice(0, 2)}
              </span>
              <span className="hidden min-[400px]:inline">
                {formatWeekdayShort(date).slice(0, 3)}
              </span>
            </span>
            <span
              className={cn(
                "font-condensed text-[24px] leading-none font-black tabular-nums",
                !selected && date === today && "text-accent",
              )}
            >
              {dayNumber(date)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A horizontal swipe changes day (phone only); vertical scrolling is left
 * alone. Arrows and the day strip do the same for keyboard and pointer.
 */
function SwipeDays({
  enabled,
  onShift,
  className,
  children,
}: {
  enabled: boolean;
  onShift: (direction: -1 | 1) => void;
  className: string;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const from = start.current;
    const touch = event.changedTouches[0];
    start.current = null;
    if (!from || !touch) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) onShift(dx < 0 ? 1 : -1);
  };
  return (
    <div
      className={className}
      onTouchStart={enabled ? onTouchStart : undefined}
      onTouchEnd={enabled ? onTouchEnd : undefined}
    >
      {children}
    </div>
  );
}
