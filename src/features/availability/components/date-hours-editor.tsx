"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

import {
  listDateHoursAction,
  readDateHoursAction,
  saveDateHoursAction,
} from "../actions/date-hours";
import {
  MAX_RANGES_PER_DAY,
  nextRange,
  timeOptions,
  toMinutes,
  WEEKDAY_LABELS,
} from "../client/hours-draft";
import { localDateSchema } from "../schemas/availability";

type Range = { startsAt: string; endsAt: string };
type SavedDate = { date: string; ranges: Range[] };
/** What a date has: its own ranges (null: the usual ones), and the usual. */
type Loaded = { ranges: Range[] | null; usual: Range[] };
/** "10:00 – 12:00 · 18:00 – 20:00". */
const rangesLabel = (ranges: Range[]) =>
  ranges.map((range) => `${range.startsAt} – ${range.endsAt}`).join(" · ");
const dateLabel = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const fieldClass =
  "min-h-11 w-full min-w-0 rounded-xl border border-line bg-paper px-3 text-base text-ink";

export function DateHoursEditor({ businessId }: { businessId: string }) {
  const [date, setDate] = useState("");
  const [savedDates, setSavedDates] = useState<SavedDate[]>([]);
  const [listFailed, setListFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const dateInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void callAction(() => listDateHoursAction({ businessId })).then(
      (result) => {
        if (!current) return;
        setListFailed(!result.ok);
        if (result.ok) setSavedDates(result.data);
      },
    );
    return () => {
      current = false;
    };
  }, [businessId, revision]);

  const reloadDates = () => setRevision((value) => value + 1);

  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-4 sm:p-5">
      <h2 className="font-display text-[26px] leading-tight text-ink">
        Horaires par date
      </h2>
      <p className="text-[14px] text-ink-muted">
        Choisis n’importe quel jour du calendrier : tu pars de tes horaires
        habituels de ce jour-là, et tu ajoutes, modifies ou retires des plages
        pour cette date seulement.
      </p>
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
        Date à modifier
        <input
          ref={dateInput}
          type="date"
          max="9999-12-31"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className={fieldClass}
        />
      </label>
      {localDateSchema.safeParse(date).success ? (
        <DateHoursForm
          key={date}
          date={date}
          businessId={businessId}
          onSaved={reloadDates}
          onChooseAnother={() => {
            setDate("");
            dateInput.current?.focus();
          }}
        />
      ) : null}
      {savedDates.length ? (
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Prochaines dates personnalisées ({savedDates.length})
          </summary>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {savedDates.map((entry) => (
              <li key={entry.date}>
                <button
                  type="button"
                  onClick={() => {
                    setDate(entry.date);
                    dateInput.current?.focus();
                  }}
                  className="flex min-h-11 w-full cursor-pointer flex-col rounded-xl border border-line bg-paper px-3 py-2 text-left text-sm text-ink"
                >
                  <time dateTime={entry.date} className="font-medium">
                    {dateLabel.format(new Date(`${entry.date}T00:00:00Z`))}
                  </time>
                  <span className="text-ink-muted">
                    {rangesLabel(entry.ranges)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {listFailed ? (
        <button
          type="button"
          onClick={reloadDates}
          className="self-start text-sm font-semibold underline"
        >
          Recharger la liste des dates
        </button>
      ) : null}
    </section>
  );
}

/** "HH:MM" ranges in order of their start. */
const sorted = (ranges: Range[]) =>
  [...ranges].sort((a, b) => toMinutes(a.startsAt) - toMinutes(b.startsAt));
const keyOf = (ranges: Range[]) =>
  sorted(ranges)
    .map((range) => `${range.startsAt}-${range.endsAt}`)
    .join("|");

/** Why these ranges cannot be saved, or null. */
function problemOf(ranges: Range[]) {
  if (ranges.length === 0)
    return "Ajoute au moins une plage. Pour ne pas travailler de la journée, planifie plutôt une fermeture.";
  if (
    ranges.some((range) => toMinutes(range.startsAt) >= toMinutes(range.endsAt))
  )
    return "Chaque plage doit finir après son début.";
  const ordered = sorted(ranges);
  if (
    ordered.some(
      (range, index) =>
        index > 0 &&
        toMinutes(range.startsAt) < toMinutes(ordered[index - 1]!.endsAt),
    )
  )
    return "Deux plages se chevauchent.";
  return null;
}

function DateHoursForm({
  date,
  businessId,
  onSaved,
  onChooseAnother,
}: {
  date: string;
  businessId: string;
  onSaved: () => void;
  onChooseAnother: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [draft, setDraft] = useState<Range[]>([]);
  const [read, setRead] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);
  const weekday =
    WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()]!.toLowerCase();

  useEffect(() => {
    let current = true;
    void callAction(() => readDateHoursAction({ businessId, date })).then(
      (result) => {
        if (!current) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setLoaded(result.data);
        // A date never customised starts from the usual ranges of its day:
        // adding one keeps them, as she expects.
        setDraft(result.data.ranges ?? result.data.usual);
      },
    );
    return () => {
      current = false;
    };
  }, [businessId, date, read]);

  const reload = () => {
    setError(null);
    setLoaded(undefined);
    setRead((value) => value + 1);
  };

  async function save(next: Range[] | null) {
    if (busy.current || loaded === undefined) return;
    busy.current = true;
    setPending(true);
    setNotice("");
    setError(null);
    try {
      const result = await callAction(() =>
        saveDateHoursAction({
          businessId,
          date,
          ranges: next && sorted(next),
          expected: loaded.ranges,
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLoaded({ ranges: result.data, usual: loaded.usual });
      setDraft(result.data ?? loaded.usual);
      onSaved();
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

  const stale = error?.code === "stale_business_hours";
  const locked = pending || stale;
  const problem = problemOf(draft);
  const changed =
    loaded !== undefined &&
    keyOf(draft) !== keyOf(loaded.ranges ?? loaded.usual);
  const usualLabel = loaded?.usual.length ? rangesLabel(loaded.usual) : "fermé";
  const following = nextRange(draft);
  const update = (index: number, change: Partial<Range>) =>
    setDraft((current) =>
      current.map((range, position) =>
        position === index ? { ...range, ...change } : range,
      ),
    );
  return (
    <>
      {loaded !== undefined ? (
        <form
          className="flex flex-col gap-3"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && !problem && !locked) void save(draft);
          }}
        >
          <p className="text-sm text-ink-soft">
            {loaded.ranges
              ? `Horaires personnalisés pour cette date. Le ${weekday} habituellement : ${usualLabel}.`
              : loaded.usual.length
                ? `Tes horaires habituels du ${weekday} sont déjà remplis : ajoute, modifie ou retire des plages. En enregistrant, ces plages remplacent tes horaires du ${weekday} pour cette date seulement.`
                : `Tu ne travailles pas le ${weekday} d’habitude : ajoute les plages où tu veux ouvrir ce jour-là.`}
          </p>
          {draft.length ? (
            <ol
              className="flex flex-col gap-2"
              aria-label="Plages de cette date"
            >
              {draft.map((range, index) => (
                <li
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
                >
                  <TimeSelect
                    label={`Début de la plage ${index + 1}`}
                    visibleLabel="De"
                    value={range.startsAt}
                    disabled={locked}
                    exclude="24:00"
                    onChange={(startsAt) => update(index, { startsAt })}
                  />
                  <TimeSelect
                    label={`Fin de la plage ${index + 1}`}
                    visibleLabel="À"
                    value={range.endsAt}
                    disabled={locked}
                    exclude="00:00"
                    onChange={(endsAt) => update(index, { endsAt })}
                  />
                  <button
                    type="button"
                    disabled={locked}
                    aria-label={`Retirer la plage ${index + 1}`}
                    onClick={() =>
                      setDraft((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                    className="flex size-12 cursor-pointer items-center justify-center rounded-xl text-ink-muted hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <CloseIcon size={18} />
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {draft.length < MAX_RANGES_PER_DAY && following ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => setDraft((current) => [...current, following])}
              className="flex h-10 w-fit cursor-pointer items-center gap-1.5 rounded-xl px-2 text-[13.5px] font-medium text-ink-soft hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <PlusIcon size={16} />
              Ajouter une plage
            </button>
          ) : null}
          {problem && changed ? (
            <p role="alert" className="text-sm text-danger">
              {problem}
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
              disabled={!changed || Boolean(problem) || stale}
            >
              Enregistrer cette date
            </Button>
            {loaded.ranges ? (
              <Button
                type="button"
                size="md"
                variant="secondary"
                disabled={locked}
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
      {notice ? (
        <Notice
          tone="success"
          action={
            <button
              type="button"
              onClick={onChooseAnother}
              className="font-semibold underline"
            >
              Choisir une autre date
            </button>
          }
        >
          {notice}
        </Notice>
      ) : null}
      {error ? (
        <Notice
          tone="error"
          action={
            stale || loaded === undefined ? (
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

function TimeSelect({
  label,
  visibleLabel,
  value,
  disabled,
  exclude,
  onChange,
}: {
  label: string;
  visibleLabel: string;
  value: string;
  disabled: boolean;
  /** 24:00 cannot start a range, 00:00 cannot end one. */
  exclude: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12.5px] text-ink-muted" aria-hidden="true">
        {visibleLabel}
      </span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      >
        {timeOptions(value)
          .filter((time) => time !== exclude || time === value)
          .map((time) => (
            <option key={time} value={time}>
              {time === "24:00" ? "24:00 (minuit)" : time}
            </option>
          ))}
      </select>
    </label>
  );
}
