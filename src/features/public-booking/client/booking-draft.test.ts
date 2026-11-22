// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  clearBookingDraft,
  DRAFT_TTL_MS,
  readBookingDraft,
  writeBookingDraft,
  type BookingDraft,
} from "./booking-draft";

// Higani point 67: her booking in progress, kept in this tab only.

const draft: BookingDraft = {
  serviceId: "s1",
  answers: { o1: "c1", o2: null },
  date: "2026-11-24",
  startsAt: "2026-11-24T09:00:00.000Z",
  step: "review",
  contact: { firstName: "Inès", lastName: "", email: "ines@x.fr", phone: "" },
  savedAt: 1_000,
};

describe("booking draft", () => {
  it("is read back for the same business page, within six hours", () => {
    writeBookingDraft("studio-mila", draft);
    expect(readBookingDraft("studio-mila", 2_000)).toEqual(draft);
    expect(readBookingDraft("atelier-nour", 2_000)).toBeNull();
    expect(readBookingDraft("studio-mila", 1_000 + DRAFT_TTL_MS)).toBeNull();
    clearBookingDraft("studio-mila");
    expect(readBookingDraft("studio-mila", 2_000)).toBeNull();
  });

  it("anything else stored there is ignored", () => {
    for (const raw of [
      "pas du json",
      "null",
      JSON.stringify({ ...draft, step: "done" }),
      JSON.stringify({ ...draft, date: "24/11/2026" }),
      JSON.stringify({ ...draft, answers: { o1: 3 } }),
      JSON.stringify({ ...draft, contact: { firstName: "Inès" } }),
    ]) {
      window.sessionStorage.setItem("public-booking-draft:studio-mila", raw);
      expect(readBookingDraft("studio-mila", 2_000)).toBeNull();
    }
  });
});
