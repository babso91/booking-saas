import "server-only";

import { getEmailEnv } from "@/lib/env/server";

import { mailpitTransport } from "./mailpit";
import { resendTransport } from "./resend";
import type { EmailTransport } from "./types";

export type ConfiguredTransport = { transport: EmailTransport; from: string };

/** The configured transport and sender, or null (delivery disabled). */
export function getEmailTransport(): ConfiguredTransport | null {
  const env = getEmailEnv();
  if (!env) return null;
  switch (env.EMAIL_TRANSPORT) {
    case "resend":
      return {
        transport: resendTransport(env.RESEND_API_KEY),
        from: env.EMAIL_FROM,
      };
    case "mailpit":
      return {
        transport: mailpitTransport(env.MAILPIT_URL),
        from: env.EMAIL_FROM,
      };
  }
}
