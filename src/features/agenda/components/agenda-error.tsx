import Link from "next/link";
import type { ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import type { UiError } from "@/features/auth/client/call-action";

import { agendaErrorCopy, type AgendaSubject } from "../client/errors";

const warningCodes = new Set<UiError["code"]>([
  "stale_appointment",
  "stale_block",
  "ambiguous_local_time",
  "invalid_status_transition",
  "appointment_not_editable",
]);

/** Inline agenda error with the next useful action. */
export function AgendaError({
  error,
  subject,
  action,
}: {
  error: UiError;
  subject: AgendaSubject;
  action?: ReactNode;
}) {
  const copy = agendaErrorCopy(error, subject);
  const tone =
    error.code === "network"
      ? "offline"
      : warningCodes.has(error.code)
        ? "warning"
        : "error";

  return (
    <Notice
      tone={tone}
      title={copy.title}
      action={
        action ??
        (error.code === "unauthenticated" ? (
          <Link
            href="/login"
            className="text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
          >
            Me reconnecter
          </Link>
        ) : undefined)
      }
    >
      {copy.message}
    </Notice>
  );
}

export function TextAction({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
