"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { horizonOptions } from "@/features/onboarding/settings";

import { setBookingHorizonAction } from "../actions/schedule";
import { bookingHorizonDaysSchema } from "../schemas/availability";

const choiceFor = (days: number) =>
  horizonOptions.some((option) => option.value === days)
    ? String(days)
    : "custom";
const fieldClass =
  "min-h-11 w-full max-w-sm rounded-xl border border-line bg-paper px-3 text-base text-ink";

export function BookingHorizonEditor({
  businessId,
  initialDays,
}: {
  businessId: string;
  initialDays: number;
}) {
  const [saved, setSaved] = useState(initialDays);
  const [choice, setChoice] = useState(() => choiceFor(initialDays));
  const [customDays, setCustomDays] = useState(String(initialDays));
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  const days = Number(choice === "custom" ? customDays : choice);
  const canSave =
    days !== saved && bookingHorizonDaysSchema.safeParse(days).success;

  async function save() {
    if (busy.current || !canSave) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await callAction(() =>
        setBookingHorizonAction({ businessId, days }),
      );
      if (!result.ok) setError(result.error);
      else {
        setSaved(result.data);
        setChoice(choiceFor(result.data));
        setCustomDays(String(result.data));
        setSuccess(true);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-4 sm:p-5">
      <h2 className="font-display text-[26px] leading-tight text-ink">
        Réservations à l’avance
      </h2>
      <p className="text-sm text-ink-muted">
        Choisis jusqu’à quelle date tes clientes peuvent réserver en ligne.
      </p>
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex w-full max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
          Délai maximum
          <select
            aria-label="Délai maximum"
            className={fieldClass}
            value={choice}
            disabled={pending}
            onChange={(event) => {
              setChoice(event.target.value);
              setSuccess(false);
            }}
          >
            {horizonOptions.map(({ value, label }) => (
              <option key={value} value={value}>
                {label} ({value} jours)
              </option>
            ))}
            <option value="custom">Personnalisé</option>
          </select>
        </label>
        {choice === "custom" ? (
          <label className="flex w-full max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
            Nombre de jours (1 à 365)
            <input
              className={fieldClass}
              type="number"
              min={1}
              max={365}
              step={1}
              required
              value={customDays}
              disabled={pending}
              onChange={(event) => {
                setCustomDays(event.target.value);
                setSuccess(false);
              }}
            />
          </label>
        ) : null}
        <Button
          type="submit"
          size="md"
          state={pending ? "loading" : "idle"}
          disabled={!canSave}
        >
          Enregistrer le délai
        </Button>
      </form>
      {success ? (
        <Notice tone="success">Délai de réservation enregistré.</Notice>
      ) : null}
      {error ? (
        <Notice tone="error">{describeError(error).message}</Notice>
      ) : null}
    </section>
  );
}
