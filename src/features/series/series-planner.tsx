"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/cn";

import {
  MAX_OCCURRENCES,
  seriesErrors,
  type SeriesActions,
  type SeriesOccurrence,
  type SeriesPreview,
  type SeriesPreviewInput,
} from "./contract";
import { clockOf, dayOf } from "./local-time";

// A series she books for one client. The preview books nothing; every
// date is shown with its state, a taken one is never silently dropped, a
// time that happens twice or never (clocks changing) waits for her
// explicit choice. Confirming creates all kept dates or none.

type Choice = string | "skip";
const SKIP = "skip";

const euros = (cents: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
    .format(cents / 100)
    .replace(/,00\s/, " ");

const duration = (minutes: number) =>
  minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, "0")}` : ""}`;

/** What she must decide for this date before confirming, if anything. */
const needsChoice = (occurrence: SeriesOccurrence) =>
  occurrence.state === "ambiguous" || occurrence.state === "nonexistent";

const excluded = (occurrence: SeriesOccurrence) =>
  occurrence.state === "conflict" || occurrence.state === "outside_horizon";

function initialChoices(
  occurrences: SeriesOccurrence[],
  before: Record<string, Choice>,
) {
  const choices: Record<string, Choice> = {};
  for (const occurrence of occurrences) {
    const kept = before[occurrence.key];
    if (excluded(occurrence)) continue;
    // Her earlier choice stays when it still fits this date.
    if (kept && (kept === SKIP || occurrence.utcCandidates.includes(kept))) {
      choices[occurrence.key] = kept;
      continue;
    }
    if (occurrence.state === "available")
      choices[occurrence.key] = occurrence.utcCandidates[0]!;
  }
  return choices;
}

