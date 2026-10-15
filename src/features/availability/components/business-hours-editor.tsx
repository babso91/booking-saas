"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import {
  listBusinessHoursAction,
  replaceBusinessHoursAction,
} from "@/features/availability/actions/schedule";
import { cn } from "@/lib/cn";

import {
  checkWeek,
  hoursFromWeek,
  MAX_RANGES_PER_DAY,
  nextRange,
  rangeLabel,
  scheduleKey,
  serverDayErrors,
  timeOptions,
  WEEKDAY_LABELS,
  weekFromHours,
  type DayDraft,
  type DayErrors,
  type HourRange,
} from "../client/hours-draft";

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready" };

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/**
 * The weekly opening hours, in the business time zone (wall clocks only:
 * the browser's time zone plays no part). The whole week is edited as a
 * draft and saved at once through replaceBusinessHoursAction, which
 * replaces the complete schedule: what is sent is always the full week
 * built from the read, never a partial draft. The schedule has no version,
 * so it is read again before saving: a change made elsewhere is never
 * overwritten without an explicit choice.
 *
 * Unsaved changes are never dropped silently: an in-app link asks first
 * (save and continue, quit without saving, keep editing), closing or
 * reloading the tab asks the browser, and a week left another way (back
 * button) is kept for the session and offered back on return, only while
 * the saved schedule is still the one it started from.
 */
