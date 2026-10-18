import { httpFailure, networkFailure } from "./http";
import type { EmailTransport, OutgoingEmail, SentEmail } from "./types";

/**
 * Local development and tests: delivers to Mailpit (bundled with the local
 * Supabase stack, http://127.0.0.1:54324) through its HTTP send API.
 * Nothing leaves the machine; never a production transport.
 */
export function mailpitTransport(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  const endpoint = new URL("/api/v1/send", baseUrl).toString();

  return {
    name: "mailpit",
    async send(email: OutgoingEmail, signal: AbortSignal): Promise<SentEmail> {
      const from = parseAddress(email.from);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            From: from,
            To: [{ Email: email.to }],
            ReplyTo: email.replyTo ? [{ Email: email.replyTo }] : undefined,
            Subject: email.subject,
            Text: email.text,
            HTML: email.html,
            Headers: { "X-Booking-Idempotency-Key": email.idempotencyKey },
          }),
          signal,
        });
      } catch (error) {
        throw networkFailure(error);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpFailure(response.status);
      }

      const body = (await response.json().catch(() => null)) as {
        ID?: unknown;
      } | null;
      return {
        providerMessageId: typeof body?.ID === "string" ? body.ID : null,
      };
    },
  };
}

/** "Name <address>" or "address" → Mailpit's { Name, Email }. */
function parseAddress(value: string) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  return match
    ? { Name: match[1] || undefined, Email: match[2]! }
    : { Email: value.trim() };
}
