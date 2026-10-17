import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  claimedEmailSchema,
  claimIdentitySchema,
} from "../schemas/claimed-email";
import { renderEmail } from "../templates/render";
import {
  EmailTransportError,
  type EmailMessage,
  type EmailTransport,
} from "../transport/types";
import { logEmail } from "./log";
import {
  claimEmails,
  completeEmail,
  failEmail,
  prepareEmail,
  releaseEmail,
} from "./outbox";

// Outbox consumer. Each run claims a bounded batch (PostgreSQL decides what
// is due and still applies, and hands each email to one worker at a time),
// sends them one by one, and records each outcome against its claim.
//
// Guarantees:
// * Concurrent runs never deliver the same claim twice: claims are taken
//   with FOR UPDATE SKIP LOCKED and recorded by compare-and-set.
// * A run that crashes leaves its claims to expire (lease of 2 minutes);
//   they are claimed again, with the same idempotency key.
// * Delivery is at least once, not exactly once: a provider that accepted
//   a message whose acceptance was never recorded may receive it again
//   (deduplicated by providers that honour the idempotency key).
// * The run stops sending at its budget and gives back what it claimed but
//   did not attempt; a send is bounded by its own timeout, well inside the
//   lease.
// * Each email is checked again right before its send, under a lock on the
//   appointment (email_outbox_prepare): an appointment cancelled or moved
//   after the claim is not reminded with former details. From that check
//   on, the email counts as possibly delivered: a later change or
//   cancellation notifies the customer.
// * The message is frozen at its first submission: retries send the same
//   request under the same idempotency key, never a re-rendered one.

export type EmailWorkerDeps = {
  admin: AppSupabaseClient;
  transport: EmailTransport;
  from: string;
  appUrl: string;
  /** The template (tests replace it to simulate a rendering failure). */
  render?: typeof renderEmail;
};

export type EmailWorkerOptions = {
  /** Only this business's emails (the kick after a booking). */
  businessId?: string;
  limit?: number;
  perBusiness?: number;
  /** Time after which no new send starts (the claim lease is 120 s). */
  budgetMs?: number;
  /** Bound of one provider call. */
  sendTimeoutMs?: number;
};

export type EmailWorkerResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  released: number;
  /** No longer applied right before the send (cancelled, not sent). */
  cancelled: number;
  /** Delivery unknown and not retryable safely (see FailureOutcome). */
  unconfirmed: number;
  stale: number;
};

const RECIPIENT =
  /^[^@\s<>,;"\u0000-\u001f\u007f]+@[^@\s<>,;"\u0000-\u001f\u007f]+\.[^@\s<>,;"\u0000-\u001f\u007f]+$/;

/** A deliverable address: one mailbox, no display name, no header syntax. */
export function isDeliverableAddress(value: string | null | undefined) {
  return !!value && value.length <= 254 && RECIPIENT.test(value);
}

export async function runEmailOutbox(
  deps: EmailWorkerDeps,
  options: EmailWorkerOptions = {},
): Promise<EmailWorkerResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 45_000;
  const sendTimeoutMs = options.sendTimeoutMs ?? 15_000;
  const result: EmailWorkerResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    released: 0,
    cancelled: 0,
    unconfirmed: 0,
    stale: 0,
  };

  const items = await claimEmails(deps.admin, {
    limit: options.limit ?? 20,
    perBusiness: options.perBusiness ?? 5,
    businessId: options.businessId,
  });
  result.claimed = items.length;

  for (const raw of items) {
    const identity = claimIdentitySchema.safeParse(raw);
    if (!identity.success) {
      // Nothing to answer to: the lease expires and the claim is retried.
      logEmail("claim_unreadable", {}, "error");
      continue;
    }
    try {
      await deliver(deps, raw, identity.data, result, {
        startedAt,
        budgetMs,
        sendTimeoutMs,
      });
    } catch {
      // A database error while recording: the lease expires and the email
      // is claimed again (same idempotency key). The other claims go on.
      logEmail(
        "email_record_failed",
        { emailEventId: identity.data.id },
        "error",
      );
    }
  }

  return result;
}