export function BusinessHoursEditor({
  timezone,
  draftKey,
}: {
  timezone: string;
  /** Session storage key of the unsaved week (one per business). */
  draftKey: string;
}) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  /** The schedule as last read or saved (what "unsaved" compares to). */
  const [baseline, setBaseline] = useState<HourRange[]>([]);
  const [week, setWeek] = useState<DayDraft[]>(() => weekFromHours([]));
  const [errors, setErrors] = useState<DayErrors>({});
  const [state, setState] = useState<ButtonState>("idle");
  const [failure, setFailure] = useState<UiError | null>(null);
  const [conflict, setConflict] = useState<HourRange[] | null>(null);
  const conflictBox = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState(false);
  /** Where an intercepted in-app link was going (unsaved changes). */
  const [leaving, setLeaving] = useState<string | null>(null);
  /** A kept unsaved week: offered back, or dropped because outdated. */
  const [restored, setRestored] = useState<"restored" | "outdated" | null>(
    null,
  );
  const reads = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Below the week: brought into view, otherwise saving is disabled with no
  // visible reason.
  useEffect(() => {
    if (conflict) conflictBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [conflict]);

  useEffect(() => {
    const read = (reads.current += 1);
    void callAction(() => listBusinessHoursAction()).then((result) => {
      if (read !== reads.current) return;
      if (!result.ok) {
        setLoad({ status: "error", error: result.error });
        return;
      }
      setBaseline(result.data);
      const kept = readDraft(draftKey);
      if (kept && kept.baseline === scheduleKey(result.data)) {
        // Left without saving (e.g. back button): offered back as it was.
        setWeek(kept.week);
        setRestored("restored");
      } else {
        // Never over a schedule changed since: said, then dropped.
        if (kept) setRestored("outdated");
        clearDraft(draftKey);
        setWeek(weekFromHours(result.data));
      }
      setLoad({ status: "ready" });
    });
    return () => {
      reads.current += 1;
    };
  }, [run, draftKey]);

  const busy = state !== "idle";
  const draftHours = hoursFromWeek(week);
  const dirty = scheduleKey(draftHours) !== scheduleKey(baseline);

  // Closing or reloading the tab with unsaved changes asks the browser.
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  // An in-app link (sidebar, tab bar, account sheet…) would unmount this
  // page and drop the draft: while there are unsaved changes, it asks
  // first. Only plain same-origin clicks to another page are held; new
  // tabs, downloads and external links keep their usual behaviour.
  useEffect(() => {
    if (!dirty && !busy) return;
    const hold = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        (anchor.target && anchor.target !== "_self") ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setLeaving(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", hold, true);
    return () => document.removeEventListener("click", hold, true);
  }, [dirty, busy]);

  // The unsaved week, kept for the session (back button, other exits).
  useEffect(() => {
    if (load.status !== "ready") return;
    if (dirty) writeDraft(draftKey, scheduleKey(baseline), week);
    else clearDraft(draftKey);
  }, [load.status, dirty, draftKey, baseline, week]);

  function edit(weekday: number, change: (day: DayDraft) => DayDraft) {
    // Locked while saving: what is sent is what is saved.
    if (busy) return;
    setWeek((days) =>
      days.map((day) => (day.weekday === weekday ? change(day) : day)),
    );
    setErrors((current) => {
      const next = { ...current };
      delete next[weekday];
      return next;
    });
    setSaved(false);
  }

  /**
   * Whether the week is saved (confirmed by the backend). `expected` is the
   * week this draft replaces: the backend refuses it (stale_business_hours)
   * if the week has changed since.
   */
  async function save(expected: HourRange[] = baseline): Promise<boolean> {
    if (busy) return false;
    const found = checkWeek(week);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first !== undefined) {
      document.getElementById(`day-${first}`)?.focus();
      return false;
    }
    setFailure(null);
    setSaved(false);
    setState("loading");
    const sent = hoursFromWeek(week);

    // The backend replaces the week only if it is still `expected` (the
    // week this draft started from), atomically: otherwise it refuses
    // (stale_business_hours) and nothing is written.
    const result = await callAction(() =>
      replaceBusinessHoursAction({ hours: sent, expected }),
    );
    if (!alive.current) return false;
    if (!result.ok && result.error.code === "stale_business_hours") {
      // Changed elsewhere: read the week now and compare. Nothing is sent
      // again until the professional chooses.
      const latest = await callAction(() => listBusinessHoursAction());
      if (!alive.current) return false;
      setState("idle");
      if (latest.ok) setConflict(latest.data);
      else setFailure(result.error);
      return false;
    }
    setState("idle");
    if (result.ok) {
      setBaseline(result.data);
      setWeek(weekFromHours(result.data));
      setConflict(null);
      setSaved(true);
      setRestored(null);
      clearDraft(draftKey);
      return true;
    }
    const refused = serverDayErrors(sent, result.error.fieldErrors);
    setErrors(refused);
    setFailure(result.error);
    return false;
  }

  /** Saves, then follows the held link only once the week is saved. */
  async function saveAndLeave() {
    const target = leaving;
    if (!target) return;
    const done = await save();
    if (!alive.current) return;
    setLeaving(null);
    if (done) router.push(target as Parameters<typeof router.push>[0]);
  }

  function leaveWithoutSaving() {
    const target = leaving;
    if (!target) return;
    clearDraft(draftKey);
    setLeaving(null);
    // The guard is off once nothing is left to protect.
    setWeek(weekFromHours(baseline));
    router.push(target as Parameters<typeof router.push>[0]);
  }

  if (load.status === "loading") {
    return (
      <Frame timezone={timezone}>
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only" role="status">
            Chargement des horaires…
          </span>
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className="h-16 animate-pulse rounded-3xl bg-sand/60"
            />
          ))}
        </div>
      </Frame>
    );
  }

  if (load.status === "error") {
    return (
      <Frame timezone={timezone}>
        <Notice
          tone={load.error.code === "network" ? "offline" : "error"}
          title={describeError(load.error).title}
          action={
            load.error.code === "unauthenticated" ? (
              <Link href="/login" className={linkAction}>
                Me reconnecter
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLoad({ status: "loading" });
                  setRun((value) => value + 1);
                }}
                className={linkAction}
              >
                Réessayer
              </button>
            )
          }
        >
          Tes horaires n’ont pas pu être chargés.
        </Notice>
      </Frame>
    );
  }

  return (
    <Frame timezone={timezone}>
      <form
        noValidate
        aria-busy={state === "loading"}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex flex-col gap-3"
      >
        {restored === "restored" ? (
          <Notice
            tone="info"
            title="Brouillon non enregistré restauré"
            action={
              <button
                type="button"
                className={linkAction}
                onClick={() => {
                  setWeek(weekFromHours(baseline));
                  setRestored(null);
                  setErrors({});
                }}
              >
                Abandonner ce brouillon
              </button>
            }
          >
            Tu avais quitté la page sans enregistrer ces horaires. Vérifie-les
            puis enregistre-les.
          </Notice>
        ) : restored === "outdated" ? (
          <Notice tone="warning" title="Brouillon non restauré">
            Tu avais quitté la page sans enregistrer, mais tes horaires ont
            changé depuis : ton brouillon n’a pas été restauré pour ne pas les
            écraser. Voici les horaires actuels.
          </Notice>
        ) : null}

        {baseline.length === 0 && !dirty ? (
          <Notice tone="info" title="Aucun horaire pour l’instant">
            Ouvre les jours où tu travailles et indique tes plages. Les jours
            fermés restent sans plage.
          </Notice>
        ) : null}

        {week.map((day) => (
          <DayEditor
            key={day.weekday}
            day={day}
            error={errors[day.weekday]}
            locked={busy}
            onChange={(change) => edit(day.weekday, change)}
          />
        ))}

        {conflict ? (
          // Clear of the sticky save bar.
          <div ref={conflictBox} className="scroll-mb-44">
            <Notice tone="warning" title="Horaires modifiés ailleurs">
              <p>
                Tes horaires ont changé depuis l’ouverture de cette page. Rien
                n’a été enregistré. Horaires actuels :
              </p>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {weekFromHours(conflict).map((day) => (
                  <li key={day.weekday}>
                    <span className="font-semibold">
                      {WEEKDAY_LABELS[day.weekday]}
                    </span>{" "}
                    :{" "}
                    {day.open ? day.ranges.map(rangeLabel).join(", ") : "fermé"}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => {
                    // Explicit: the local week, against the week just read
                    // (refused again if it changes once more meanwhile).
                    setBaseline(conflict);
                    setConflict(null);
                    void save(conflict);
                  }}
                >
                  Remplacer par mes horaires
                </button>
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => {
                    setBaseline(conflict);
                    setWeek(weekFromHours(conflict));
                    setConflict(null);
                    setErrors({});
                  }}
                >
                  Reprendre les horaires actuels
                </button>
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => setConflict(null)}
                >
                  Continuer à modifier
                </button>
              </div>
            </Notice>
          </div>
        ) : null}

        {failure ? (
          <SaveFailure error={failure} onRetry={() => void save()} />
        ) : null}

        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-[13.5px] text-ink-muted" role="status">
            {busy
              ? "Enregistrement…"
              : saved
                ? "Horaires enregistrés."
                : dirty
                  ? "Modifications non enregistrées."
                  : "Tout est enregistré."}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {dirty ? (
              <Button
                variant="ghost"
                size="md"
                disabled={busy}
                onClick={() => {
                  setWeek(weekFromHours(baseline));
                  setErrors({});
                  setFailure(null);
                  setConflict(null);
                }}
              >
                <span className="text-danger">Annuler mes modifications</span>
              </Button>
            ) : null}
            <Button
              type="submit"
              size="md"
              state={state}
              loadingLabel="Enregistrement…"
              disabled={!dirty || conflict !== null}
              className="sm:min-w-44"
            >
              Enregistrer les horaires
            </Button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={leaving !== null}
        title="Modifications non enregistrées"
        description="Tes horaires modifiés ne sont pas encore enregistrés."
        confirmLabel="Enregistrer et continuer"
        cancelLabel="Continuer à modifier"
        state={state}
        onConfirm={() => void saveAndLeave()}
        onCancel={() => setLeaving(null)}
      >
        <button
          type="button"
          disabled={busy}
          onClick={leaveWithoutSaving}
          className="flex h-11 cursor-pointer items-center text-[14.5px] font-medium text-danger underline decoration-danger/40 underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Quitter sans enregistrer
        </button>
      </ConfirmDialog>
    </Frame>
  );
}

