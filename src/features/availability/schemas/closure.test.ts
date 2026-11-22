import { describe, expect, it } from "vitest";

import { closureCommitSchema, MESSAGE_LINK } from "./closure";

describe("closure message", () => {
  it("finds a link, not a sentence nor a phone number", () => {
    for (const linked of [
      "https://x.test",
      "http://x",
      "www.salon",
      "monsalon.fr",
      "bit.ly/abc",
      "Écris-moi sur salon.com!",
    ]) {
      expect(MESSAGE_LINK.test(linked), linked).toBe(true);
    }
    for (const plain of [
      "Je suis malade.A bientôt",
      "Fermé jusqu’au 3. Merci !",
      "Appelle-moi au 06 11 22 33 44",
      "Désolée, à très vite.",
    ]) {
      expect(MESSAGE_LINK.test(plain), plain).toBe(false);
    }
  });

  it("is refused by the schema with a link", () => {
    const base = {
      businessId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      requestId: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
      startDate: "2026-12-02",
      endDate: "2026-12-02",
      decisions: [],
    };
    expect(
      closureCommitSchema.safeParse({ ...base, message: "Désolée !" }).success,
    ).toBe(true);
    expect(
      closureCommitSchema.safeParse({ ...base, message: "Voir www.ailleurs" })
        .success,
    ).toBe(false);
  });
});
