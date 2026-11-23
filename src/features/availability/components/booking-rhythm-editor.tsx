"use client";

import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import type { Option } from "@/features/onboarding/settings";

import { setBookingRhythmAction } from "../actions/schedule";
import {
  choicesWith,
  intervalOptions,
  rhythmBufferOptions,
  rhythmNoticeOptions,
  slotExample,
} from "../client/booking-rhythm";
import type { BookingRhythm } from "../schemas/availability";

const fieldClass =
  "min-h-11 w-full max-w-sm rounded-xl border border-line bg-paper px-3 text-base text-ink";

/**
 * The rhythm of her online bookings (points 220 and 222): how far apart the
 * proposed slots start, the notice before a slot, the time kept free after
 * each appointment. Saved together; what is already booked does not move.
 */
export function BookingRhythmEditor({
  businessId,
  initial,
}: {
  businessId: string;
  initial: BookingRhythm;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  const changed = (Object.keys(draft) as (keyof BookingRhythm)[]).some(
    (key) => draft[key] !== saved[key],
  );

  function pick(key: keyof BookingRhythm, value: number) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSuccess(false);
  }

  async function save() {
    if (busy.current || !changed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await callAction(() =>
        setBookingRhythmAction({ businessId, ...draft }),
      );
      if (!result.ok) setError(result.error);
      else {
        setSaved(result.data);
        setDraft(result.data);
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
        Rythme des réservations
      </h2>
      <p className="text-sm text-ink-muted">
        Choisis comment tes créneaux s’enchaînent quand une cliente réserve en
        ligne.
      </p>
      <form
        className="flex flex-col items-start gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Choice
          label="Créneaux proposés"
          hint={`Ils partent de ton heure d’ouverture. Si tu ouvres à 9\u00a0h\u00a0: ${slotExample(draft.slotIntervalMinutes)}`}
          options={choicesWith(intervalOptions, draft.slotIntervalMinutes)}
          value={draft.slotIntervalMinutes}
          disabled={pending}
          onChange={(value) => pick("slotIntervalMinutes", value)}
        />
        <Choice
          label="Préavis minimum"
          hint="Le temps minimum entre la réservation et le rendez-vous."
          options={choicesWith(
            rhythmNoticeOptions,
            draft.minimumBookingNoticeMinutes,
          )}
          value={draft.minimumBookingNoticeMinutes}
          disabled={pending}
          onChange={(value) => pick("minimumBookingNoticeMinutes", value)}
        />
        <Choice
          label="Pause après chaque rendez-vous"
          hint="Gardée libre pour ranger ou souffler avant la cliente suivante."
          options={choicesWith(rhythmBufferOptions, draft.bufferMinutes)}
          value={draft.bufferMinutes}
          disabled={pending}
          onChange={(value) => pick("bufferMinutes", value)}
        />
        <Button
          type="submit"
          size="md"
          state={pending ? "loading" : "idle"}
          disabled={!changed}
        >
          Enregistrer le rythme
        </Button>
      </form>
      {success ? (
        <Notice tone="success">
          Rythme enregistré. Il s’applique aux prochaines réservations : les
          rendez-vous déjà pris ne bougent pas.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error">{describeError(error).message}</Notice>
      ) : null}
    </section>
  );
}

function Choice({
  label,
  hint,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  options: Option<number>[];
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const hintId = useId();
  return (
    <label className="flex w-full max-w-sm flex-col gap-1.5 text-sm font-medium text-ink">
      {label}
      <select
        aria-label={label}
        aria-describedby={hintId}
        className={fieldClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span id={hintId} className="text-[13px] font-normal text-ink-muted">
        {hint}
      </span>
    </label>
  );
}
