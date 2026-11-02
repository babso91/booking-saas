"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  dateOf,
  dayNumber,
  formatDuration,
  formatFullDate,
  formatWeekdayLong,
  formatWeekdayShort,
  timeOf,
} from "@/features/agenda/client/dates";
import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import { visitLookOf } from "../agenda/visit-look";
import {
  minutesUntil,
  todayModel,
  type TodayModel,
  type TodayVisit,
} from "../client/today-model";
import { EcrinDial } from "./ecrin-dial";
import { ecrinLookClass, ecrinLookLabel } from "./looks";

// "Aujourd’hui" in Écrin: the day as an object. The dial in the middle says
// the hour, what is going on and what comes next; beside it, the next visit
// and those that follow, then what the day and the week hold. Everything
// comes from her agenda's reading (TodayModel, the same as Studio's): no
// money before the payment record exists, no invented state, and her notes
// only when she asks.

function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;
const REFRESH_MS = 5 * 60_000;

const visitHref = (appointment: AgendaAppointmentDto) =>
  ({
    pathname: "/app",
    query: {
      date: dateOf(appointment.localStartsAt),
      rdv: appointment.id,
    },
  }) as const;

const caps =
  "font-engraved text-[11.5px] tracking-[0.2em] text-ink-soft uppercase";

export function EcrinToday({
  agenda,
  date,
  serverNow,
  frozenNow,
}: {
  agenda: AgendaDto;
  date: string;
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
    <div
      tabIndex={0}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
    >
      <div className="mx-auto grid w-full max-w-[1400px] gap-8 px-4 pt-2 pb-10 md:px-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)_minmax(0,1fr)] xl:items-start">
        <h1 className="sr-only">Aujourd’hui, {formatFullDate(date)}</h1>
        <section
          aria-label="Maintenant"
          className="mx-auto w-full max-w-[520px] xl:sticky xl:top-2 xl:col-start-2 xl:row-start-1"
        >
          <EcrinDial
            model={model}
            now={now}
            onOpen={(appointment) => router.push(hrefString(appointment))}
          >
            <DialSays model={model} now={now} />
          </EcrinDial>
        </section>

        <Visits model={model} now={now} />
        <Holdings model={model} />
      </div>
    </div>
  );
}

const hrefString = (appointment: AgendaAppointmentDto) =>
  `/app?date=${dateOf(appointment.localStartsAt)}&rdv=${appointment.id}` as never;

function DialSays({ model, now }: { model: TodayModel; now: number }) {
  const { phase, current, currents, next, visits } = model;
  const clock = (
    <p className="text-[clamp(44px,14.5vw,84px)] leading-[0.95] font-extralight tracking-[-0.02em] text-ink tabular-nums">
      {model.nowTime ? (
        <>
          {model.nowTime.slice(0, 2)}
          <span className="mx-[0.04em] align-[0.5em] text-[0.4em] text-ink-soft">
            h
          </span>
          {model.nowTime.slice(3)}
        </>
      ) : (
        "··"
      )}
    </p>
  );
  const name = (text: string) => (
    <p className="font-engraved line-clamp-2 text-[clamp(15px,4.4vw,22px)] leading-tight tracking-[0.02em] text-ink [overflow-wrap:anywhere]">
      {text}
    </p>
  );
  const hint = (text: string) => (
    <p className="text-[clamp(12.5px,3.4vw,15px)] leading-snug text-accent">
      {text}
    </p>
  );

  if (phase === "during" && currents.length > 1)
    return (
      <>
        <p className={caps}>{currents.length} créneaux en cours</p>
        {clock}
        {name(
          currents
            .slice(0, 2)
            .map((visit) => firstName(visit))
            .join(" · ") + (currents.length > 2 ? "…" : ""),
        )}
      </>
    );
  if (phase === "during" && current)
    return (
      <>
        <p className={caps}>Créneau en cours</p>
        {clock}
        {name(current.appointment.client.displayName)}
        {hint(
          current.endsAfter
            ? `fin prévue demain à ${timeOf(current.appointment.localEndsAt)}`
            : `fin prévue dans ${formatDuration(minutesUntil(current.end, now))}`,
        )}
      </>
    );
  if ((phase === "before" || phase === "between") && next)
    return (
      <>
        <p className={caps}>
          Prochain · {timeOf(next.appointment.localStartsAt)}
        </p>
        {clock}
        {name(next.appointment.client.displayName)}
        {hint(`dans ${formatDuration(minutesUntil(next.start, now))}`)}
      </>
    );
  if (phase === "after")
    return (
      <>
        <p className={caps}>Journée terminée</p>
        {clock}
        {name(`${visits.length} rendez‑vous`)}
      </>
    );
  return (
    <>
      <p className={caps}>
        {model.closure?.kind === "exceptional"
          ? "Fermeture exceptionnelle"
          : model.closure
            ? "Jour de fermeture"
            : model.closures.length
              ? "Fermeture partielle"
              : "Journée libre"}
      </p>
      {clock}
      {name(
        model.closure?.kind === "exceptional"
          ? (model.closure.reason ?? "Fermé")
          : model.closure
            ? "Repos"
            : "Rien de prévu",
      )}
    </>
  );
}

