"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

import {
  readDateHoursAction,
  saveDateHoursAction,
} from "../actions/date-hours";
import { TIME_OPTIONS, timeOptions } from "../client/hours-draft";
import { localDateSchema } from "../schemas/availability";

type Range = { startsAt: string; endsAt: string };
const emptyRange: Range = { startsAt: "", endsAt: "" };
const fieldClass =
  "min-h-11 w-full min-w-0 rounded-xl border border-line bg-paper px-3 text-base text-ink";

export function DateHoursEditor({ businessId }: { businessId: string }) {
  const [date, setDate] = useState("");

  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-4 sm:p-5">
      <h2 className="font-display text-[26px] leading-tight text-ink">
        Horaires par date
      </h2>
      <p className="text-[14px] text-ink-muted">
        Choisis une date pour fixer ses heures d’ouverture. Les autres jours
        suivent leurs horaires habituels.
      </p>
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
        Date à modifier
        <input
          type="date"
          max="9999-12-31"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className={fieldClass}
        />
      </label>
      {localDateSchema.safeParse(date).success ? (
        <DateHoursForm key={date} date={date} businessId={businessId} />
      ) : null}
    </section>
  );
}

function DateHoursForm({
  date,
  businessId,
}: {
  date: string;
  businessId: string;
}) {
  const [saved, setSaved] = useState<Range | null | undefined>(undefined);
  const [hours, setHours] = useState<Range>(emptyRange);
  const [read, setRead] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let current = true;
    void callAction(() => readDateHoursAction({ businessId, date })).then(
      (result) => {
        if (!current) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSaved(result.data);
        setHours(result.data ?? emptyRange);
      },
    );
    return () => {
      current = false;
    };
  }, [businessId, date, read]);

  const reload = () => {
    setError(null);
    setSaved(undefined);
    setRead((value) => value + 1);
  };

  async function save(next: Range | null) {
    if (busy.current || saved === undefined) return;
    busy.current = true;
    setPending(true);
    setNotice("");
    setError(null);
    try {
      const result = await callAction(() =>
        saveDateHoursAction({ businessId, date, hours: next, expected: saved }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(result.data);
      setHours(result.data ?? emptyRange);
      setNotice(
        result.data
          ? "Horaires enregistrés pour cette date."
          : "Horaires habituels rétablis.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const invalidOrder = Boolean(
    hours.startsAt && hours.endsAt && hours.endsAt <= hours.startsAt,
  );
  const changed =
    hours.startsAt !== saved?.startsAt || hours.endsAt !== saved?.endsAt;
  const stale = error?.code === "stale_business_hours";
  return (
    <>
      {saved !== undefined ? (
        <form
          className="flex flex-col gap-3"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              changed &&
              !invalidOrder &&
              !stale &&
              hours.startsAt &&
              hours.endsAt
            ) {
              void save(hours);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium text-ink">
              Ouverture
              <select
                aria-label="Ouverture"
                value={hours.startsAt}
                disabled={pending || stale}
                onChange={(event) =>
                  setHours({ ...hours, startsAt: event.target.value })
                }
                className={fieldClass}
                required
              >
                <option value="">Choisir</option>
                {(hours.startsAt ? timeOptions(hours.startsAt) : TIME_OPTIONS)
                  .filter((time) => time !== "24:00")
                  .map((time) => (
                    <option key={time}>{time}</option>
                  ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium text-ink">
              Fermeture
              <select
                aria-label="Fermeture"
                value={hours.endsAt}
                disabled={pending || stale}
                onChange={(event) =>
                  setHours({ ...hours, endsAt: event.target.value })
                }
                className={fieldClass}
                required
              >
                <option value="">Choisir</option>
                {(hours.endsAt ? timeOptions(hours.endsAt) : TIME_OPTIONS)
                  .filter((time) => time !== "00:00")
                  .map((time) => (
                    <option key={time} value={time}>
                      {time === "24:00" ? "24:00 (minuit)" : time}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {invalidOrder ? (
            <p role="alert" className="text-sm text-danger">
              La fermeture doit être après l’ouverture.
            </p>
          ) : null}
          <p className="text-sm text-ink-muted">
            Les rendez-vous déjà pris restent dans ton agenda.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="md"
              state={pending ? "loading" : "idle"}
              disabled={
                !changed ||
                !hours.startsAt ||
                !hours.endsAt ||
                invalidOrder ||
                stale
              }
            >
              Enregistrer cette date
            </Button>
            {saved ? (
              <Button
                type="button"
                size="md"
                variant="secondary"
                disabled={pending || stale}
                onClick={() => void save(null)}
              >
                Rétablir les horaires habituels
              </Button>
            ) : null}
          </div>
        </form>
      ) : !error ? (
        <p role="status" className="text-sm text-ink-muted">
          Chargement des horaires…
        </p>
      ) : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? (
        <Notice
          tone="error"
          action={
            stale || saved === undefined ? (
              <button
                type="button"
                onClick={reload}
                className="font-semibold underline"
              >
                Recharger les horaires
              </button>
            ) : undefined
          }
        >
          {stale
            ? "Cette date a été modifiée ailleurs. Recharge ses horaires avant de réessayer."
            : describeError(error).message}
        </Notice>
      ) : null}
    </>
  );
}
