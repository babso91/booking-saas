"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  dateOf,
  formatDuration,
  formatWeekdayLong,
  formatWeekdayShort,
  dayNumber,
  formatDayMonth,
  timeOf,
} from "@/features/agenda/client/dates";
import type { AgendaDto } from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import {
  minutesUntil,
  positionOf,
  todayModel,
  type TodayModel,
  type TodayVisit,
} from "../client/today-model";

// "Aujourd’hui" in the Studio style: her day as a poster. The colour field
// says what is going on and what comes next; the day runs left to right
// under it (a barcode and a list on a phone); the week's figures close it,
// then her own notes on what is still to come. Every figure is read from
// her agenda; nothing is invented, nothing is money (bookings are not
// takings: those come with the payment record, docs/DASHBOARD_EXPERIENCE.md).
//
// Her notes on clients stay out of the big, readable-from-afar zones: the
// colour field only says that a note exists; the notes themselves are shown
// when she asks (a client may be sitting next to the screen).

// Re-renders every 30 s so "now" stays true.
function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;

// The agenda read again every 5 minutes and when she comes back to the tab:
// a booking made meanwhile is not missed.
const REFRESH_MS = 5 * 60_000;

const agendaOf = (date: string) =>
  ({ pathname: "/app", query: { date } }) as const;

/** The agenda on that visit's day, its details open. */
const visitHref = (visit: TodayVisit) =>
  ({
    pathname: "/app",
    query: {
      date: dateOf(visit.appointment.localStartsAt),
      rdv: visit.appointment.id,
    },
  }) as const;

const hasNote = (visit: TodayVisit) =>
  Boolean(visit.appointment.internalNotes?.trim());

