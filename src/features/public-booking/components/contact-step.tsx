"use client";

import { useRef, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { cn } from "@/lib/cn";

import { dayLabel, wallDate, wallTime } from "../client/business-time";
import { CONTACT_LIMITS, type ContactField } from "../client/contact";
import type { BookingFlow } from "../client/use-booking-flow";
import { linkAction, StepHeading } from "./booking-parts";

const ORDER: ContactField[] = ["firstName", "lastName", "email", "phone"];

/** Step 3: only what the booking needs (first name and email required). */
export function ContactStep({
  flow,
  headingRef,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { contact, contactErrors: errors, slot, service } = flow;
  const formRef = useRef<HTMLFormElement>(null);
  if (!slot || !service) return null;

  function next() {
    if (flow.actions.submitContact()) return;
    // Focus the first field to fix (after the errors render).
    requestAnimationFrame(() => {
      const fields = formRef.current?.querySelectorAll<HTMLInputElement>(
        "input[aria-invalid='true']",
      );
      fields?.[0]?.focus();
    });
  }

  const field = (name: ContactField) => ({
    value: contact[name],
    error: errors[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      flow.actions.changeContact(name, event.target.value),
    name,
  });

  return (
    <section aria-labelledby="booking-contact" className="flex flex-col gap-5">
      <div id="booking-contact">
        <StepHeading step={3} total={4} headingRef={headingRef}>
          Vos coordonnées
        </StepHeading>
      </div>
      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-paper-raised px-4 py-3">
        <p className="text-[15px] font-semibold wrap-anywhere text-ink">
          {service.name}
        </p>
        <p className="text-[14px] text-ink-soft first-letter:uppercase">
          {dayLabel(wallDate(slot.localStartsAt))} à{" "}
          {wallTime(slot.localStartsAt)}
        </p>
        <button
          type="button"
          className={cn(linkAction, "mt-1 self-start")}
          onClick={() => flow.actions.goTo("slot")}
        >
          Changer de créneau
        </button>
      </div>

      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          next();
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-[13.5px] text-ink-muted">
          Ces informations servent uniquement à l’établissement pour votre
          rendez-vous.
        </p>
        <TextField
          label="Prénom"
          autoComplete="given-name"
          maxLength={CONTACT_LIMITS.firstName}
          {...field("firstName")}
        />
        <TextField
          label="Nom"
          optional
          autoComplete="family-name"
          maxLength={CONTACT_LIMITS.lastName}
          {...field("lastName")}
        />
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CONTACT_LIMITS.email}
          {...field("email")}
        />
        <TextField
          label="Téléphone"
          optional
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={CONTACT_LIMITS.phone}
          hint="Pour que l’établissement puisse vous joindre si besoin."
          {...field("phone")}
        />
        <Button type="submit" size="lg" fullWidth>
          Continuer
        </Button>
      </form>
      <p className="sr-only" aria-live="polite">
        {ORDER.some((name) => errors[name])
          ? "Certaines informations sont à corriger."
          : ""}
      </p>
    </section>
  );
}
