import type { ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import type { UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

const warningCodes = new Set<UiError["code"]>([
  "email_not_confirmed",
  "rate_limited",
  "already_onboarded",
]);

/** Maps an action error to the calm inline notice used by every form. */
export function ErrorNotice({
  error,
  action,
  children,
}: {
  error: UiError;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const copy = describeError(error);
  const tone =
    error.code === "network"
      ? "offline"
      : error.code === "email_taken"
        ? "info"
        : warningCodes.has(error.code)
          ? "warning"
          : "error";

  return (
    <Notice tone={tone} title={copy.title} action={action}>
      {children ?? copy.message}
    </Notice>
  );
}