export function StudioToday({
  agenda,
  date,
  serverNow,
  frozenNow,
}: {
  /** The agenda around today (its week), as the agenda reads it. */
  agenda: AgendaDto;
  /** Today: the business's civil date, from PostgreSQL. */
  date: string;
  /** PostgreSQL's instant when the page was read (first render). */
  serverNow: number;
  /** A fixed instant, for previews: the clock is not consulted. */
  frozenNow?: number;
}) {
  const router = useRouter();
  const ticking = useSyncExternalStore(
    subscribeClock,
    clockNow,
    () => serverNow,
  );
  const now = frozenNow ?? ticking;
  const model = useMemo(
    () => todayModel(agenda, date, now),
    [agenda, date, now],
  );

  // Past midnight in her time zone: today is another day; read it again.
  const rolledOver = model.nowTime === null && now > model.span.start;
  useEffect(() => {
    if (rolledOver && frozenNow === undefined) router.refresh();
  }, [rolledOver, frozenNow, router]);

  useEffect(() => {
    if (frozenNow !== undefined) return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [frozenNow, router]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-10 pb-10 lg:gap-12">
        <Hero model={model} now={now} />
        <Day model={model} now={now} />
        <Figures model={model} />
        <Notes model={model} />
      </div>
    </div>
  );
}

function Clock({ time, date }: { time: string | null; date: string }) {
  return (
    <p className="font-condensed text-[clamp(104px,30vw,208px)] leading-[0.78] font-black tracking-[-0.03em] tabular-nums">
      {time ? time.replace(":", ".") : "··.··"}
      <span className="font-expanded mt-3.5 block text-[12.5px] leading-none font-semibold tracking-[0.08em] uppercase">
        {formatWeekdayLong(date)} {formatDayMonth(date).replace(".", "")}
      </span>
    </p>
  );
}

const eyebrow =
  "font-expanded text-[12px] font-semibold tracking-[0.08em] uppercase";

function Hero({ model, now }: { model: TodayModel; now: number }) {
  const { current, currents, next, phase, visits } = model;
  const after = next ? visits[visits.indexOf(next) + 1] : undefined;

  return (
    <section
      aria-label="Maintenant"
      className="mx-2 grid gap-5 rounded-[28px] bg-signature px-5 pt-6 pb-5 text-on-signature lg:mx-6 lg:grid-cols-[auto_minmax(0,1fr)_minmax(240px,320px)] lg:items-end lg:gap-12 lg:px-10 lg:pt-9 lg:pb-8"
    >
      <Clock time={model.nowTime} date={model.date} />

      <div className="flex min-w-0 flex-col gap-2">
        {phase === "during" && currents.length > 1 ? (
          // Overlapping visits: all of them, none hidden behind another.
          <>
            <span className={eyebrow}>
              Créneaux en cours · {currents.length}
            </span>
            <ul className="flex flex-col gap-2">
              {currents.map((visit) => (
                <li key={visit.appointment.id}>
                  <Link
                    href={visitHref(visit)}
                    className="font-expanded block text-[clamp(24px,6vw,36px)] leading-tight font-extrabold [overflow-wrap:anywhere] hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-on-signature"
                  >
                    {visit.appointment.client.displayName}
                  </Link>
                  <span className="text-[15px] font-medium">
                    {visit.appointment.service.name} · jusqu’à{" "}
                    {timeOf(visit.appointment.localEndsAt)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : phase === "during" && current ? (
          <>
            <span className={eyebrow}>Créneau en cours</span>
            <Name visit={current} />
            <span className="text-[17px] font-medium">
              {current.appointment.service.name}
            </span>
            <Progress visit={current} now={now} />
            <OpenVisit visit={current} />
          </>
        ) : phase === "before" || phase === "between" ? (
          <>
            <span className={eyebrow}>
              {phase === "before" ? "Premier rendez-vous" : "Ensuite"} ·{" "}
              {timeOf(next!.appointment.localStartsAt)}
            </span>
            <Name visit={next!} />
            <span className="text-[17px] font-medium">
              {next!.appointment.service.name} · dans{" "}
              {formatDuration(minutesUntil(next!.start, now))}
            </span>
            <OpenVisit visit={next!} />
          </>
        ) : phase === "after" ? (
          <>
            <span className={eyebrow}>Journée terminée</span>
            <span className="font-expanded text-[clamp(34px,9vw,64px)] leading-[0.95] font-extrabold tracking-[-0.02em]">
              {visits.length} rendez{"\u2011"}vous
            </span>
            <span className="text-[17px] font-medium">
              Belle journée. Demain t’attend dans l’agenda.
            </span>
          </>
        ) : (
          <>
            <span className={eyebrow}>
              {model.closure?.kind === "exceptional"
                ? "Fermeture exceptionnelle"
                : model.closure
                  ? "Jour de fermeture"
                  : model.closures.length
                    ? "Fermeture partielle"
                    : "Journée libre"}
            </span>
            <span className="font-expanded text-[clamp(34px,9vw,64px)] leading-[0.95] font-extrabold tracking-[-0.02em]">
              {model.closure?.kind === "exceptional"
                ? (model.closure.reason ?? "Fermé")
                : model.closure
                  ? "Repos"
                  : "Rien de prévu"}
            </span>
            <span className="text-[17px] font-medium">
              {model.closure?.kind === "exceptional"
                ? "Ton espace est fermé aujourd’hui : aucune réservation possible."
                : model.closure
                  ? "Ton espace est fermé aujourd’hui. Profites-en."
                  : model.closures.length
                    ? `${closuresText(model)}. Le reste de la journée est libre.`
                    : "Aucun rendez-vous aujourd’hui."}
            </span>
          </>
        )}
      </div>

      <Aside
        visit={phase === "during" ? next : after}
        label={phase === "during" ? "Ensuite" : "Puis"}
        date={model.date}
        phase={phase}
      />
    </section>
  );
}

function Name({ visit }: { visit: TodayVisit }) {
  return (
    <span className="font-expanded text-[clamp(34px,9vw,66px)] leading-[0.95] font-extrabold tracking-[-0.02em] [overflow-wrap:anywhere]">
      {visit.appointment.client.displayName}
    </span>
  );
}

/** Straight to that visit in the agenda (its details, its actions). */
function OpenVisit({ visit, label }: { visit: TodayVisit; label?: string }) {
  return (
    <Link
      href={visitHref(visit)}
      className="mt-2 inline-flex min-h-11 items-center gap-2 self-start rounded-full bg-on-signature px-4 text-[14.5px] font-bold text-signature focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-on-signature"
    >
      {label ?? "Voir le rendez-vous"}
      {hasNote(visit) ? (
        <span className="rounded-full border-2 border-signature px-2 text-[12px] leading-5">
          Note
        </span>
      ) : null}
    </Link>
  );
}

function Progress({ visit, now }: { visit: TodayVisit; now: number }) {
  const total = Math.max(1, visit.end - visit.start);
  const elapsed = Math.min(total, Math.max(0, now - visit.start));
  const left = minutesUntil(visit.end, now);
  return (
    <>
      <span
        role="progressbar"
        aria-label="Avancement théorique du créneau"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((elapsed / total) * 100)}
        aria-valuetext={`fin prévue dans ${formatDuration(left)}`}
        className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-on-signature/25"
      >
        <span
          className="block h-full rounded-full bg-on-signature"
          style={{ width: `${(elapsed / total) * 100}%` }}
        />
      </span>
      <span className="flex justify-between text-[13px] font-semibold tabular-nums">
        <span>{timeOf(visit.appointment.localStartsAt)}</span>
        <span>fin prévue dans {formatDuration(left)}</span>
        <span>{timeOf(visit.appointment.localEndsAt)}</span>
      </span>
    </>
  );
}

function Aside({
  visit,
  label,
  date,
  phase,
}: {
  visit: TodayVisit | null | undefined;
  label: string;
  date: string;
  phase: TodayModel["phase"];
}) {
  return (
    <div className="flex flex-col gap-1 border-t-2 border-on-signature pt-3.5 lg:border-t-0 lg:border-l-2 lg:pt-0 lg:pl-6">
      {visit ? (
        <>
          <span className={eyebrow}>
            {label} · {timeOf(visit.appointment.localStartsAt)}
          </span>
          <span className="font-expanded text-[24px] leading-tight font-extrabold [overflow-wrap:anywhere]">
            {visit.appointment.client.displayName}
          </span>
          <span>{visit.appointment.service.name}</span>
          <OpenVisit visit={visit} label="Voir" />
        </>
      ) : (
        <>
          <span className={eyebrow}>
            {phase === "free" || phase === "after" ? "L’agenda" : "Ensuite"}
          </span>
          <span className="text-[16px] font-medium">
            {phase === "free" || phase === "after"
              ? "Ta semaine, en un coup d’œil."
              : "Plus rien après : fin de journée."}
          </span>
        </>
      )}
      {visit ? null : (
        <Link
          href={agendaOf(date)}
          className="mt-2 inline-flex min-h-11 items-center self-start text-[14px] font-bold underline decoration-2 underline-offset-4 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-on-signature"
        >
          Ouvrir l’agenda
        </Link>
      )}
    </div>
  );
}

const stateClass: Record<TodayVisit["state"], string> = {
  done: "bg-paper text-ink-soft shadow-[inset_0_0_0_2px_var(--ink-muted)]",
  now: "bg-signature text-on-signature",
  upcoming: "bg-ink text-paper",
};

function Day({ model, now }: { model: TodayModel; now: number }) {
  const { span, visits } = model;
  const left = (at: number) => positionOf(span, at);
  const width = (start: number, end: number) =>
    `calc(${left(end) - left(start)}% - 4px)`;
  // Too short on the line for words: her initial, the rest in the list.
  const narrow = (visit: TodayVisit) => left(visit.end) - left(visit.start) < 7;

  return (
    <section aria-labelledby="journee" className="mx-4 lg:mx-10">
      <div className="flex items-baseline justify-between gap-3 border-b-2 border-ink pb-2.5">
        <h1
          id="journee"
          className="font-condensed text-[clamp(30px,8vw,54px)] leading-[0.9] font-black tracking-[-0.02em] text-ink uppercase"
        >
          Ta journée{" "}
          <span className="text-accent">· {model.counts.total} rdv</span>
        </h1>
        <Link
          href={agendaOf(model.date)}
          className="text-[15px] font-bold text-ink underline decoration-signature decoration-2 underline-offset-4"
        >
          Agenda
        </Link>
      </div>

      {model.closures.length ? (
        // Part of her day is closed: said here, with or without visits.
        <p className="mt-3.5 inline-flex max-w-full items-center gap-2 rounded-full bg-sand px-3.5 py-1.5 text-[14px] font-bold text-ink [overflow-wrap:anywhere]">
          {closuresText(model)}
        </p>
      ) : null}

      {visits.length === 0 ? (
        <p className="mt-5 text-[16px] text-ink-soft">
          {model.closures.length
            ? "Le reste de ta journée est libre. "
            : "Ta journée est libre. "}
          Les rendez-vous pris en ligne ou ajoutés dans l’agenda s’afficheront
          ici.
        </p>
      ) : (
        <>
          {/* Desktop: the day from left to right. */}
          <div
            className="relative mt-3.5 hidden h-[152px] md:block"
            aria-hidden="true"
          >
            {model.ticks.map((tick) => (
              // The last mark at the very end has no room for its label.
              <span
                key={tick.at}
                className="font-condensed absolute top-0 bottom-0 border-l border-line pl-1.5 text-[13px] font-extrabold text-ink-muted"
                style={{ left: `${left(tick.at)}%` }}
              >
                {left(tick.at) < 97 ? tick.label : null}
              </span>
            ))}
            {model.pauses.map((pause) => (
              <span
                key={pause.id}
                className="absolute top-[26px] bottom-0 flex items-end overflow-hidden rounded-[14px] bg-[repeating-linear-gradient(-45deg,transparent_0_6px,var(--line)_6px_8px)] px-3 pb-2.5 text-[13px] font-bold text-ink-soft"
                style={{
                  left: `${left(pause.start)}%`,
                  width: width(pause.start, pause.end),
                }}
              >
                {left(pause.end) - left(pause.start) < 7 ? null : (
                  <span className="truncate">{pause.label}</span>
                )}
              </span>
            ))}
            {visits.map((visit) => (
              // The list below is the accessible way in; these are a
              // shortcut for the pointer only.
              <Link
                key={visit.appointment.id}
                href={visitHref(visit)}
                tabIndex={-1}
                className={cn(
                  "absolute flex flex-col justify-between overflow-hidden rounded-[14px] px-3 transition-transform hover:-translate-y-0.5",
                  visit.lanes > 1 ? "justify-center py-1" : "pt-3 pb-2.5",
                  stateClass[visit.state],
                )}
                style={{
                  left: `${left(visit.start)}%`,
                  width: width(visit.start, visit.end),
                  top: `calc(26px + ${visit.lane} * (126px / ${visit.lanes}))`,
                  height: `calc(126px / ${visit.lanes} - ${visit.lanes > 1 ? 4 : 0}px)`,
                }}
              >
                <b className="font-expanded truncate text-[16px] leading-none font-extrabold">
                  {narrow(visit) ? initial(visit) : firstName(visit)}
                </b>
                {visit.lanes > 1 || narrow(visit) ? null : (
                  <>
                    <span className="truncate text-[13px] leading-tight">
                      {visit.appointment.service.name}
                    </span>
                    <span className="truncate text-[13px] font-bold tabular-nums">
                      {timeOf(visit.appointment.localStartsAt)}
                    </span>
                  </>
                )}
              </Link>
            ))}
            {model.nowTime ? (
              <span
                className="absolute top-0 -bottom-2.5 z-10 border-l-[3px] border-signature"
                style={{ left: `${left(now)}%` }}
              >
                <span className="absolute -top-0.5 left-0 -translate-x-1/2 rounded-full bg-signature px-2 py-0.5 text-[12px] font-extrabold whitespace-nowrap text-on-signature tabular-nums">
                  {model.nowTime}
                </span>
              </span>
            ) : null}
          </div>

          {/* Phone: the day as a barcode, then each visit. */}
          <div className="md:hidden">
            <div
              className="relative mt-4 h-10 rounded-[10px] bg-paper-raised shadow-[inset_0_0_0_1px_var(--line)]"
              aria-hidden="true"
            >
              {visits.map((visit) => (
                <i
                  key={visit.appointment.id}
                  className={cn(
                    "absolute rounded-[5px]",
                    visit.state === "done"
                      ? "bg-ink-muted"
                      : visit.state === "now"
                        ? "bg-signature"
                        : "bg-ink",
                  )}
                  style={{
                    left: `${left(visit.start)}%`,
                    width: width(visit.start, visit.end),
                    top: `calc(6px + ${visit.lane} * (28px / ${visit.lanes}))`,
                    height: `calc(28px / ${visit.lanes} - ${visit.lanes > 1 ? 2 : 0}px)`,
                  }}
                />
              ))}
              {model.nowTime ? (
                <b
                  className="absolute -top-1 -bottom-1 border-l-[3px] border-accent"
                  style={{ left: `${left(now)}%` }}
                />
              ) : null}
            </div>
            <div
              className="mt-1.5 flex justify-between text-[12px] font-bold text-ink-muted"
              aria-hidden="true"
            >
              <span>{model.ticks[0]?.label}</span>
              <span>{model.ticks[model.ticks.length - 1]?.label}</span>
            </div>
          </div>

          <ol aria-label="Rendez-vous du jour" className="mt-4 md:mt-6">
            {visits.map((visit) => (
              <li key={visit.appointment.id} className="border-b border-line">
                <Link
                  href={visitHref(visit)}
                  className="grid min-h-16 grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 py-3.5 transition-colors hover:bg-paper-raised focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent md:grid-cols-[88px_minmax(0,1fr)_auto]"
                >
                  <span
                    className={cn(
                      "font-condensed text-[26px] leading-none font-black tabular-nums",
                      visit.state === "done"
                        ? "text-ink-muted"
                        : visit.state === "now"
                          ? "text-accent"
                          : "text-ink",
                    )}
                  >
                    {timeOf(visit.appointment.localStartsAt)}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "font-expanded block truncate text-[17px] leading-tight font-extrabold",
                        visit.state === "done" ? "text-ink-soft" : "text-ink",
                      )}
                    >
                      {visit.appointment.client.displayName}
                    </span>
                    <span className="block truncate text-[14px] text-ink-soft">
                      {visit.appointment.service.name} ·{" "}
                      {formatDuration(visit.appointment.durationMinutes)}
                    </span>
                    {/* Across midnight: on its own line, never cut off. */}
                    {visit.startsBefore || visit.endsAfter ? (
                      <span className="mt-0.5 block text-[13px] leading-snug font-bold text-ink">
                        {visit.startsBefore
                          ? `depuis hier ${timeOf(visit.appointment.localStartsAt)}`
                          : null}
                        {visit.startsBefore && visit.endsAfter ? " · " : null}
                        {visit.endsAfter
                          ? `jusqu’à demain ${timeOf(visit.appointment.localEndsAt)}`
                          : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right text-[13px] font-bold text-ink-soft">
                    {stateLabel(visit)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Figures({ model }: { model: TodayModel }) {
  const fill = (day: TodayModel["week"][number]) =>
    day.bookableMinutes > 0
      ? Math.min(
          100,
          Math.round((day.bookedMinutes / day.bookableMinutes) * 100),
        )
      : 0;
  const open = model.week.filter(
    (day) => !day.closed && day.bookableMinutes > 0,
  );
  // Distinct bookings: one across midnight is on two days, counted once.
  const weekVisits = model.weekVisits;
  const busiest = open.reduce<(typeof open)[number] | null>(
    (best, day) => (!best || fill(day) > fill(best) ? day : best),
    null,
  );

  return (
    <section
      aria-label="Chiffres"
      className="mx-4 grid grid-cols-2 border-t-2 border-ink lg:mx-10 lg:grid-cols-[1fr_1fr_1fr_1.4fr]"
    >
      <Figure label="Aujourd’hui" value={String(model.counts.total)}>
        {model.counts.total === 0
          ? "aucun rendez-vous"
          : `${model.counts.done} passé${model.counts.done > 1 ? "s" : ""} · ${model.counts.left} à venir`}
      </Figure>
      <Figure
        label="Pris en ligne"
        value={String(model.counts.online)}
        tone="accent"
      >
        aujourd’hui, sans un appel
      </Figure>
      <Figure label="Cette semaine" value={String(weekVisits)} wide>
        rendez-vous commençant cette semaine, lun. → dim.
      </Figure>
      <div className="col-span-2 flex flex-col gap-1.5 border-b border-line py-4 lg:col-span-1 lg:border-b-0 lg:border-l lg:px-6 lg:pt-5">
        <span className={cn(eyebrow, "text-ink")}>Remplissage</span>
        <div className="flex h-16 items-end gap-1.5" aria-hidden="true">
          {model.week.map((day) => (
            <span
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end gap-1"
            >
              <i
                className={cn(
                  "block rounded-t",
                  day.closed
                    ? "h-[3px] bg-line-strong"
                    : day.isToday
                      ? "bg-signature"
                      : "bg-ink",
                )}
                style={
                  !day.closed
                    ? { height: `${Math.max(4, fill(day))}%` }
                    : undefined
                }
              />
            </span>
          ))}
        </div>
        <div
          className="flex gap-1.5 text-[11.5px] font-bold text-ink-soft"
          aria-hidden="true"
        >
          {model.week.map((day) => (
            <span key={day.date} className="flex-1 text-center">
              {formatWeekdayShort(day.date).slice(0, 2)}
            </span>
          ))}
        </div>
        <p className="text-[14px] text-ink-soft">
          {busiest && busiest.bookedMinutes > 0
            ? `${capitalize(formatWeekdayLong(busiest.date))} ${dayNumber(busiest.date)} est le plus rempli (${fill(busiest)} %).`
            : "Ta semaine est encore toute à remplir."}
        </p>
        <ul className="sr-only">
          {model.week.map((day) => (
            <li key={day.date}>
              {formatWeekdayLong(day.date)} :{" "}
              {day.closed
                ? `fermé${day.visits ? ` (${day.visits} rendez-vous)` : ""}`
                : `${fill(day)} % réservé`}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
  wide,
  children,
}: {
  label: string;
  value: string;
  tone?: "accent";
  /** Alone on its row on a phone. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-b border-line py-4 pr-4 even:border-l even:pl-4 lg:col-span-1 lg:border-b-0 lg:border-l lg:px-6 lg:pt-5 lg:first:border-l-0 lg:first:pl-0",
        wide && "col-span-2",
      )}
    >
      <span className={cn(eyebrow, "text-ink")}>{label}</span>
      <span
        className={cn(
          "font-condensed text-[clamp(52px,13vw,84px)] leading-[0.85] font-black tracking-[-0.02em] tabular-nums",
          tone === "accent" ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </span>
      <span className="text-[14px] text-ink-soft">{children}</span>
    </div>
  );
}

/**
 * Her notes on what is still to come, on demand only: hidden until she
 * asks (not even in the page), hidden again when she leaves.
 */
function Notes({ model }: { model: TodayModel }) {
  const [shown, setShown] = useState(false);
  if (model.notes.length === 0) return null;
  const count = model.notes.length;
  return (
    <section aria-labelledby="notes" className="mx-4 lg:mx-10">
      <div className="flex items-center justify-between gap-3 border-t border-line pt-3.5">
        <h2 id="notes" className={cn(eyebrow, "text-ink")}>
          À ne pas oublier · {count} note{count > 1 ? "s" : ""}
        </h2>
        <button
          type="button"
          aria-expanded={shown}
          aria-controls="notes-list"
          onClick={() => setShown(!shown)}
          className="min-h-11 cursor-pointer rounded-full px-4 text-[14px] font-bold text-ink shadow-[inset_0_0_0_2px_var(--ink)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {shown ? "Masquer" : "Afficher"}
        </button>
      </div>
      <div id="notes-list">
        {shown ? (
          <ol className="mt-1 grid lg:grid-cols-3 lg:gap-6">
            {model.notes.map(({ appointment }, index) => (
              <li
                key={appointment.id}
                className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 border-b border-line py-3.5 text-[16px] leading-snug font-medium text-ink lg:border-b-0"
              >
                <b className="font-condensed text-[22px] leading-none font-black text-accent">
                  {String(index + 1).padStart(2, "0")}
                </b>
                <span className="[overflow-wrap:anywhere] whitespace-pre-line">
                  {timeOf(appointment.localStartsAt)} —{" "}
                  {appointment.client.displayName.split(" ")[0]} :{" "}
                  {appointment.internalNotes!.trim()}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

/** "Fermé de 10:00 à 12:00 · Formation", each closure of her day. */
function closuresText(model: TodayModel) {
  return model.closures
    .map(
      (closure) =>
        `Fermé de ${closure.from} à ${closure.to}${closure.reason ? ` · ${closure.reason}` : ""}`,
    )
    .join(" ; ");
}

function stateLabel(visit: TodayVisit) {
  // A started slot is not a service known to have started: only her own
  // statuses (completed, no-show) say what happened.
  if (visit.state === "now") return "Créneau en cours";
  if (visit.appointment.status === "no_show") return "Absente";
  if (visit.appointment.status === "completed") return "Terminé";
  if (visit.state === "done") return "Passé";
  return visit.appointment.source === "public" ? "En ligne" : "";
}

const initial = (visit: TodayVisit) =>
  [...visit.appointment.client.displayName.trim()][0] ?? "·";

const firstName = (visit: TodayVisit) =>
  visit.appointment.client.displayName.split(" ")[0];

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
