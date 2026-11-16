"use client";

import { useId } from "react";

import { cn } from "@/lib/cn";

import { CONSENT_WORDING, type MarketingChoice } from "../wording";

/**
 * Whether she wants offers, asked when she books
 * (docs/MARKETING_CONSENT_WORDING_PROPOSAL.md). Two separate choices, email
 * and SMS, never ticked in advance; the booking goes through whatever she
 * answers, and the messages about her appointment are said apart.
 *
 * Not used in the booking flow: the wording is not validated
 * (`consentCollectionOpen`). Shown in the previews only.
 */
export function MarketingOptIn({
  businessName,
  value,
  onChange,
  className,
}: {
  businessName: string;
  value: MarketingChoice;
  onChange: (value: MarketingChoice) => void;
  className?: string;
}) {
  const titleId = useId();
  const notesId = useId();
  return (
    <fieldset
      aria-labelledby={titleId}
      aria-describedby={notesId}
      className={cn("flex flex-col gap-3", className)}
    >
      <legend className="contents">
        <span className="flex flex-col gap-0.5">
          <span id={titleId} className="text-[15px] font-semibold text-ink">
            {CONSENT_WORDING.title}
          </span>
          <span className="text-[13.5px] text-ink-soft">
            {CONSENT_WORDING.optional}
          </span>
        </span>
      </legend>

      <div className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-paper-raised">
        {(["email", "sms"] as const).map((channel) => (
          <label
            key={channel}
            className="flex cursor-pointer items-start gap-3 px-4 py-3.5"
          >
            <input
              type="checkbox"
              name={`marketing-${channel}`}
              checked={value[channel]}
              onChange={(event) =>
                onChange({ ...value, [channel]: event.target.checked })
              }
              className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--color-ink)]"
            />
            <span className="text-[15px] leading-snug text-ink">
              {CONSENT_WORDING[channel](businessName)}
            </span>
          </label>
        ))}
      </div>

      <div
        id={notesId}
        className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink-muted"
      >
        <p>{CONSENT_WORDING.necessary}</p>
        <p>{CONSENT_WORDING.withdraw}</p>
        <p>{CONSENT_WORDING.controller(businessName)}</p>
      </div>
    </fieldset>
  );
}
