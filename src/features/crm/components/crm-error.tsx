import Link from "next/link";
import type { ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import type { UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

/** A CRM read that failed: plain words, the next useful action. */
export function CrmError({
  error,
  onRetry,
  children,
}: {
  error: UiError;
  onRetry?: () => void;
  /** Replaces the generic message (the zone it concerns). */
  children?: ReactNode;
}) {
  const copy = describeError(error);
  const actionClass =
    "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";
  return (
    <Notice
      tone={error.code === "network" ? "offline" : "error"}
      title={copy.title}
      action={
        error.code === "unauthenticated" ? (
          <Link href="/login" className={actionClass}>
            Me reconnecter
          </Link>
        ) : onRetry ? (
          <button type="button" onClick={onRetry} className={actionClass}>
            Réessayer
          </button>
        ) : undefined
      }
    >
      {children ?? copy.message}
    </Notice>
  );
}
