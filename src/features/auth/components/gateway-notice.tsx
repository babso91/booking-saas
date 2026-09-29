import type { ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import {
  describeGatewayError,
  type GatewayError,
} from "@/features/auth/gateway";

// Maps a gateway error to the calm inline notice used by every form.
export function GatewayNotice({
  error,
  action,
  children,
}: {
  error: GatewayError;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const copy = describeGatewayError(error);
  const tone =
    error.code === "network"
      ? "offline"
      : error.code === "email_not_confirmed" ||
          error.code === "rate_limited" ||
          error.code === "already_onboarded"
        ? "warning"
        : "error";

  return (
    <Notice tone={tone} title={copy.title} action={action}>
      {children ?? copy.message}
    </Notice>
  );
}
