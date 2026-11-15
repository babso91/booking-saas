"use client";

import { useEffect, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { getBookingSettingsAction } from "@/features/availability/actions/schedule";
import { setBookingPolicyAction } from "@/features/booking-policy/actions";
import type { BookingPolicy } from "@/features/booking-policy/schemas";

/**
 * Whether her clients may cancel or move an appointment themselves from
 * their space, and until when (docs/CLIENT_HUB_CONTRACT.md § 12). Never by
 * default. Each new appointment keeps the policy it was made under: a
 * change applies to the next bookings only, and the screen says so.
 */

/** The deadlines offered, in minutes before the start; null: never. */
export const LEADS: { value: number | null; label: string }[] = [
  { value: null, label: "Jamais, elles me contactent" },
  { value: 0, label: "Jusqu’au début du rendez-vous" },
  { value: 120, label: "Jusqu’à 2 h avant" },
  { value: 720, label: "Jusqu’à 12 h avant" },
  { value: 1_440, label: "Jusqu’à 24 h avant" },
  { value: 2_880, label: "Jusqu’à 48 h avant" },
  { value: 4_320, label: "Jusqu’à 72 h avant" },
  { value: 10_080, label: "Jusqu’à 7 jours avant" },
];

/** A deadline set elsewhere (another value) is shown as it is, not lost. */
export function leadLabel(minutes: number | null) {
  const known = LEADS.find((lead) => lead.value === minutes);
  if (known) return known.label;
  const value = minutes ?? 0;
  if (value % 1_440 === 0) return `Jusqu’à ${value / 1_440} jours avant`;
  if (value % 60 === 0) return `Jusqu’à ${value / 60} h avant`;
  return `Jusqu’à ${value} min avant`;
}

const encode = (minutes: number | null) =>
  minutes === null ? "never" : String(minutes);
const decode = (value: string) => (value === "never" ? null : Number(value));

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; saved: BookingPolicy };

export function HubPolicySection() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [draft, setDraft] = useState<BookingPolicy | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [error, setError] = useState<UiError | null>(null);
  const [run, setRun] = useState(0);
  const sending = useRef(false);

  useEffect(() => {
    let alive = true;
    void callAction(() => getBookingSettingsAction()).then((result) => {
      if (!alive) return;
      if (!result.ok) return setLoad({ status: "error", error: result.error });
      const saved = {
        cancellationLeadMinutes: result.data.cancellationLeadMinutes,
        rescheduleLeadMinutes: result.data.rescheduleLeadMinutes,
      };
      setLoad({ status: "ready", saved });
      setDraft(saved);
    });
    return () => {
      alive = false;
    };
  }, [run]);

  const saved = load.status === "ready" ? load.saved : null;
  const dirty =
    saved !== null &&
    draft !== null &&
    (saved.cancellationLeadMinutes !== draft.cancellationLeadMinutes ||
      saved.rescheduleLeadMinutes !== draft.rescheduleLeadMinutes);

  async function save() {
    if (!draft || sending.current) return;
    sending.current = true;
    setState("loading");
    setError(null);
    const result = await callAction(() => setBookingPolicyAction(draft));
    sending.current = false;
    if (!result.ok) {
      setState("idle");
      setError(result.error);
      return;
    }
    setLoad({ status: "ready", saved: result.data });
    setDraft(result.data);
    setState("success");
    window.setTimeout(() => setState("idle"), 1_600);
  }

  function change(patch: Partial<BookingPolicy>) {
    setDraft((value) => (value ? { ...value, ...patch } : value));
    setError(null);
    if (state === "success") setState("idle");
  }

  return (
    <section
      aria-labelledby="hub-policy"
      className="flex flex-col gap-4 border-t border-line pt-8"
    >
      <div className="flex flex-col gap-1.5">
        <h2
          id="hub-policy"
          className="font-display text-[22px] leading-tight text-ink"
        >
          Annulation et déplacement par tes clientes
        </h2>
        <p className="max-w-prose text-[14.5px] text-ink-soft">
          Depuis leur espace, tes clientes peuvent annuler ou déplacer un
          rendez-vous elles-mêmes, jusqu’au délai que tu choisis. Un déplacement
          garde la même prestation, le même prix et la même durée, sur un
          créneau libre de ton agenda.
        </p>
      </div>

      {load.status === "loading" ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only" role="status">
            Chargement des règles d’annulation…
          </span>
          <span className="h-11 animate-pulse rounded-xl bg-sand/60" />
          <span className="h-11 animate-pulse rounded-xl bg-sand/50" />
        </div>
      ) : load.status === "error" ? (
        <Notice
          tone={load.error.code === "network" ? "offline" : "error"}
          title={describeError(load.error).title}
          action={
            <button
              type="button"
              className="w-fit cursor-pointer font-semibold underline underline-offset-4"
              onClick={() => {
                setLoad({ status: "loading" });
                setRun((value) => value + 1);
              }}
            >
              Réessayer
            </button>
          }
        >
          Les règles d’annulation n’ont pas pu être chargées.
        </Notice>
      ) : draft ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col divide-y divide-line border-y border-line">
            <PolicyRow
              id="policy-cancel"
              label="Annuler"
              value={draft.cancellationLeadMinutes}
              disabled={state === "loading"}
              onChange={(value) => change({ cancellationLeadMinutes: value })}
            />
            <PolicyRow
              id="policy-reschedule"
              label="Déplacer"
              value={draft.rescheduleLeadMinutes}
              disabled={state === "loading"}
              onChange={(value) => change({ rescheduleLeadMinutes: value })}
            />
          </div>

          <p className="text-[13.5px] text-ink-muted">
            S’applique aux rendez-vous pris à partir de maintenant : ceux déjà
            réservés gardent la règle du moment où ils l’ont été.
          </p>

          {error ? (
            <Notice
              tone={error.code === "network" ? "offline" : "error"}
              title={
                error.code === "forbidden"
                  ? "Réservé à la propriétaire ou à une admin"
                  : describeError(error).title
              }
            >
              {error.code === "forbidden"
                ? "Ton rôle ne permet pas de changer ces règles. Rien n’a été modifié."
                : "Rien n’a été modifié."}
            </Notice>
          ) : null}

          <Button
            type="submit"
            size="md"
            className="w-fit"
            disabled={!dirty && state !== "success"}
            state={state}
            loadingLabel="Enregistrement…"
            successLabel="Enregistré"
          >
            Enregistrer ces règles
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function PolicyRow({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const known = LEADS.some((lead) => lead.value === value);
  return (
    <div className="grid items-center gap-x-8 gap-y-2 py-4 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      <label htmlFor={id} className="text-[16px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        value={encode(value)}
        disabled={disabled}
        onChange={(event) => onChange(decode(event.target.value))}
        className="h-11 w-full min-w-0 cursor-pointer rounded-xl border border-line bg-paper-raised px-3 text-[16px] text-ink hover:border-line-strong focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_12%,transparent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-70 sm:max-w-sm"
      >
        {known ? null : (
          <option value={encode(value)}>{leadLabel(value)}</option>
        )}
        {LEADS.map((lead) => (
          <option key={encode(lead.value)} value={encode(lead.value)}>
            {lead.label}
          </option>
        ))}
      </select>
    </div>
  );
}
