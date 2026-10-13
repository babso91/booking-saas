import { describe, expect, it } from "vitest";

import { clientRecord } from "../../../../tests/support/crm-fixtures";
import {
  changedElsewhere,
  checkContact,
  contactCommand,
  draftFromRecord,
  EMPTY_CONTACT,
  rebaseDraft,
} from "./contact-form";
import { checkNote, isLongNote, noteContent } from "./notes";

describe("customer form", () => {
  it("sends what the backend stores: NFC, trimmed, email lower-cased, empty optional fields absent", () => {
    expect(
      contactCommand({
        firstName: "  Élise ",
        lastName: " ",
        email: " Elise@Exemple.FR ",
        phone: "",
      }),
    ).toEqual({
      firstName: "Élise",
      lastName: null,
      email: "elise@exemple.fr",
      phone: null,
    });
  });

  it("asks only for the first name; checks the format of what is given", () => {
    expect(checkContact({ ...EMPTY_CONTACT, firstName: "Léa" })).toEqual({});
    expect(checkContact(EMPTY_CONTACT)).toEqual({
      firstName: "Indique au moins le prénom.",
    });
    expect(
      Object.keys(
        checkContact({
          firstName: "Léa",
          lastName: "x".repeat(121),
          email: "lea@",
          phone: "abc",
        }),
      ),
    ).toEqual(["lastName", "email", "phone"]);
    expect(
      checkContact({
        ...EMPTY_CONTACT,
        firstName: "Léa",
        phone: "+33 (0)6 12-34.56",
      }),
    ).toEqual({});
  });

  it("a draft moved onto a record changed elsewhere keeps only what was typed", () => {
    const base = clientRecord({ version: 3 });
    const current = clientRecord({ version: 5, phone: "06 99 99 99 99" });
    const draft = { ...draftFromRecord(base), email: "emma@nouveau.fr" };
    expect(changedElsewhere(base, current, draft)).toEqual([
      {
        field: "phone",
        current: "06 99 99 99 99",
        typed: "06 12 34 56 78",
        edited: false,
      },
    ]);
    expect(rebaseDraft(base, current, draft)).toEqual({
      ...draftFromRecord(current),
      email: "emma@nouveau.fr",
    });

    // Both changed the same field: what was typed is kept (her choice).
    const both = { ...draftFromRecord(base), phone: "07 00 00 00 00" };
    expect(changedElsewhere(base, current, both)[0]!.edited).toBe(true);
    expect(rebaseDraft(base, current, both).phone).toBe("07 00 00 00 00");
  });
});

describe("note text", () => {
  it("is stored NFC and trimmed, inner line breaks kept", () => {
    expect(noteContent("  Ligne 1\nLigne 2\n ")).toBe("Ligne 1\nLigne 2");
  });

  it("is refused empty or beyond the backend's 5,000 characters", () => {
    expect(checkNote(" \n ")).toBe("Écris quelques mots avant d’enregistrer.");
    expect(checkNote("a".repeat(5000))).toBeNull();
    expect(checkNote("a".repeat(5003))).toMatch(/retire-en 3\.$/);
  });

  it("is folded when long or tall, never cut", () => {
    expect(isLongNote("Court.")).toBe(false);
    expect(isLongNote("x".repeat(421))).toBe(true);
    expect(isLongNote("1\n2\n3\n4\n5\n6\n7")).toBe(true);
  });
});
