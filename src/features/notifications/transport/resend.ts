import { httpFailure, networkFailure } from "./http";
import type { EmailTransport, OutgoingEmail, SentEmail } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Resend (the provider chosen in docs/ARCHITECTURE.md). Inactive until
 * EMAIL_TRANSPORT=resend and a real RESEND_API_KEY are configured. The
 * outbox id is sent as Idempotency-Key: Resend drops a second submission
 * of the same key for 24 hours.
 */
export function resendTransport(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    name: "resend",
    async send(email: OutgoingEmail, signal: AbortSignal): Promise<SentEmail> {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": email.idempotencyKey,
          },
          body: JSON.stringify({
            from: email.from,
            to: [email.to],
            reply_to: email.replyTo ? [email.replyTo] : undefined,
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal,
        });
      } catch (error) {
        throw networkFailure(error);
      }

      if (!response.ok) {
        // The body may quote the address: never read into a log or the outbox.
        await response.body?.cancel().catch(() => undefined);
        throw httpFailure(response.status);
      }

      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      return {
        providerMessageId: typeof body?.id === "string" ? body.id : null,
      };
    },
  };
}