export function SeriesPlanner({
  clientName,
  rule: base,
  actions,
}: {
  clientName: string;
  /** Client, service, options and the first appointment, from the agenda. */
  rule: Omit<SeriesPreviewInput, "repeatEveryWeeks" | "end">;
  actions: SeriesActions;
}) {
  const [every, setEvery] = useState(2);
  const [endKind, setEndKind] = useState<"count" | "until">("count");
  const [count, setCount] = useState(6);
  const [until, setUntil] = useState("");
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [review, setReview] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const requestIds = useRef(new Map<string, string>());

  const input = (): SeriesPreviewInput => ({
    ...base,
    repeatEveryWeeks: every,
    end: endKind === "count" ? { count } : { untilLocalDate: until },
  });

  function ruleChanged() {
    setPreview(null);
    setNotice(null);
    setReview(new Set());
  }

  async function load(message: string | null, toReview: string[] = []) {
    if (endKind === "until" && !until)
      return setRuleError("Choisis la date de fin.");
    if (endKind === "until" && until < base.firstLocalStart.slice(0, 10))
      return setRuleError("La date de fin est avant le premier rendez-vous.");
    setRuleError(null);
    setBusy("preview");
    const result = await actions.preview(input());
    setBusy(null);
    if (!result.ok) {
      setPreview(null);
      return setNotice(
        result.error.code === seriesErrors.tooMany
          ? `Au plus ${MAX_OCCURRENCES} rendez-vous par série : réduis le nombre ou la date de fin.`
          : result.error.code === "network"
            ? "Pas de réponse. Réessaie."
            : "Les dates n’ont pas pu être calculées. Réessaie dans un instant.",
      );
    }
    setChoices((before) => initialChoices(result.data.occurrences, before));
    setPreview(result.data);
    setReview(new Set(toReview));
    setNotice(message);
  }

  if (done !== null)
    return (
      <Notice tone="success" title={`${done} rendez-vous créés`}>
        La série de {clientName} est dans ton agenda. Chaque rendez-vous se
        modifie ou s’annule seul, sans toucher aux autres.
      </Notice>
    );

  const occurrences = preview?.occurrences ?? [];
  const kept = occurrences.filter(
    (o) => choices[o.key] && choices[o.key] !== SKIP,
  );
  const pending = occurrences.filter(
    (o) => needsChoice(o) && choices[o.key] === undefined,
  );
  const reasons = {
    conflict: occurrences.filter((o) => o.state === "conflict").length,
    horizon: occurrences.filter((o) => o.state === "outside_horizon").length,
    skipped: occurrences.filter((o) => choices[o.key] === SKIP).length,
  };

  async function commit() {
    if (!preview || busy || pending.length || !kept.length) return;
    const selected = kept.map((o) => ({
      key: o.key,
      startsAt: choices[o.key]!,
    }));
    const key = `${preview.previewVersion}:${JSON.stringify(selected)}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy("commit");
    setNotice(null);
    const result = await actions.commit({
      requestId: requestIds.current.get(key)!,
      previewVersion: preview.previewVersion,
      selected,
    });
    setBusy(null);
    if (result.ok) return setDone(result.data.appointmentIds.length);
    const { code, keys } = result.error;
    if (code === seriesErrors.calendarConflict)
      return load(
        "Une place a été prise entre-temps : rien n’a été créé. Revois les dates signalées, puis confirme de nouveau.",
        keys ?? [],
      );
    if (code === seriesErrors.quoteChanged)
      return load(
        "Le prix ou la durée de la prestation a changé : rien n’a été créé. Vérifie, puis confirme de nouveau.",
      );
    if (code === seriesErrors.stale)
      return load(
        "Les dates ont changé depuis l’aperçu : rien n’a été créé. Les voici à jour.",
      );
    setNotice(
      code === "network"
        ? "Pas de réponse. Réessaie : la même série n’est jamais créée deux fois."
        : "La série n’a pas pu être créée. Rien n’a été enregistré.",
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-[26px] leading-tight text-ink">
          Répéter ce rendez-vous
        </h2>
        <p className="text-[14.5px] text-ink-soft">
          Pour {clientName}, à partir du {dayOf(base.firstLocalStart)} à{" "}
          {base.firstLocalStart.slice(11)}. Rien n’est réservé avant ta
          confirmation.
        </p>
      </header>

      <section
        aria-label="Règle de répétition"
        className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
      >
        <SelectField
          label="Fréquence"
          value={String(every)}
          onChange={(event) => {
            setEvery(Number(event.target.value));
            ruleChanged();
          }}
        >
          {[1, 2, 3, 4, 5, 6, 8].map((weeks) => (
            <option key={weeks} value={weeks}>
              {weeks === 1 ? "Chaque semaine" : `Toutes les ${weeks} semaines`}
            </option>
          ))}
        </SelectField>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[15px] font-medium text-ink">Fin</legend>
          <div
            role="group"
            aria-label="Fin de la série"
            className="flex w-fit rounded-full bg-sand p-1"
          >
            {(
              [
                ["count", "Après un nombre"],
                ["until", "À une date"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={endKind === value}
                onClick={() => {
                  setEndKind(value);
                  ruleChanged();
                }}
                className={cn(
                  "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium",
                  endKind === value
                    ? "bg-paper-raised text-ink shadow-sm"
                    : "text-ink-soft",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {endKind === "count" ? (
            <SelectField
              label="Nombre de rendez-vous, celui-ci compris"
              value={String(count)}
              onChange={(event) => {
                setCount(Number(event.target.value));
                ruleChanged();
              }}
            >
              {Array.from({ length: MAX_OCCURRENCES - 1 }, (_, i) => i + 2).map(
                (n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ),
              )}
            </SelectField>
          ) : (
            <TextField
              label="Dernier rendez-vous au plus tard le"
              name="series-until"
              type="date"
              value={until}
              error={ruleError ?? undefined}
              min={base.firstLocalStart.slice(0, 10)}
              onChange={(event) => {
                setUntil(event.target.value);
                setRuleError(null);
                ruleChanged();
              }}
            />
          )}
        </fieldset>
        {!preview ? (
          <Button
            size="md"
            variant="secondary"
            state={busy === "preview" ? "loading" : "idle"}
            loadingLabel="Calcul des dates…"
            onClick={() => void load(null)}
          >
            Voir les dates
          </Button>
        ) : null}
      </section>

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      {preview ? (
        <section aria-label="Dates de la série" className="flex flex-col gap-3">
          <p className="text-[14px] text-ink-soft">
            {preview.quote.serviceName} ·{" "}
            {duration(preview.quote.durationMinutes)} ·{" "}
            {euros(preview.quote.priceCents)} chacun
          </p>
          <ol className="flex flex-col gap-2">
            {occurrences.map((occurrence) => (
              <OccurrenceRow
                key={occurrence.key}
                occurrence={occurrence}
                timeZone={preview.timeZone}
                choice={choices[occurrence.key]}
                flagged={review.has(occurrence.key)}
                disabled={busy !== null}
                onChoose={(choice) =>
                  setChoices((current) => ({
                    ...current,
                    [occurrence.key]: choice,
                  }))
                }
              />
            ))}
          </ol>

          <div
            className="flex flex-col gap-3 rounded-3xl bg-sand/60 px-5 py-4"
            aria-live="polite"
          >
            <p className="text-[15px] font-medium text-ink">
              {kept.length === 0
                ? "Aucune date retenue."
                : `${kept.length} rendez-vous ${kept.length > 1 ? "seront créés" : "sera créé"}.`}
            </p>
            {reasons.conflict + reasons.horizon + reasons.skipped ? (
              <ul className="flex flex-col gap-0.5 text-[13.5px] text-ink-soft">
                {reasons.conflict ? (
                  <li>
                    {reasons.conflict} exclu{reasons.conflict > 1 ? "s" : ""} :
                    créneau déjà pris
                  </li>
                ) : null}
                {reasons.horizon ? (
                  <li>
                    {reasons.horizon} exclu{reasons.horizon > 1 ? "s" : ""} :
                    trop loin dans l’agenda
                  </li>
                ) : null}
                {reasons.skipped ? (
                  <li>
                    {reasons.skipped} retiré{reasons.skipped > 1 ? "s" : ""} par
                    toi
                  </li>
                ) : null}
              </ul>
            ) : null}
            {pending.length ? (
              <p className="text-[13.5px] font-medium text-danger">
                {pending.length === 1
                  ? "Une date attend ton choix."
                  : `${pending.length} dates attendent ton choix.`}
              </p>
            ) : null}
            <Button
              size="md"
              state={busy === "commit" ? "loading" : "idle"}
              loadingLabel="Création…"
              disabled={
                pending.length > 0 ||
                kept.length === 0 ||
                (busy !== null && busy !== "commit")
              }
              onClick={() => void commit()}
            >
              {kept.length
                ? `Créer les ${kept.length} rendez-vous`
                : "Créer les rendez-vous"}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function OccurrenceRow({
  occurrence,
  timeZone,
  choice,
  flagged,
  disabled,
  onChoose,
}: {
  occurrence: SeriesOccurrence;
  timeZone: string;
  choice: Choice | undefined;
  flagged: boolean;
  disabled: boolean;
  onChoose: (choice: Choice) => void;
}) {
  const day = dayOf(occurrence.requestedLocalStart);
  const asked = occurrence.requestedLocalStart.slice(11);
  const name = `occurrence-${occurrence.key}`;
  const frame = cn(
    "flex flex-col gap-2 rounded-2xl border px-4 py-3",
    flagged ? "border-danger" : "border-line bg-paper-raised",
  );
  const title = (
    <span className="text-[15px] font-medium text-ink first-letter:uppercase">
      {day}
    </span>
  );
  const flag = flagged ? (
    <span className="text-[13px] font-medium text-danger">À revoir</span>
  ) : null;

  if (occurrence.state === "available")
    return (
      <li className={frame}>
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex flex-col">
            {title}
            <span className="text-[13.5px] text-ink-soft">{asked}</span>
            {flag}
          </span>
          <input
            type="checkbox"
            checked={choice !== SKIP}
            disabled={disabled}
            aria-label={`Garder le ${day}`}
            onChange={(event) =>
              onChoose(
                event.target.checked ? occurrence.utcCandidates[0]! : SKIP,
              )
            }
            className="size-5 accent-[var(--ink)]"
          />
        </label>
      </li>
    );

  if (excluded(occurrence))
    return (
      <li className={cn(frame, "opacity-75")}>
        <span className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            {title}
            <span className="text-[13.5px] text-ink-soft line-through">
              {asked}
            </span>
          </span>
          <span className="rounded-full bg-sand px-2.5 py-0.5 text-[12.5px] font-medium text-ink-soft">
            {occurrence.state === "conflict"
              ? "Créneau déjà pris"
              : "Trop loin dans l’agenda"}
          </span>
        </span>
      </li>
    );

  const options =
    occurrence.state === "ambiguous"
      ? occurrence.utcCandidates.map((instant, index) => {
          const { time, offset } = clockOf(instant, timeZone);
          return {
            value: instant,
            label: `${time} ${offset} · ${index === 0 ? "avant" : "après"} le changement d’heure`,
          };
        })
      : occurrence.utcCandidates.slice(0, 1).map((instant) => ({
          value: instant,
          label: `À ${clockOf(instant, timeZone).time} à la place`,
        }));
  return (
    <li className={cn(frame, choice === undefined && "border-accent")}>
      <fieldset className="flex flex-col gap-2">
        <legend className="flex flex-col">
          {title}
          <span className="text-[13.5px] text-ink-soft">
            {occurrence.state === "ambiguous"
              ? `${asked} existe deux fois ce jour-là (passage à l’heure d’hiver) : choisis laquelle.`
              : `${asked} n’existe pas ce jour-là (passage à l’heure d’été) : choisis une autre heure ou retire la date.`}
          </span>
          {flag}
        </legend>
        {[...options, { value: SKIP, label: "Ne pas garder cette date" }].map(
          (option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink"
            >
              <input
                type="radio"
                name={name}
                checked={choice === option.value}
                disabled={disabled}
                onChange={() => onChoose(option.value)}
                className="size-4 accent-[var(--ink)]"
              />
              {option.label}
            </label>
          ),
        )}
      </fieldset>
    </li>
  );
}
