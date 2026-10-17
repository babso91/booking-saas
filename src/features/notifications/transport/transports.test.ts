import { describe, expect, it, vi } from "vitest";

import { httpFailure, networkFailure } from "./http";
import { mailpitTransport } from "./mailpit";
import { MemoryTransport } from "./memory";
import { resendTransport } from "./resend";
import { EmailTransportError, type OutgoingEmail } from "./types";

const message: OutgoingEmail = {
  to: "lea@example.test",
  from: "Studio Mila <reservations@example.test>",
  replyTo: "contact@studio-mila.test",
  subject: "Rendez-vous confirmé – Studio Mila",
  text: "Bonjour",
  html: "<p>Bonjour</p>",
  idempotencyKey: "8a6f3e52-6a0e-4c1f-9d8e-0f6b2c1d3e4f",
};

function fakeFetch(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("httpFailure", () => {
  it.each([
    [401, undefined, "provider_unauthorized", "retry"],
    [403, undefined, "provider_unauthorized", "retry"],
    [408, undefined, "provider_http_408", "retry"],
    [409, undefined, "provider_http_409", "retry"],
    [409, "resource_locked", "provider_http_409", "retry"],
    [
      409,
      "concurrent_idempotent_requests",
      "provider_idempotency_in_progress",
      "retry",
    ],
    [
      409,
      "invalid_idempotent_request",
      "provider_idempotency_conflict",
      "unconfirmed",
    ],
    [429, undefined, "provider_http_429", "retry"],
    [500, undefined, "provider_unavailable", "retry"],
    [503, undefined, "provider_unavailable", "retry"],
    [400, undefined, "provider_rejected_400", "permanent"],
    [422, undefined, "provider_rejected_422", "permanent"],
  ] as const)("HTTP %i %s → %s (%s)", (status, name, code, outcome) => {
    expect(httpFailure(status, name)).toMatchObject({ code, outcome });
  });

  it("a request without an answer is retried", () => {
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    expect(networkFailure(timeout)).toMatchObject({
      code: "provider_timeout",
      outcome: "retry",
    });
    expect(networkFailure(new TypeError("fetch failed"))).toMatchObject({
      code: "provider_network",
      outcome: "retry",
    });
  });
});

describe("resendTransport", () => {
  it("sends one message with the outbox id as idempotency key", async () => {
    const fetch = fakeFetch(Response.json({ id: "re-123" }));
    const sent = await resendTransport("re_test_key_0123456789", fetch).send(
      message,
      AbortSignal.timeout(1000),
    );
    expect(sent).toEqual({ providerMessageId: "re-123" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key_0123456789");
    expect(headers["idempotency-key"]).toBe(message.idempotencyKey);
    expect(JSON.parse(init.body as string)).toEqual({
      from: message.from,
      to: ["lea@example.test"],
      reply_to: ["contact@studio-mila.test"],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("maps provider answers onto retryable and permanent failures", async () => {
    await expect(
      resendTransport(
        "re_k",
        fakeFetch(new Response("slow down", { status: 429 })),
      ).send(message, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "provider_http_429", outcome: "retry" });
    const rejected = resendTransport(
      "re_k",
      fakeFetch(
        Response.json(
          { message: "Invalid `to` field: lea@example.test" },
          { status: 422 },
        ),
      ),
    ).send(message, AbortSignal.timeout(1000));
    await expect(rejected).rejects.toBeInstanceOf(EmailTransportError);
    // The provider's text (which quotes the address) is never carried.
    await rejected.catch((error: EmailTransportError) => {
      expect(error.message).toBe("provider_rejected_422");
      expect(error.message).not.toContain("lea@");
    });
    await expect(
      resendTransport("re_k", fakeFetch(new TypeError("fetch failed"))).send(
        message,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "provider_network", outcome: "retry" });
  });
});

describe("resendTransport: idempotency conflicts (409)", () => {
  const conflict = (name: string) =>
    resendTransport(
      "re_k",
      fakeFetch(
        Response.json(
          {
            statusCode: 409,
            name,
            message: "Request for lea@example.test conflicts",
          },
          { status: 409 },
        ),
      ),
    ).send(message, AbortSignal.timeout(1000));

  it("a key reused with another body: delivery unconfirmed, never retried", async () => {
    const error = await conflict("invalid_idempotent_request").catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "provider_idempotency_conflict",
      outcome: "unconfirmed",
    });
    // Only the error type is read: the provider's message (which may
    // quote the address) is never carried.
    expect((error as Error).message).not.toContain("lea@");
  });

  it("a concurrent request with the same key: retried later", async () => {
    await expect(
      conflict("concurrent_idempotent_requests"),
    ).rejects.toMatchObject({
      code: "provider_idempotency_in_progress",
      outcome: "retry",
    });
    await expect(conflict("resource_locked")).rejects.toMatchObject({
      code: "provider_http_409",
      outcome: "retry",
    });
  });

  it("an unreadable 409 body is retried (no evidence of a conflict)", async () => {
    await expect(
      resendTransport(
        "re_k",
        fakeFetch(new Response("<html>", { status: 409 })),
      ).send(message, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "provider_http_409", outcome: "retry" });
  });
});

describe("mailpitTransport", () => {
  it("posts to the Mailpit send API, with the sender split in name and address", async () => {
    const fetch = fakeFetch(Response.json({ ID: "mp-1" }));
    const sent = await mailpitTransport("http://127.0.0.1:54324", fetch).send(
      message,
      AbortSignal.timeout(1000),
    );
    expect(sent).toEqual({ providerMessageId: "mp-1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54324/api/v1/send");
    expect(JSON.parse(init.body as string)).toMatchObject({
      From: { Name: "Studio Mila", Email: "reservations@example.test" },
      To: [{ Email: "lea@example.test" }],
      ReplyTo: [{ Email: "contact@studio-mila.test" }],
      Subject: message.subject,
    });
  });
});

describe("MemoryTransport", () => {
  it("records accepted messages and follows its script", async () => {
    const transport = new MemoryTransport();
    transport.failNext("provider_unavailable");
    await expect(
      transport.send(message, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "provider_unavailable", outcome: "retry" });
    await expect(
      transport.send(message, AbortSignal.timeout(1000)),
    ).resolves.toEqual({
      providerMessageId: "memory-1",
    });
    expect(transport.attempts).toHaveLength(2);
    expect(transport.sent).toHaveLength(1);
  });
});
