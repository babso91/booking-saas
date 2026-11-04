"use client";

import { useId, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import type { BookingFlow } from "../client/use-booking-flow";
import {
  choiceLine,
  linkAction,
  QuoteLine,
  StepHeading,
} from "./booking-parts";

/**
 * Her options for the chosen service: one answer per group. A required
 * group starts on its first answer (never decided by the server), an
 * optional one on "Sans". Every answer reads the price, duration and
 * slots again from the server (QuoteLine shows its quote).
 */
export function OptionsStep({
  flow,
  headingRef,
}: {
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { service, answers, slots, notice, isSending } = flow;
  if (!service) return null;
  return (
    <section aria-labelledby="booking-options" className="flex flex-col gap-5">
      <div id="booking-options">
        <StepHeading
          step={flow.stepNumber("options")}
          total={flow.stepCount}
          headingRef={headingRef}
        >
          Personnalisez votre prestation
        </StepHeading>
      </div>

      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-paper-raised px-4 py-3">
        <p className="text-[15px] font-semibold wrap-anywhere text-ink">
          {service.name}
        </p>
        <button
          type="button"
          className={cn(linkAction, "mt-1 self-start")}
          onClick={() => flow.actions.goTo("service")}
        >
          Changer de prestation
        </button>
      </div>

      {notice === "options_changed" ? (
        <Notice tone="warning" title="Les options ont changé">
          Une réponse n’est plus proposée ou un choix est devenu obligatoire.
          Vérifiez vos réponses : le prix et la durée ont été recalculés.
        </Notice>
      ) : null}

      {service.options.map((option) => (
        <OptionGroup
          key={option.id}
          flow={flow}
          option={option}
          chosen={answers[option.id] ?? null}
          disabled={isSending}
        />
      ))}

      <div
        className="flex flex-col gap-1 rounded-2xl border border-line bg-paper px-4 py-3"
        aria-live="polite"
      >
        <p className="text-[13.5px] text-ink-muted">Votre prestation</p>
        <QuoteLine slots={slots} />
      </div>

      {slots.status === "error" ? (
        <Notice
          tone={slots.error.code === "network" ? "offline" : "error"}
          title="Prix indisponible pour le moment"
          action={
            <button
              type="button"
              className={linkAction}
              onClick={flow.actions.refreshSlots}
            >
              Réessayer
            </button>
          }
        >
          Le prix et la durée de ces options n’ont pas pu être calculés.
        </Notice>
      ) : null}

      <Button
        size="lg"
        fullWidth
        disabled={slots.status !== "ready"}
        onClick={flow.actions.submitOptions}
      >
        Choisir un créneau
      </Button>
    </section>
  );
}

function OptionGroup({
  flow,
  option,
  chosen,
  disabled,
}: {
  flow: BookingFlow;
  option: NonNullable<BookingFlow["service"]>["options"][number];
  chosen: string | null;
  disabled: boolean;
}) {
  const name = useId();
  const currency = flow.service?.currency ?? flow.catalog.currency;
  const answer = (
    value: string | null,
    label: string,
    detail: string | null,
  ) => {
    const selected = chosen === value;
    return (
      <label
        key={value ?? "none"}
        className={cn(
          "flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-2xl border px-4 py-3 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink",
          selected
            ? "border-ink bg-paper-raised"
            : "border-line bg-paper-raised hover:border-line-strong",
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <input
            type="radio"
            name={name}
            checked={selected}
            disabled={disabled}
            onChange={() => flow.actions.chooseAnswer(option.id, value)}
            className="size-4 shrink-0 accent-[var(--ink)]"
          />
          <span className="text-[15px] wrap-anywhere text-ink">{label}</span>
        </span>
        {detail ? (
          <span className="shrink-0 text-[14px] text-ink-soft tabular-nums">
            {detail}
          </span>
        ) : null}
      </label>
    );
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[16px] font-medium wrap-anywhere text-ink">
        {option.question}
        <span className="text-[13px] font-normal text-ink-muted">
          {option.required ? "obligatoire" : "facultatif"}
        </span>
      </legend>
      {option.required ? null : answer(null, "Sans", null)}
      {option.choices.map((choice) =>
        answer(choice.id, choice.label, choiceLine(choice, currency)),
      )}
    </fieldset>
  );
}