function Frame({
  timezone,
  children,
}: {
  timezone: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
            Horaires
          </h1>
          <p className="text-[14.5px] text-ink-muted">
            Tes horaires d’ouverture chaque semaine, à l’heure de ton activité (
            {timezone}), quel que soit l’appareil utilisé.
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}

function DayEditor({
  day,
  error,
  locked,
  onChange,
}: {
  day: DayDraft;
  error?: string;
  locked: boolean;
  onChange: (change: (day: DayDraft) => DayDraft) => void;
}) {
  const label = WEEKDAY_LABELS[day.weekday]!;
  const switchId = `open-${day.weekday}`;
  return (
    <fieldset
      id={`day-${day.weekday}`}
      tabIndex={-1}
      aria-describedby={error ? `day-${day.weekday}-error` : undefined}
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-3xl border bg-paper-raised px-4 py-4 focus:outline-none sm:px-5",
        error ? "border-danger/60" : "border-line",
        !day.open && "bg-paper",
      )}
    >
      {/* The fieldset's name (a legend names it only as its first child). */}
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center justify-between gap-3">
        <span aria-hidden="true" className="text-[16px] font-semibold text-ink">
          {label}
        </span>
        <label
          htmlFor={switchId}
          className="flex items-center gap-2 text-[14px] text-ink-soft"
        >
          {day.open ? "Ouvert" : "Fermé"}
          <Switch
            id={switchId}
            checked={day.open}
            disabled={locked}
            aria-label={`${label} ouvert`}
            onChange={() =>
              onChange((current) => ({
                ...current,
                open: !current.open,
                ranges:
                  !current.open && current.ranges.length === 0
                    ? [nextRange([])!]
                    : current.ranges,
              }))
            }
          />
        </label>
      </div>

      {day.open ? (
        <ol className="flex flex-col gap-2">
          {day.ranges.map((range, index) => (
            <li
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
            >
              <TimeSelect
                label={`Début de la plage ${index + 1}, ${label}`}
                visibleLabel="De"
                value={range.startsAt}
                disabled={locked}
                onChange={(value) =>
                  onChange((current) => ({
                    ...current,
                    ranges: current.ranges.map((item, position) =>
                      position === index ? { ...item, startsAt: value } : item,
                    ),
                  }))
                }
              />
              <TimeSelect
                label={`Fin de la plage ${index + 1}, ${label}`}
                visibleLabel="À"
                value={range.endsAt}
                disabled={locked}
                onChange={(value) =>
                  onChange((current) => ({
                    ...current,
                    ranges: current.ranges.map((item, position) =>
                      position === index ? { ...item, endsAt: value } : item,
                    ),
                  }))
                }
              />
              <button
                type="button"
                disabled={locked}
                aria-label={`Retirer la plage ${index + 1}, ${label}`}
                onClick={() =>
                  onChange((current) => {
                    const ranges = current.ranges.filter(
                      (_, position) => position !== index,
                    );
                    return { ...current, ranges, open: ranges.length > 0 };
                  })
                }
                className="flex size-12 cursor-pointer items-center justify-center rounded-xl text-ink-muted hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CloseIcon size={18} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[14px] text-ink-muted">Fermé ce jour-là.</p>
      )}

      {error ? (
        <p
          id={`day-${day.weekday}-error`}
          role="alert"
          className="text-[13.5px] text-danger"
        >
          {error}
        </p>
      ) : null}

      {day.open &&
      day.ranges.length < MAX_RANGES_PER_DAY &&
      nextRange(day.ranges) ? (
        <button
          type="button"
          disabled={locked}
          onClick={() =>
            onChange((current) => ({
              ...current,
              ranges: [...current.ranges, nextRange(current.ranges)!],
            }))
          }
          aria-label={`Ajouter une plage le ${label.toLowerCase()}`}
          className="flex h-10 w-fit cursor-pointer items-center gap-1.5 rounded-xl px-2 text-[13.5px] font-medium text-ink-soft hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon size={16} />
          Ajouter une plage
        </button>
      ) : null}
    </fieldset>
  );
}

function TimeSelect({
  label,
  visibleLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  visibleLabel: string;
  value: string;
  disabled: boolean;
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
        className="h-12 w-full min-w-0 cursor-pointer rounded-xl border border-line bg-paper-raised px-3 text-[16px] text-ink tabular-nums hover:border-line-strong focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_rgba(151,73,58,0.12)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-70"
      >
        {timeOptions(value).map((time) => (
          <option key={time} value={time}>
            {time === "24:00" ? "24:00 (minuit)" : time}
          </option>
        ))}
      </select>
    </label>
  );
}

function SaveFailure({
  error,
  onRetry,
}: {
  error: UiError;
  onRetry: () => void;
}) {
  const retry = (
    <button type="button" onClick={onRetry} className={linkAction}>
      Réessayer
    </button>
  );
  switch (error.code) {
    case "stale_business_hours":
      return (
        <Notice
          tone="warning"
          title="Horaires modifiés ailleurs"
          action={retry}
        >
          Tes horaires ont changé depuis l’ouverture de cette page : rien n’a
          été enregistré, et les horaires actuels n’ont pas pu être chargés.
          Réessaie pour les comparer aux tiens.
        </Notice>
      );
    case "network":
      return (
        <Notice tone="offline" title="Connexion interrompue" action={retry}>
          Tes horaires ont peut-être été enregistrés. Réessaie : envoyer la même
          semaine donne le même résultat.
        </Notice>
      );
    case "validation_error":
      return (
        <Notice tone="error" title="Horaires refusés">
          Certaines plages ont été refusées (horaires invalides ou qui se
          chevauchent). Rien n’a été modifié : corrige les jours indiqués.
        </Notice>
      );
    case "unauthenticated":
      return (
        <Notice
          tone="error"
          title="Session expirée"
          action={
            <Link href="/login" className={linkAction}>
              Me reconnecter
            </Link>
          }
        >
          Reconnecte-toi pour enregistrer. Tes modifications restent ici tant
          que la page est ouverte.
        </Notice>
      );
    default:
      return (
        <Notice tone="error" title="Enregistrement impossible" action={retry}>
          Tes horaires n’ont pas pu être enregistrés. Tes modifications sont
          conservées.
        </Notice>
      );
  }
}

// The unsaved week of one business, for the session only (never the
// source of truth: it is offered back only over the schedule it started
// from). Storage may be unavailable: the editor works without it.
type KeptDraft = { baseline: string; week: DayDraft[] };

function readDraft(key: string): KeptDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as KeptDraft;
    return typeof value?.baseline === "string" && Array.isArray(value.week)
      ? value
      : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, baseline: string, week: DayDraft[]) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ baseline, week }));
  } catch {
    // Storage unavailable or full: the in-app guard still protects.
  }
}

function clearDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
}
