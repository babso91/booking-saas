import { describe, expect, it } from "vitest";

import type { UiErrorCode } from "@/features/auth/client/call-action";

import { agendaErrorCopy, fieldErrorsCopy } from "./errors";

const documented: UiErrorCode[] = [
  "unauthenticated",
  "no_business",
  "forbidden",
  "validation_error",
  "appointment_not_found",
  "block_not_found",
  "client_not_found",
  "service_unavailable",
  "schedule_conflict",
  "stale_appointment",
  "stale_block",
  "invalid_status_transition",
  "appointment_not_editable",
  "idempotency_conflict",
  "ambiguous_local_time",
  "internal",
  "network",
];

describe("agenda error copy", () => {
  it.each(documented)("has human copy for %s", (code) => {
    const copy = agendaErrorCopy({ code }, "appointment");
    expect(copy.title.length).toBeGreaterThan(0);
    expect(`${copy.title} ${copy.message}`).not.toMatch(
      /sql|supabase|postgres|error|exception|\d{5}/i,
    );
  });

  it("words conflicts for what the user acted on", () => {
    expect(
      agendaErrorCopy({ code: "schedule_conflict" }, "appointment").message,
    ).toBe(
      "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
    );
    expect(
      agendaErrorCopy({ code: "schedule_conflict" }, "block").message,
    ).toContain("chevauche un rendez-vous");
    expect(
      agendaErrorCopy({ code: "stale_appointment" }, "appointment").message,
    ).toBe("Ce rendez-vous a été modifié depuis son ouverture.");
  });

  it("maps backend field errors to product copy, never backend text", () => {
    expect(
      fieldErrorsCopy({
        code: "validation_error",
        fieldErrors: {
          time: ["Cette heure n’existe pas ce jour-là (changement d’heure)."],
          "client.email": ["Invalid email address"],
          "block.endsAt": ["La fin doit être après le début."],
          mystery: ["whatever"],
        },
      }),
    ).toEqual({
      time: "Cette heure n’existe pas ce jour-là (passage à l’heure d’été). Choisis une autre heure.",
      "client.email": "Cet email semble invalide.",
      endsAt: "La fin doit être après le début.",
      mystery: "Vérifie ce champ.",
    });
  });
});