async function deliver(
  deps: EmailWorkerDeps,
  raw: unknown,
  claim: { id: string; claimId: string },
  result: EmailWorkerResult,
  timing: { startedAt: number; budgetMs: number; sendTimeoutMs: number },
) {
  const { startedAt, budgetMs, sendTimeoutMs } = timing;
  if (Date.now() - startedAt >= budgetMs) {
    if (await releaseEmail(deps.admin, claim)) result.released += 1;
    return;
  }

  const parsed = claimedEmailSchema.safeParse(raw);
  if (!parsed.success || !isDeliverableAddress(parsed.data.recipient)) {
    const code = parsed.success ? "invalid_recipient" : "invalid_payload";
    await giveUp(deps, claim, code, result);
    return;
  }
  const email = parsed.data;
  const fields = {
    emailEventId: email.id,
    businessId: email.businessId,
    type: email.type,
    transport: deps.transport.name,
    attempt: email.attempt,
  };

  // A message already handed to the provider is sent again exactly as it
  // was; otherwise it is rendered now. Rendering is deterministic on the
  // claimed data: a failure would repeat at every attempt, so it gives the
  // email up at once (a stable code, nothing about the customer logged).
  let message: EmailMessage | null = email.message;
  if (!message) {
    try {
      const rendered = (deps.render ?? renderEmail)(email, {
        appUrl: deps.appUrl,
      });
      message = {
        to: email.recipient,
        from: deps.from,
        replyTo: isDeliverableAddress(email.business.contactEmail)
          ? email.business.contactEmail!
          : undefined,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      };
    } catch {
      await giveUp(deps, claim, "render_failed", result);
      return;
    }
  }

  // Under a lock on the appointment: still applies? which exact message?
  const prepared = await prepareEmail(
    deps.admin,
    claim,
    email.appointment.version,
    message,
  );
  switch (prepared.action) {
    case "send":
      break;
    case "cancelled":
      result.cancelled += 1;
      logEmail("email_no_longer_applies", { ...fields, code: prepared.code });
      return;
    case "rerender":
      // The appointment changed since the claim: rendered again next run.
      result.released += 1;
      logEmail("email_rerender", fields);
      return;
    case "unconfirmed":
      result.unconfirmed += 1;
      logEmail("email_unconfirmed", fields, "warn");
      return;
    case "invalid":
      await giveUp(deps, claim, "invalid_message", result);
      return;
    case "stale":
      result.stale += 1;
      logEmail("email_stale_claim", fields, "warn");
      return;
  }

  let providerMessageId: string | null;
  try {
    const sent = await deps.transport.send(
      { ...prepared.message, idempotencyKey: email.id },
      AbortSignal.timeout(sendTimeoutMs),
    );
    providerMessageId = sent.providerMessageId;
  } catch (error) {
    const failure =
      error instanceof EmailTransportError
        ? error
        : error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
          ? new EmailTransportError("provider_timeout", "retry")
          : new EmailTransportError("transport_error", "retry");
    const status = await failEmail(
      deps.admin,
      claim,
      failure.code,
      failure.outcome,
    );
    if (status === "pending") result.retried += 1;
    else if (failure.outcome === "unconfirmed" && status === "failed")
      result.unconfirmed += 1;
    else if (status === "failed") result.failed += 1;
    else result.stale += 1;
    logEmail(
      "email_send_failed",
      { ...fields, code: failure.code, status: status ?? "stale_claim" },
      "warn",
    );
    return;
  }

  if (await completeEmail(deps.admin, claim, providerMessageId)) {
    result.sent += 1;
    logEmail("email_sent", fields);
  } else {
    // The lease expired meanwhile and another run claimed the email: it
    // may be sent again (same idempotency key).
    result.stale += 1;
    logEmail("email_stale_claim", fields, "warn");
  }
}

/** Gives the email up: a deterministic failure no retry can fix. */
async function giveUp(
  deps: EmailWorkerDeps,
  claim: { id: string; claimId: string },
  code: string,
  result: EmailWorkerResult,
) {
  const status = await failEmail(deps.admin, claim, code, "permanent");
  if (status) result.failed += 1;
  else result.stale += 1;
  logEmail("email_failed", { emailEventId: claim.id, code }, "warn");
}
