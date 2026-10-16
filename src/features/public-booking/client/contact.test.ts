import { describe, expect, it } from "vitest";

import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";

import { canonicalContact, checkContact, EMPTY_CONTACT } from "./contact";

const base = {
  slug: "studio-mila",
  serviceId: "30000000-0000-4000-8000-000000000001",
  startsAt: "2026-10-20T16:30:00.000Z",
  requestId: "50000000-0000-4000-8000-000000000001",
};

describe("contact details of a public booking", () => {
  it("sends trimmed values, the email in lower case, and leaves empty optionals out", () => {
    expect(
      canonicalContact({
        firstName: "  Inès ",
        lastName: "  ",
        email: " Ines@Exemple.FR ",
        phone: "",
      }),
    ).toEqual({ firstName: "Inès", email: "ines@exemple.fr" });
  });

  it("agrees with the backend schema on what is valid", () => {
    const cases = [
      { ...EMPTY_CONTACT, firstName: "Inès", email: "ines@exemple.fr" },
      { ...EMPTY_CONTACT, firstName: "", email: "ines@exemple.fr" },
      { ...EMPTY_CONTACT, firstName: "Inès", email: "ines@" },
      {
        ...EMPTY_CONTACT,
        firstName: "Inès",
        email: "a@b.fr",
        phone: "+33 (0)6 12-34.56",
      },
      { ...EMPTY_CONTACT, firstName: "Inès", email: "a@b.fr", phone: "06 abc" },
      { ...EMPTY_CONTACT, firstName: "x".repeat(121), email: "a@b.fr" },
      {
        ...EMPTY_CONTACT,
        firstName: "Inès",
        lastName: "y".repeat(121),
        email: "a@b.fr",
      },
    ];
    for (const contact of cases) {
      const local = Object.keys(checkContact(contact)).length === 0;
      const backend = createPublicBookingSchema.safeParse({
        ...base,
        ...canonicalContact(contact),
      }).success;
      expect({ contact, local }).toEqual({ contact, local: backend });
    }
  });
});