/** The visits: going on and next first, then what follows; past on demand. */
function Visits({ model, now }: { model: TodayModel; now: number }) {
  const [pastShown, setPastShown] = useState(false);
  const { currents, next, visits } = model;
  const past = visits.filter((visit) => visit.state === "done");
  const later = visits.filter(
    (visit) =>
      visit.state === "upcoming" &&
      visit.appointment.id !== next?.appointment.id,
  );

  return (
    <section
      aria-label="Rendez-vous du jour"
      className="mx-auto flex w-full max-w-[520px] flex-col gap-3 xl:col-start-1 xl:row-start-1 xl:max-w-none"
    >
      {model.closures.length ? <ClosureLine model={model} /> : null}

      {visits.length === 0 ? (
        <p className="ecrin-object rounded-[24px] p-5 text-[15px] leading-relaxed text-ink-soft">
          {model.closure
            ? "Ton espace est fermé aujourd’hui : aucune réservation possible."
            : model.closures.length
              ? "Le reste de ta journée est libre. Les rendez-vous pris en ligne ou ajoutés dans l’agenda s’afficheront ici."
              : "Ta journée est libre. Les rendez-vous pris en ligne ou ajoutés dans l’agenda s’afficheront ici."}
        </p>
      ) : null}

      {currents.map((visit) => (
        <Capsule key={visit.appointment.id} visit={visit} now={now} big />
      ))}
      {next ? (
        <Capsule
          visit={next}
          now={now}
          big
          label={`Prochain · dans ${formatDuration(minutesUntil(next.start, now))}`}
          ringed
        />
      ) : null}

      {later.length ? (
        <>
          <h2 className={cn(caps, "mt-2 px-2")}>Puis</h2>
          <ol className="flex flex-col gap-2">
            {later.map((visit) => (
              <li key={visit.appointment.id}>
                <Capsule visit={visit} now={now} />
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {past.length ? (
        <>
          <button
            type="button"
            aria-expanded={pastShown}
            onClick={() => setPastShown(!pastShown)}
            className="mt-1 min-h-11 cursor-pointer self-start rounded-full px-3 text-[14px] text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {pastShown ? "Masquer" : "Voir"} {past.length} rendez
            {"‑"}vous passé{past.length > 1 ? "s" : ""}
          </button>
          {pastShown ? (
            <ol className="flex flex-col gap-2">
              {past.map((visit) => (
                <li key={visit.appointment.id}>
                  <Capsule visit={visit} now={now} />
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Capsule({
  visit,
  now,
  big,
  label,
  ringed,
}: {
  visit: TodayVisit;
  now: number;
  big?: boolean;
  label?: string;
  ringed?: boolean;
}) {
  const { appointment } = visit;
  const look = visitLookOf(appointment, now);
  const note = appointment.internalNotes?.trim();
  return (
    <Link
      href={visitHref(appointment)}
      className={cn(
        "ecrin-press grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-3 rounded-[26px] px-5 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        ecrinLookClass[look],
        big && "py-4",
        ringed && "outline-2 outline-offset-2 outline-accent",
      )}
    >
      <span className="text-[17px] tabular-nums">
        {timeOf(appointment.localStartsAt)}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] tracking-[0.04em] uppercase">
          {label ?? ecrinLookLabel[look]}
          {appointment.source === "public" ? " · en ligne" : ""}
          {note ? " · note" : ""}
        </span>
        <span
          data-name=""
          className={cn(
            "font-engraved block truncate tracking-[0.02em]",
            big ? "text-[20px]" : "text-[17px]",
          )}
        >
          {appointment.client.displayName}
        </span>
        <span className="block truncate text-[14px]">
          {appointment.service.name} ·{" "}
          {formatDuration(appointment.durationMinutes)}
        </span>
        {visit.startsBefore || visit.endsAfter ? (
          <span className="block text-[13px] font-medium">
            {visit.startsBefore
              ? `depuis hier ${timeOf(appointment.localStartsAt)}`
              : null}
            {visit.startsBefore && visit.endsAfter ? " · " : null}
            {visit.endsAfter
              ? `jusqu’à demain ${timeOf(appointment.localEndsAt)}`
              : null}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function ClosureLine({ model }: { model: TodayModel }) {
  return (
    <p className="rounded-[20px] bg-sand px-4 py-2.5 text-[14px] text-ink [overflow-wrap:anywhere]">
      {model.closures
        .map(
          (closure) =>
            `Fermé de ${closure.from} à ${closure.to}${closure.reason ? ` · ${closure.reason}` : ""}`,
        )
        .join(" ; ")}
    </p>
  );
}

/** What the day and the week hold; her notes on demand. */
function Holdings({ model }: { model: TodayModel }) {
  const [notesShown, setNotesShown] = useState(false);
  const fill = (day: TodayModel["week"][number]) =>
    day.bookableMinutes > 0
      ? Math.min(
          100,
          Math.round((day.bookedMinutes / day.bookableMinutes) * 100),
        )
      : 0;
  const count = model.notes.length;

  return (
    <section
      aria-label="Chiffres"
      className="mx-auto flex w-full max-w-[520px] flex-col gap-6 xl:col-start-3 xl:row-start-1 xl:max-w-none"
    >
      <div className="grid grid-cols-3 gap-3">
        <Pearl value={String(model.counts.total)} label="Aujourd’hui" />
        <Pearl value={String(model.counts.left)} label="À venir" />
        <Pearl value={String(model.counts.online)} label="En ligne" />
      </div>
      <p className="px-1 text-[14px] text-ink-soft">
        {model.counts.total === 0
          ? "Aucun rendez-vous aujourd’hui."
          : `${model.counts.done} passé${model.counts.done > 1 ? "s" : ""} · ${model.counts.left} à venir · ${model.counts.online} pris en ligne.`}
      </p>

      <div className="ecrin-object flex flex-col gap-3 rounded-[28px] p-5">
        <h2 className={caps}>Cette semaine</h2>
        <p className="text-[15px] text-ink">
          <span className="font-engraved text-[26px]">{model.weekVisits}</span>{" "}
          rendez-vous commençant cette semaine
        </p>
        <ul className="grid grid-cols-7 gap-1.5">
          {model.week.map((day) => (
            <li
              key={day.date}
              className="flex flex-col items-center gap-1 text-[12px] text-ink-soft"
            >
              <span
                aria-hidden="true"
                className="grid aspect-square w-full max-w-10 place-items-center rounded-full"
                style={{
                  background: day.closed
                    ? "var(--sand)"
                    : `conic-gradient(${day.isToday ? "var(--accent)" : "var(--ink-soft)"} ${fill(day)}%, var(--sand) 0)`,
                }}
              >
                <span className="grid size-[72%] place-items-center rounded-full bg-paper-raised text-[12px] text-ink tabular-nums">
                  {dayNumber(day.date)}
                </span>
              </span>
              <span aria-hidden="true">
                {formatWeekdayShort(day.date).slice(0, 2)}
              </span>
              <span className="sr-only">
                {formatWeekdayLong(day.date)} :{" "}
                {day.closed ? "fermé" : `${fill(day)} % réservé`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {count ? (
        <div className="ecrin-object flex flex-col gap-2 rounded-[28px] p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className={caps}>
              À ne pas oublier · {count} note{count > 1 ? "s" : ""}
            </h2>
            <button
              type="button"
              aria-expanded={notesShown}
              onClick={() => setNotesShown(!notesShown)}
              className="min-h-11 cursor-pointer rounded-full px-3 text-[14px] text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {notesShown ? "Masquer" : "Afficher"}
            </button>
          </div>
          {notesShown ? (
            <ul className="flex flex-col gap-2 text-[14.5px] text-ink">
              {model.notes.map(({ appointment }) => (
                <li
                  key={appointment.id}
                  className="border-t border-line pt-2 [overflow-wrap:anywhere] whitespace-pre-line"
                >
                  {timeOf(appointment.localStartsAt)} —{" "}
                  {appointment.client.displayName.split(" ")[0]} :{" "}
                  {appointment.internalNotes!.trim()}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Pearl({ value, label }: { value: ReactNode; label: string }) {
  return (
    <p className="ecrin-object flex aspect-square flex-col items-center justify-center gap-0.5 rounded-full text-center">
      <span className="text-[clamp(24px,7vw,32px)] leading-none font-light text-ink tabular-nums">
        {value}
      </span>
      <span className="font-engraved text-[10px] tracking-[0.12em] text-ink-soft uppercase">
        {label}
      </span>
    </p>
  );
}

const firstName = (visit: TodayVisit) =>
  visit.appointment.client.displayName.split(" ")[0] ?? "";
