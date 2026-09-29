"use client";

import { useId, useSyncExternalStore } from "react";

import { ChoiceChips } from "@/components/ui/choice-chips";
import {
  CalendarIcon,
  ClockIcon,
  GlobeIcon,
  CupIcon,
} from "@/components/ui/icons";

import {
  bufferOptions,
  formatLocalTime,
  horizonOptions,
  noticeOptions,
  summarizeBookingSettings,
  timezoneOptions,
} from "../../settings";
import { StepHeader } from "../step-header";
import type { StepProps } from "./types";

// Re-renders once a minute so the local time stays true.
function subscribeMinute(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const currentMinute = () => Math.floor(Date.now() / 60_000);

export function PreferencesStep({ draft, update, headingRef }: StepProps) {
  const timezoneId = useId();
  const minute = useSyncExternalStore(subscribeMinute, currentMinute, () => 0);
  const localTime = minute ? formatLocalTime(draft.timezone) : null;
  const summary = summarizeBookingSettings(draft);

  return (
    <div className="flex flex-col gap-8">
      <StepHeader
        eyebrow="Tes réservations"
        title="Tes règles, en douceur."
        headingRef={headingRef}
      >
        On a choisi des réglages qui conviennent à la plupart des indépendantes.
        Ajuste-les si besoin.
      </StepHeader>

      <div className="flex flex-col gap-3">
        <label htmlFor={timezoneId} className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-sand text-ink-soft">
            <GlobeIcon size={18} />
          </span>
          <span className="flex flex-col gap-1">
            <span className="text-[15px] leading-snug font-medium text-ink">
              Où exerces-tu ?
            </span>
            <span className="text-[13.5px] leading-snug text-ink-muted">
              Tes horaires seront affichés à l’heure locale.
              {localTime ? (
                <>
                  {" "}
                  Il est actuellement{" "}
                  <strong className="font-semibold text-ink-soft">
                    {localTime}
                  </strong>
                  .
                </>
              ) : null}
            </span>
          </span>
        </label>
        <div className="relative">
          <select
            id={timezoneId}
            value={draft.timezone}
            onChange={(event) => update("timezone", event.target.value)}
            className="h-14 w-full cursor-pointer appearance-none rounded-2xl border border-line bg-paper-raised pr-11 pl-4 text-[16px] text-ink transition-[border-color,box-shadow] duration-200 hover:border-line-strong focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_rgba(151,73,58,0.12)] focus-visible:outline-none"
          >
            {timezoneOptions(draft.timezone).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink-muted"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <hr className="border-line" />

      <ChoiceChips
        legend="Jusqu’à quand peut-on réserver avant un rendez-vous ?"
        description="Pour ne pas être surprise par une réservation de dernière minute."
        icon={<ClockIcon size={18} />}
        name="notice"
        value={draft.minimumBookingNoticeMinutes}
        options={noticeOptions}
        onChange={(value) => update("minimumBookingNoticeMinutes", value)}
      />

      <ChoiceChips
        legend="Combien de temps à l’avance ?"
        description="Jusqu’où ton agenda est ouvert aux réservations."
        icon={<CalendarIcon size={18} />}
        name="horizon"
        value={draft.maximumBookingAdvanceDays}
        options={horizonOptions}
        onChange={(value) => update("maximumBookingAdvanceDays", value)}
      />

      <ChoiceChips
        legend="Une pause entre deux clientes ?"
        description="Le temps de ranger, désinfecter et souffler un peu."
        icon={<CupIcon size={18} />}
        name="buffer"
        value={draft.bufferMinutes}
        options={bufferOptions}
        onChange={(value) => update("bufferMinutes", value)}
      />

      <div
        className="rounded-3xl bg-ink px-5 py-4 text-paper-raised"
        aria-live="polite"
      >
        <p className="text-[12px] font-semibold tracking-[0.14em] text-paper-raised/60 uppercase">
          En résumé
        </p>
        <p
          key={summary}
          className="mt-1.5 animate-fade text-[15px] leading-relaxed"
        >
          {summary}
        </p>
      </div>
    </div>
  );
}
