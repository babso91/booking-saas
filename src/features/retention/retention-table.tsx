"use client";

import { useEffect, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  monthName,
  overallRate,
  percent,
  readCohort,
  type RetentionActions,
  type RetentionReportDto,
} from "./contract";

// How many new clients come back. Each row says what it can honestly say:
// a rate only when every client's window has ended and the cohort is big
// enough; otherwise why not yet. The definition is written above the
// numbers; no cause is claimed, no amount inferred.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const windows = [30, 60, 90] as const;

export function RetentionTable({ actions }: { actions: RetentionActions }) {
  const [windowDays, setWindowDays] = useState<(typeof windows)[number]>(60);
  const [answer, setAnswer] = useState<{
    key: string;
    value: RetentionReportDto | "error";
  } | null>(null);
  const [run, setRun] = useState(0);
  const key = `${windowDays}:${run}`;

  useEffect(() => {
    let current = true;
    void actions.read({ windowDays }).then((result) => {
      if (current) setAnswer({ key, value: result.ok ? result.data : "error" });
    });
    return () => {
      current = false;
    };
  }, [actions, windowDays, key]);

  const report = answer?.key === key ? answer.value : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] leading-tight text-ink">
          Fidélisation
        </h1>
        <p className="max-w-prose text-[15px] text-ink-soft">
          Parmi les nouvelles clientes d’un mois, combien sont revenues. Une
          cliente compte comme revenue quand une deuxième visite est terminée
          dans les {windowDays} jours après sa première.
        </p>
      </header>

      <div
        role="group"
        aria-label="Fenêtre de retour"
        className="flex w-fit rounded-full bg-sand p-1"
      >
        {windows.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={windowDays === value}
            onClick={() => setWindowDays(value)}
            className={cn(
              "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium",
              windowDays === value
                ? "bg-paper-raised text-ink shadow-sm"
                : "text-ink-soft",
            )}
          >
            {value} jours
          </button>
        ))}
      </div>

      {report === null ? (
        <div role="status" aria-label="Chargement…">
          <div className="h-56 animate-pulse rounded-3xl bg-sand/70" />
        </div>
      ) : report === "error" ? (
        <Notice
          tone="error"
          title="Les chiffres n’ont pas pu être chargés"
          action={
            <button
              type="button"
              className={linkAction}
              onClick={() => setRun((n) => n + 1)}
            >
              Réessayer
            </button>
          }
        />
      ) : (
        <Report report={report} />
      )}
    </div>
  );
}

function Report({ report }: { report: RetentionReportDto }) {
  if (!report.cohorts.length)
    return (
      <Notice tone="info" title="Pas encore de données">
        Les chiffres apparaîtront après les premières visites terminées de
        nouvelles clientes.
      </Notice>
    );
  const overall = overallRate(report);
  return (
    <>
      <div className="rounded-3xl bg-sand/60 px-5 py-4">
        {overall ? (
          <>
            <p className="font-display text-[40px] leading-none text-ink tabular-nums">
              {percent(overall.rate)}
            </p>
            <p className="mt-2 text-[14px] text-ink-soft">
              reviennent dans les {report.windowDays} jours, sur{" "}
              {overall.clients} nouvelles clientes ({overall.cohorts}{" "}
              {overall.cohorts > 1 ? "mois complets" : "mois complet"}).
            </p>
          </>
        ) : (
          <p className="text-[15px] text-ink">
            Données insuffisantes : aucun mois n’a encore une fenêtre de{" "}
            {report.windowDays} jours terminée avec assez de clientes.
          </p>
        )}
      </div>

      <table className="w-full border-separate border-spacing-y-1.5 text-[14px]">
        <caption className="sr-only">
          Retour des nouvelles clientes par mois de première visite
        </caption>
        <thead>
          <tr className="text-left text-[12.5px] text-ink-muted">
            <th scope="col" className="px-3 font-medium">
              Première visite
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Nouvelles
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Revenues
            </th>
          </tr>
        </thead>
        <tbody>
          {report.cohorts.map((cohort) => {
            const reading = readCohort(cohort, report.minCohortSize);
            return (
              <tr key={cohort.month} className="bg-paper-raised">
                <th
                  scope="row"
                  className="rounded-l-2xl px-3 py-3 text-left font-medium text-ink first-letter:uppercase"
                >
                  {monthName(cohort.month)}
                </th>
                <td className="px-3 py-3 text-right tabular-nums text-ink">
                  {cohort.size}
                </td>
                <td className="rounded-r-2xl px-3 py-3 text-right">
                  {reading.kind === "rate" ? (
                    <span className="font-semibold tabular-nums text-ink">
                      {percent(reading.rate)}{" "}
                      <span className="font-normal text-ink-muted">
                        ({cohort.returned})
                      </span>
                    </span>
                  ) : reading.kind === "immature" ? (
                    <span className="text-[13px] text-ink-muted">
                      {cohort.returned} pour l’instant · fenêtre en cours
                    </span>
                  ) : (
                    <span className="text-[13px] text-ink-muted">
                      {cohort.returned} · trop peu de clientes
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        Un taux n’est affiché que si la fenêtre de chaque cliente est terminée
        et si le mois compte au moins {report.minCohortSize} nouvelles clientes.
        Visites terminées uniquement ; ces chiffres ne disent pas pourquoi une
        cliente revient. Définition {report.definitionVersion}, au{" "}
        {new Intl.DateTimeFormat("fr-FR", {
          day: "numeric",
          month: "long",
          timeZone: report.timeZone,
        })
          .format(new Date(report.asOf))
          .replace(/^1 /, "1er ")}
        .
      </p>
    </>
  );
}
