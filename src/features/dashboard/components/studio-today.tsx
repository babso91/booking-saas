"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
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

// Re-renders every 30 s so "now" stays true.
function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;

const agendaOf = (date: string) =>
  ({ pathname: "/app", query: { date } }) as const;

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
  const { current, next, phase, visits } = model;
  const after = next ? visits[visits.indexOf(next) + 1] : undefined;

  return (
    <section
      aria-label="Maintenant"
      className="mx-2 grid gap-5 rounded-[28px] bg-signature px-5 pt-6 pb-5 text-on-signature lg:mx-6 lg:grid-cols-[auto_minmax(0,1fr)_minmax(240px,320px)] lg:items-end lg:gap-12 lg:px-10 lg:pt-9 lg:pb-8"
    >
      <Clock time={model.nowTime} date={model.date} />

      <div className="flex min-w-0 flex-col gap-2">
        {phase === "during" && current ? (
          <>
            <span className={eyebrow}>En cours</span>
            <Name visit={current} />
            <span className="text-[17px] font-medium">
              {current.appointment.service.name}
            </span>
            <Progress visit={current} now={now} />
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
              {model.closed ? "Jour de fermeture" : "Journée libre"}
            </span>
            <span className="font-expanded text-[clamp(34px,9vw,64px)] leading-[0.95] font-extrabold tracking-[-0.02em]">
              {model.closed ? "Repos" : "Rien de prévu"}
            </span>
            <span className="text-[17px] font-medium">
              {model.closed
                ? "Ton espace est fermé aujourd’hui. Profites-en."
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

function Progress({ visit, now }: { visit: TodayVisit; now: number }) {
  const total = Math.max(1, visit.end - visit.start);
  const elapsed = Math.min(total, Math.max(0, now - visit.start));
  const left = minutesUntil(visit.end, now);
  return (
    <>
      <span
        role="progressbar"
        aria-label="Avancement du rendez-vous"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((elapsed / total) * 100)}
        aria-valuetext={`encore ${formatDuration(left)}`}
        className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-on-signature/25"
      >
        <span
          className="block h-full rounded-full bg-on-signature"
          style={{ width: `${(elapsed / total) * 100}%` }}
        />
      </span>
      <span className="flex justify-between text-[13px] font-semibold tabular-nums">
        <span>{timeOf(visit.appointment.localStartsAt)}</span>
        <span>encore {formatDuration(left)}</span>
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
          {visit.appointment.internalNotes?.trim() ? (
            <span className="mt-2 self-start rounded-2xl bg-on-signature px-3 py-1.5 text-[13px] font-bold text-signature">
              {visit.appointment.internalNotes.trim()}
            </span>
          ) : null}
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
      <Link
        href={agendaOf(date)}
        className="mt-2 self-start text-[14px] font-bold underline decoration-2 underline-offset-4 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-on-signature"
      >
        Ouvrir l’agenda
      </Link>
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

      {visits.length === 0 ? (
        <p className="mt-5 text-[16px] text-ink-soft">
          Ta journée est libre. Les rendez-vous pris en ligne ou ajoutés dans
          l’agenda s’afficheront ici.
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
                <span className="truncate">{pause.label}</span>
              </span>
            ))}
            {visits.map((visit) => (
              <span
                key={visit.appointment.id}
                className={cn(
                  "absolute top-[26px] bottom-0 flex flex-col justify-between overflow-hidden rounded-[14px] px-3 pt-3 pb-2.5",
                  stateClass[visit.state],
                )}
                style={{
                  left: `${left(visit.start)}%`,
                  width: width(visit.start, visit.end),
                }}
              >
                <b className="font-expanded truncate text-[16px] leading-none font-extrabold">
                  {firstName(visit)}
                </b>
                <span className="truncate text-[13px] leading-tight">
                  {visit.appointment.service.name}
                </span>
                <span className="truncate text-[13px] font-bold tabular-nums">
                  {timeOf(visit.appointment.localStartsAt)}
                </span>
              </span>
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
                    "absolute top-1.5 bottom-1.5 rounded-[5px]",
                    visit.state === "done"
                      ? "bg-ink-muted"
                      : visit.state === "now"
                        ? "bg-signature"
                        : "bg-ink",
                  )}
                  style={{
                    left: `${left(visit.start)}%`,
                    width: width(visit.start, visit.end),
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
              <li
                key={visit.appointment.id}
                className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-3.5 md:grid-cols-[88px_minmax(0,1fr)_auto]"
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
                </span>
                <span className="text-right text-[13px] font-bold text-ink-soft">
                  {visit.state === "now"
                    ? "En cours"
                    : visit.appointment.status === "no_show"
                      ? "Absente"
                      : visit.state === "done"
                        ? "Terminé"
                        : visit.appointment.source === "public"
                          ? "En ligne"
                          : ""}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Figures({ model }: { model: TodayModel }) {
  const open = model.week.filter((day) => day.openMinutes > 0);
  const weekVisits = model.week.reduce((total, day) => total + day.visits, 0);
  const busiest = open.reduce<(typeof open)[number] | null>(
    (best, day) =>
      !best ||
      day.bookedMinutes / day.openMinutes >
        best.bookedMinutes / best.openMinutes
        ? day
        : best,
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
          : `${model.counts.done} terminé${model.counts.done > 1 ? "s" : ""} · ${model.counts.left} à venir`}
      </Figure>
      <Figure
        label="Pris en ligne"
        value={String(model.counts.online)}
        tone="accent"
      >
        aujourd’hui, sans un appel
      </Figure>
      <Figure label="Cette semaine" value={String(weekVisits)} wide>
        rendez-vous du lundi au dimanche
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
                  day.openMinutes === 0
                    ? "h-[3px] bg-line-strong"
                    : day.isToday
                      ? "bg-signature"
                      : "bg-ink",
                )}
                style={
                  day.openMinutes > 0
                    ? {
                        height: `${Math.max(4, Math.min(100, (day.bookedMinutes / day.openMinutes) * 100))}%`,
                      }
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
            ? `${capitalize(formatWeekdayLong(busiest.date))} ${dayNumber(busiest.date)} est le plus rempli (${Math.round((busiest.bookedMinutes / busiest.openMinutes) * 100)} %).`
            : "Ta semaine est encore toute à remplir."}
        </p>
        <ul className="sr-only">
          {model.week.map((day) => (
            <li key={day.date}>
              {formatWeekdayLong(day.date)} :{" "}
              {day.openMinutes === 0
                ? "fermé"
                : `${Math.round((day.bookedMinutes / day.openMinutes) * 100)} % réservé`}
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

function Notes({ model }: { model: TodayModel }) {
  if (model.notes.length === 0) return null;
  return (
    <section aria-labelledby="notes" className="mx-4 lg:mx-10">
      <h2 id="notes" className={cn(eyebrow, "text-ink")}>
        À ne pas oublier
      </h2>
      <ol className="mt-3 grid lg:grid-cols-3 lg:gap-6">
        {model.notes.map(({ appointment }, index) => (
          <li
            key={appointment.id}
            className="grid grid-cols-[44px_1fr] gap-2 border-t border-line py-3.5 text-[16px] leading-snug font-medium text-ink"
          >
            <b className="font-condensed text-[22px] leading-none font-black text-accent">
              {String(index + 1).padStart(2, "0")}
            </b>
            <span>
              {timeOf(appointment.localStartsAt)} —{" "}
              {appointment.client.displayName.split(" ")[0]} :{" "}
              {appointment.internalNotes!.trim()}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const firstName = (visit: TodayVisit) =>
  visit.appointment.client.displayName.split(" ")[0];

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
