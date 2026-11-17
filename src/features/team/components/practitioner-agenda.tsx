"use client";

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Notice } from "@/components/ui/notice";
import { callAction } from "@/features/auth/client/call-action";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { cn } from "@/lib/cn";

import { setMyVisitStatusAction } from "../actions/practitioner";
import type { PractitionerVisitDto } from "../data/practitioner-agenda";

/**
 * A practitioner's screen (docs/TEAM_CONTRACT.md, « Rôle praticienne »):
 * her appointments for a week, with what she needs to do them (the
 * client's name and contact, the options, the notes), and the outcome of
 * each visit. Nothing else: the rest of the business is not hers.
 */

export type PractitionerDay = { date: string; visits: PractitionerVisitDto[] };

function dayTitle(date: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace(/^./, (first) => first.toUpperCase())
    .replace(/ 1 /, " 1er ");
}

function timeOf(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  })
    .format(new Date(instant))
    .replace(":", " h ");
}

const statusLabel: Record<PractitionerVisitDto["status"], string> = {
  confirmed: "Prévu",
  completed: "Réalisé",
  no_show: "Pas venue",
  cancelled: "Annulé",
};

const weekLink =
  "rounded-full border border-line px-3.5 py-1.5 font-medium text-ink-soft hover:border-line-strong hover:text-ink";

export function PractitionerAgenda({
  businessName,
  timeZone,
  today,
  days,
  previousWeek,
  nextWeek,
  thisWeek,
  serverNow,
}: {
  businessName: string;
  timeZone: string;
  today: string;
  days: PractitionerDay[];
  previousWeek: Route;
  nextWeek: Route;
  /** Null when this week is the one shown. */
  thisWeek: Route | null;
  serverNow: number;
}) {
  const count = days.reduce(
    (sum, day) =>
      sum + day.visits.filter((visit) => visit.status !== "cancelled").length,
    0,
  );
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <span className="truncate text-[15px] font-semibold">
            {businessName}
          </span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-7 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[34px] leading-tight sm:text-[40px]">
            Mon agenda
          </h1>
          <p className="text-[15px] text-ink-soft">
            {count === 0
              ? "Aucun rendez-vous pour toi sur ces sept jours."
              : `${count} rendez-vous pour toi sur ces sept jours.`}
          </p>
        </div>

        <nav
          aria-label="Semaines"
          className="flex flex-wrap items-center gap-2 text-[14px]"
        >
          <Link href={previousWeek} className={weekLink}>
            ← Semaine d’avant
          </Link>
          {thisWeek ? (
            <Link href={thisWeek} className={weekLink}>
              Aujourd’hui
            </Link>
          ) : null}
          <Link href={nextWeek} className={weekLink}>
            Semaine d’après →
          </Link>
        </nav>

        <ol className="flex flex-col gap-7">
          {days.map((day) => (
            <li
              key={day.date}
              aria-labelledby={`day-${day.date}`}
              className="flex flex-col gap-3"
            >
              <h2
                id={`day-${day.date}`}
                className="flex items-baseline gap-2 border-b border-line pb-2 text-[17px] font-semibold"
              >
                {dayTitle(day.date)}
                {day.date === today ? (
                  <span className="text-[13px] font-medium text-ink-muted">
                    Aujourd’hui
                  </span>
                ) : null}
              </h2>
              {day.visits.length === 0 ? (
                <p className="text-[14px] text-ink-muted">Rien de prévu.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {day.visits.map((visit) => (
                    <Visit
                      key={`${visit.id}:${visit.version}`}
                      visit={visit}
                      timeZone={timeZone}
                      started={Date.parse(visit.startsAt) <= serverNow}
                    />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}

function Visit({
  visit,
  timeZone,
  started,
}: {
  visit: PractitionerVisitDto;
  timeZone: string;
  started: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = visit.status === "cancelled";
  const name = [visit.client.firstName, visit.client.lastName]
    .filter(Boolean)
    .join(" ");

  async function mark(status: "completed" | "no_show" | "confirmed") {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await callAction(() =>
      setMyVisitStatusAction({
        appointmentId: visit.id,
        expectedVersion: visit.version,
        status,
      }),
    );
    setBusy(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    if (result.error.code === "stale_appointment") {
      setError("Ce rendez-vous a changé entre-temps : le voici à jour.");
      router.refresh();
      return;
    }
    setError(
      result.error.code === "network"
        ? "Pas de réponse : rien n’a peut-être été noté. Réessaie."
        : "Ça n’a pas été noté. Réessaie dans un instant.",
    );
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-line bg-paper-raised p-4",
        cancelled && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[15px] font-semibold tabular-nums">
          {timeOf(visit.startsAt, timeZone)} – {timeOf(visit.endsAt, timeZone)}
        </p>
        <span
          className={cn(
            "text-[13px] font-medium",
            visit.status === "completed"
              ? "text-success-strong"
              : visit.status === "no_show"
                ? "text-danger-strong"
                : "text-ink-muted",
          )}
        >
          {statusLabel[visit.status]}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <p
          className={cn(
            "text-[17px] font-semibold wrap-anywhere",
            cancelled && "line-through",
          )}
        >
          {name}
        </p>
        <p className="text-[14.5px] text-ink-soft">
          {visit.serviceName}
          {visit.options.length > 0
            ? ` · ${visit.options.map((option) => option.label).join(", ")}`
            : ""}
        </p>
      </div>

      {visit.client.phone || visit.client.email ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          {visit.client.phone ? (
            <a
              href={`tel:${visit.client.phone}`}
              className="font-medium text-ink underline decoration-line-strong underline-offset-4"
            >
              {visit.client.phone}
            </a>
          ) : null}
          {visit.client.email ? (
            <a
              href={`mailto:${visit.client.email}`}
              className="text-ink-soft underline decoration-line underline-offset-4 wrap-anywhere"
            >
              {visit.client.email}
            </a>
          ) : null}
        </p>
      ) : null}

      {visit.internalNotes ? (
        <p className="rounded-xl bg-sand/60 px-3 py-2 text-[14px] leading-relaxed whitespace-pre-line text-ink-soft">
          {visit.internalNotes}
        </p>
      ) : null}

      {!cancelled && started ? (
        <div className="flex flex-wrap gap-2">
          {visit.status === "confirmed" ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mark("completed")}
                className="h-10 cursor-pointer rounded-full bg-ink px-4 text-[14px] font-semibold text-paper disabled:opacity-60"
              >
                Réalisé
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mark("no_show")}
                className="h-10 cursor-pointer rounded-full border border-line-strong px-4 text-[14px] font-semibold text-ink disabled:opacity-60"
              >
                Pas venue
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void mark("confirmed")}
              className="h-10 cursor-pointer rounded-full px-1 text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 disabled:opacity-60"
            >
              Rouvrir
            </button>
          )}
        </div>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
    </li>
  );
}
