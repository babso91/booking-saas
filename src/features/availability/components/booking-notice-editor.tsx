"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { formatNotice, noticeOptions } from "@/features/onboarding/settings";

import { setBookingNoticeAction } from "../actions/schedule";

const fieldClass =
  "min-h-11 w-full max-w-sm rounded-xl border border-line bg-paper px-3 text-base text-ink";

/** The choices of onboarding, plus none, plus the saved value if other. */
function choicesFor(saved: number) {
  const choices = [
    { value: 0, label: "Aucun : jusqu’à la dernière minute" },
    ...noticeOptions,
  ];
  return choices.some((choice) => choice.value === saved)
    ? choices
    : [
        ...choices,
        { value: saved, label: `Actuel : ${formatNotice(saved)}` },
      ].sort((a, b) => a.value - b.value);
}

/**
 * The minimum notice of online bookings: how long before an appointment
 * a customer can still book it. Chosen at onboarding, changed here.
 */
export function BookingNoticeEditor({
  businessId,
  initialMinutes,
}: {
  businessId: string;
  initialMinutes: number;
}) {
  const [saved, setSaved] = useState(initialMinutes);
  const [minutes, setMinutes] = useState(initialMinutes);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  async function save() {
    if (busy.current || minutes === saved) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await callAction(() =>
        setBookingNoticeAction({ businessId, minutes }),
      );
      if (!result.ok) setError(result.error);
      else {
        setSaved(result.data);
        setMinutes(result.data);
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
        Préavis minimum
      </h2>
      <p className="text-sm text-ink-muted">
        Le temps qu’il te faut entre une réservation en ligne et le rendez-vous.
        {/* Times kept on one line (non-breaking spaces). */}
        {
          " Avec 2\u00a0h, un rendez-vous de 14\u00a0h se réserve en ligne jusqu’à 12\u00a0h. "
        }
        Les rendez-vous déjà pris ne changent pas.
      </p>
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex w-full max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
          Préavis
          <select
            aria-label="Préavis"
            className={fieldClass}
            value={minutes}
            disabled={pending}
            onChange={(event) => {
              setMinutes(Number(event.target.value));
              setSuccess(false);
            }}
          >
            {choicesFor(saved).map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-ink-soft">
          Réservable en ligne {formatNotice(minutes)}.
        </p>
        <Button
          type="submit"
          size="md"
          state={pending ? "loading" : "idle"}
          disabled={minutes === saved}
        >
          Enregistrer le préavis
        </Button>
      </form>
      {success ? <Notice tone="success">Préavis enregistré.</Notice> : null}
      {error ? (
        <Notice tone="error">{describeError(error).message}</Notice>
      ) : null}
    </section>
  );
}
