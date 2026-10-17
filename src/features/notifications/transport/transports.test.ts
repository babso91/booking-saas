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
    [401, "provider_unauthorized", false],
    [403, "provider_unauthorized", false],
    [408, "provider_http_408", false],
    [409, "provider_http_409", false],
    [429, "provider_http_429", false],
    [500, "provider_unavailable", false],
    [503, "provider_unavailable", false],
    [400, "provider_rejected_400", true],
    [422, "provider_rejected_422", true],
  ])("HTTP %i → %s (permanent: %s)", (status, code, permanent) => {
    expect(httpFailure(status)).toMatchObject({ code, permanent });
  });

  it("a request without an answer is retried", () => {
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    expect(networkFailure(timeout)).toMatchObject({
      code: "provider_timeout",
      permanent: false,
    });
    expect(networkFailure(new TypeError("fetch failed"))).toMatchObject({
      code: "provider_network",
      permanent: false,
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
    ).rejects.toMatchObject({ code: "provider_http_429", permanent: false });
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
    ).rejects.toMatchObject({ code: "provider_network", permanent: false });
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
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(
      transport.send(message, AbortSignal.timeout(1000)),
    ).resolves.toEqual({
      providerMessageId: "memory-1",
    });
    expect(transport.attempts).toHaveLength(2);
    expect(transport.sent).toHaveLength(1);
  });
});
