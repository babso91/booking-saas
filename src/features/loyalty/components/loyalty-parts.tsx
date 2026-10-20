import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import type { UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { cn } from "@/lib/cn";

export const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

export const smallButton =
  "flex h-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-line px-3 text-[13.5px] font-medium text-ink hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50";

/**
 * No answer, or an unexpected failure: the write may have been applied.
 * Screens say so instead of "nothing was done", and retry with the same
 * request (idempotent) rather than a new one.
 */
export const isUncertain = (error: UiError) =>
  error.code === "network" || error.code === "internal";

/** Backend field names → form fields, for `validation_error`. */
export function fieldErrorsOf<Field extends string>(
  error: UiError,
  fields: Record<string, Field>,
): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  for (const [name, messages] of Object.entries(error.fieldErrors ?? {})) {
    const field = fields[name];
    if (field && messages[0]) errors[field] = messages[0];
  }
  return errors;
}

/**
 * A write that failed: plain words, and the way out when there is one
 * (sign in again). Never a success, never the backend's raw text. Without
 * an answer (network, internal) the write may have been applied: said as
 * such, never "nothing was done"; a retry sends the same request.
 */
export function WriteError({
  error,
  children,
  action,
}: {
  error: UiError;
  /** What was not done (replaced when the outcome is unknown). */
  children?: ReactNode;
  action?: ReactNode;
}) {
  const copy = describeError(error);
  const what = isUncertain(error)
    ? "Sans réponse, l’opération a peut-être été enregistrée : vérifie avant de recommencer, ou réessaie, elle ne sera jamais appliquée deux fois."
    : children;
  return (
    <Notice
      tone={error.code === "network" ? "offline" : "error"}
      title={copy.title}
      action={
        error.code === "unauthenticated" ? (
          <Link href="/login" className={linkAction}>
            Me reconnecter
          </Link>
        ) : (
          action
        )
      }
    >
      {what ? (
        <>
          {what} {isUncertain(error) ? null : copy.message}
        </>
      ) : (
        copy.message
      )}
    </Notice>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  className,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5 sm:px-6",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading
            id={id}
            className="font-display text-[22px] leading-tight text-ink"
          >
            {title}
          </Heading>
          {description ? (
            <p className="text-[14px] leading-snug text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-semibold",
        tone === "success" && "bg-success-soft text-[#2c4f38]",
        tone === "muted" && "bg-sand text-ink-soft",
        tone === "warning" && "bg-warning-soft text-[#6b4613]",
        tone === "neutral" && "bg-accent-soft text-ink",
      )}
    >
      {children}
    </span>
  );
}
