import { afterEach, describe, expect, it, vi } from "vitest";

import { getEmailEnv } from "./server";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stub(values: Record<string, string>) {
  for (const name of [
    "EMAIL_TRANSPORT",
    "EMAIL_FROM",
    "RESEND_API_KEY",
    "MAILPIT_URL",
  ]) {
    vi.stubEnv(name, values[name] ?? "");
  }
}

describe("getEmailEnv", () => {
  it("is null (delivery disabled) unless a transport is named", () => {
    stub({
      RESEND_API_KEY: "re_live_0123456789abcdef",
      EMAIL_FROM: "a@b.test",
    });
    expect(getEmailEnv()).toBeNull();
  });

  it("enables Resend with a real key only (never the .env.example placeholder)", () => {
    stub({
      EMAIL_TRANSPORT: "resend",
      EMAIL_FROM: "Studio Mila <reservations@example.test>",
      RESEND_API_KEY: "re_replace_me",
    });
    expect(getEmailEnv()).toBeNull();
    stub({
      EMAIL_TRANSPORT: "resend",
      EMAIL_FROM: "Studio Mila <reservations@example.test>",
      RESEND_API_KEY: "re_live_0123456789abcdef",
    });
    expect(getEmailEnv()).toMatchObject({ EMAIL_TRANSPORT: "resend" });
  });

  it("refuses a sender that is not one address on one line", () => {
    for (const from of [
      "reservations@example.test\r\nBcc: v@x.test",
      "Studio <a@b.test>, Autre <c@d.test>",
      "pas-une-adresse",
    ]) {
      stub({ EMAIL_TRANSPORT: "mailpit", EMAIL_FROM: from });
      expect(getEmailEnv(), from).toBeNull();
    }
  });

  it("Mailpit defaults to the local stack", () => {
    stub({ EMAIL_TRANSPORT: "mailpit", EMAIL_FROM: "dev@example.test" });
    expect(getEmailEnv()).toEqual({
      EMAIL_TRANSPORT: "mailpit",
      EMAIL_FROM: "dev@example.test",
      MAILPIT_URL: "http://127.0.0.1:54324",
    });
  });
});
