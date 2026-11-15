"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import {
  dayLabel,
  dayParts,
} from "@/features/public-booking/client/business-time";
import { cn } from "@/lib/cn";

import type { WaitlistActions, WaitlistRequestDto } from "./contract";
import {
  MAX_WINDOWS,
  checkJoin,
  eligibleDays,
  periods,
  windowsOf,
  type JoinErrors,
  type Period,
} from "./windows";

// A client asks to be told when a slot frees up for a service: the days and
// the moment that suit her, her name and email, and her consent. Nothing is
// held: when a slot frees up she gets an offer, and the first booking wins.
// Written in the public booking's own "vous".

export function JoinWaitlist({
  actions,
  businessSlug,
  serviceId,
  serviceName,
  optionChoiceIds = [],
  today,
  horizonDays,
  onDone,
}: {
  actions: WaitlistActions;
  businessSlug: string;
  serviceId: string;
  serviceName: string;
  optionChoiceIds?: string[];
  /** The business's civil date today. */
  today: string;
  /** How far ahead the business takes bookings. */
  horizonDays: number;
  /** Back to the slots (nothing asked, or done). */
  onDone: () => void;
}) {
  const days = eligibleDays(today, horizonDays);
  const [anyTime, setAnyTime] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>("day");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<JoinErrors>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [joined, setJoined] = useState<WaitlistRequestDto | null>(null);
  const requestId = useRef<{ key: string; id: string } | null>(null);

  const clear = (field: keyof JoinErrors) =>
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== field),
      ),
    );

  const toggle = (day: string) => {
    setChosen((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : current.length >= MAX_WINDOWS
          ? current
          : [...current, day],
    );
    clear("days");
  };

  async function submit() {
    if (sending) return;
    const found = checkJoin({
      anyTime,
      days: chosen,
      firstName,
      email,
      consent,
    });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = {
      businessSlug,
      serviceId,
      optionChoiceIds,
      windows: anyTime ? [] : windowsOf(chosen, period),
      anyTime,
      firstName: firstName.trim(),
      email: email.trim().toLowerCase(),
      contactConsent: true as const,
    };
    // One request id per content: a retry after a lost answer reuses it.
    const key = JSON.stringify(body);
    if (requestId.current?.key !== key)
      requestId.current = { key, id: crypto.randomUUID() };
    setSending(true);
    setFailure(null);
    const result = await actions.join({
      ...body,
      requestId: requestId.current.id,
    });
    setSending(false);
    if (result.ok) return setJoined(result.data);
    setFailure(
      result.error.code === "network"
        ? "Pas de réponse. Réessayez : la même demande ne sera pas enregistrée deux fois."
        : result.error.code === "rate_limited"
          ? "Trop de demandes depuis cet appareil. Réessayez un peu plus tard."
          : result.error.code === "service_not_found"
            ? "Cette prestation n’est plus proposée en ligne."
            : "Votre demande n’a pas pu être enregistrée. Réessayez dans un instant.",
    );
  }

  if (joined)
    return (
      <section className="flex flex-col gap-4" aria-live="polite">
        <Notice tone="success" title="C’est noté">
          {joined.state === "pending_confirmation"
            ? `Confirmez votre demande depuis l’email envoyé à ${email.trim()}. Ensuite, si un créneau de ${serviceName} se libère, vous serez prévenue.`
            : `Si un créneau de ${serviceName} se libère, vous serez prévenue par email.`}
        </Notice>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Rien n’est réservé pour l’instant : quand un créneau se libère, il
          revient à la première personne qui le réserve.
        </p>
        <Button variant="secondary" size="md" onClick={onDone}>
          Revenir aux créneaux
        </Button>
      </section>
    );

  return (
    <section
      aria-labelledby="waitlist-title"
      className="flex flex-col gap-5 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex flex-col gap-1">
        <h3
          id="waitlist-title"
          className="font-display text-[24px] leading-tight text-ink"
        >
          Être prévenue d’un créneau libéré
        </h3>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          {serviceName} : dites-nous quand vous seriez disponible. Si un
          rendez-vous se libère, vous recevrez un email.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[14px] font-semibold text-ink">Quels jours ?</p>
        <button
          type="button"
          aria-pressed={anyTime}
          onClick={() => {
            setAnyTime((value) => !value);
            clear("days");
          }}
          className={cn(
            "h-11 w-fit cursor-pointer rounded-full border px-4 text-[14.5px] font-medium transition-colors",
            anyTime
              ? "border-ink bg-ink text-paper-raised"
              : "border-line bg-paper text-ink hover:border-line-strong",
          )}
        >
          Dès que possible
        </button>
        {anyTime ? null : (
          <>
            <ul
              aria-label={`Jours, ${MAX_WINDOWS} au plus`}
              className="grid grid-cols-5 gap-1.5 sm:grid-cols-8"
            >
              {days.map((day) => {
                const parts = dayParts(day);
                const on = chosen.includes(day);
                const full = !on && chosen.length >= MAX_WINDOWS;
                return (
                  <li key={day}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={dayLabel(day)}
                      disabled={full}
                      onClick={() => toggle(day)}
                      className={cn(
                        "flex w-full cursor-pointer flex-col items-center rounded-2xl border py-2 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                        on
                          ? "border-ink bg-ink text-paper-raised"
                          : "border-line bg-paper text-ink-soft hover:border-line-strong",
                      )}
                    >
                      <span>{parts.weekday}</span>
                      <span className="text-[16px] font-semibold tabular-nums">
                        {parts.day}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="text-[13px] text-ink-muted">
              {chosen.length}/{MAX_WINDOWS} jours choisis.
            </p>
          </>
        )}
        {errors.days ? (
          <p role="alert" className="text-[13px] text-danger">
            {errors.days}
          </p>
        ) : null}
      </div>

      {anyTime ? null : (
        <div
          role="group"
          aria-label="À quel moment ?"
          className="flex flex-col gap-2"
        >
          <p className="text-[14px] font-semibold text-ink">À quel moment ?</p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(periods) as Period[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
                className={cn(
                  "flex cursor-pointer flex-col items-start rounded-2xl border px-3 py-2.5 text-left transition-colors",
                  period === value
                    ? "border-ink bg-ink text-paper-raised"
                    : "border-line bg-paper text-ink hover:border-line-strong",
                )}
              >
                <span className="text-[14.5px] font-medium">
                  {periods[value].label}
                </span>
                <span className="text-[12.5px] opacity-75">
                  {periods[value].hint}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Prénom"
          name="waitlist-first-name"
          autoComplete="given-name"
          value={firstName}
          error={errors.firstName}
          onChange={(event) => {
            setFirstName(event.target.value);
            clear("firstName");
          }}
        />
        <TextField
          label="Email"
          name="waitlist-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          error={errors.email}
          onChange={(event) => {
            setEmail(event.target.value);
            clear("email");
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex cursor-pointer items-start gap-3 text-[14px] leading-relaxed text-ink">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked);
              clear("consent");
            }}
            className="mt-1 size-4 shrink-0 accent-[var(--ink)]"
          />
          J’accepte d’être contactée par email quand un créneau se libère. Je
          peux me désinscrire à tout moment.
        </label>
        {errors.consent ? (
          <p role="alert" className="text-[13px] text-danger">
            {errors.consent}
          </p>
        ) : null}
      </div>

      {failure ? (
        <Notice tone="error" title="Demande non enregistrée">
          {failure}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="md"
          state={sending ? "loading" : "idle"}
          loadingLabel="Envoi…"
          onClick={() => void submit()}
        >
          Me prévenir
        </Button>
        <Button variant="ghost" size="md" disabled={sending} onClick={onDone}>
          Revenir aux créneaux
        </Button>
      </div>
    </section>
  );
}
