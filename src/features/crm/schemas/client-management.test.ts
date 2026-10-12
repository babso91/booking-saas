import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createClientNoteSchema,
  createClientSchema,
  deleteClientNoteSchema,
  listClientNotesSchema,
  MAX_NOTE_LENGTH,
  updateClientNoteSchema,
  updateClientSchema,
} from "./client-management";

const ID = randomUUID();

const issuesOf = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}) => (result.error?.issues ?? []).map((issue) => issue.path.join("."));

describe("customer creation input", () => {
  it("normalizes like the database: NFC, trimmed, email lower-cased, empty → null", () => {
    const parsed = createClientSchema.parse({
      firstName: "  Élodie ",
      lastName: "   ",
      email: "  Elodie@Example.COM ",
      phone: " 06 12 34 56 78 ",
      requestId: ID,
    });
    expect(parsed).toEqual({
      firstName: "Élodie",
      lastName: null,
      email: "elodie@example.com",
      phone: "06 12 34 56 78",
      requestId: ID,
    });
    expect(
      createClientSchema.parse({
        firstName: "Sam",
        email: "",
        phone: "",
        requestId: ID,
      }),
    ).toMatchObject({ email: null, phone: null, lastName: null });
  });

  it("requires a first name and a request id; bounds every field", () => {
    expect(
      issuesOf(createClientSchema.safeParse({ firstName: "Sam" })),
    ).toEqual(["requestId"]);
    for (const [input, path] of [
      [{ firstName: " " }, "firstName"],
      [{ firstName: "x".repeat(121) }, "firstName"],
      [{ firstName: "Sam", lastName: "x".repeat(121) }, "lastName"],
      [{ firstName: "Sam", email: "sam@" }, "email"],
      [{ firstName: "Sam", email: `${"x".repeat(250)}@x.fr` }, "email"],
      [{ firstName: "Sam", phone: "12" }, "phone"],
      [{ firstName: "Sam", phone: "06-12-34-56-78#" }, "phone"],
      [{ firstName: "Sam", requestId: "1" }, "requestId"],
    ] as const) {
      expect(
        issuesOf(createClientSchema.safeParse({ requestId: ID, ...input })),
      ).toContain(path);
    }
  });
});

describe("customer edition input", () => {
  it("carries the whole contact and the version read; absent optional fields are removed", () => {
    expect(
      updateClientSchema.parse({
        clientId: ID,
        expectedVersion: 3,
        firstName: "Iris",
      }),
    ).toEqual({
      clientId: ID,
      expectedVersion: 3,
      firstName: "Iris",
      lastName: null,
      email: null,
      phone: null,
    });
  });

  it("requires a positive integer version within PostgreSQL's integer", () => {
    for (const expectedVersion of [0, -1, 1.5, "2", 2_147_483_648, undefined]) {
      expect(
        issuesOf(
          updateClientSchema.safeParse({
            clientId: ID,
            expectedVersion,
            firstName: "Iris",
          }),
        ),
      ).toContain("expectedVersion");
    }
    expect(
      issuesOf(
        updateClientSchema.safeParse({
          clientId: "x",
          expectedVersion: 1,
          firstName: "Iris",
        }),
      ),
    ).toContain("clientId");
  });
});

describe("note inputs", () => {
  it("trims the content (NFC first), keeps inner line breaks, bounds its length", () => {
    expect(
      createClientNoteSchema.parse({
        clientId: ID,
        content: " \n Allergie au latéx\n  Rappeler.\t",
        requestId: ID,
      }).content,
    ).toBe("Allergie au latéx\n  Rappeler.");
    expect(
      createClientNoteSchema.safeParse({
        clientId: ID,
        content: "x".repeat(MAX_NOTE_LENGTH),
        requestId: ID,
      }).success,
    ).toBe(true);
    for (const content of ["", " \n\t ", "x".repeat(MAX_NOTE_LENGTH + 1), 42]) {
      expect(
        issuesOf(
          createClientNoteSchema.safeParse({
            clientId: ID,
            content,
            requestId: ID,
          }),
        ),
      ).toContain("content");
    }
    expect(
      issuesOf(
        createClientNoteSchema.safeParse({ clientId: ID, content: "Note" }),
      ),
    ).toEqual(["requestId"]);
  });

  it("edits and deletions name the customer, the note and the version read", () => {
    const edit = {
      clientId: ID,
      noteId: ID,
      expectedVersion: 2,
      content: "Nouveau",
    };
    expect(updateClientNoteSchema.parse(edit)).toEqual(edit);
    expect(
      issuesOf(updateClientNoteSchema.safeParse({ ...edit, noteId: "x" })),
    ).toContain("noteId");
    expect(
      issuesOf(deleteClientNoteSchema.safeParse({ clientId: ID, noteId: ID })),
    ).toEqual(["expectedVersion"]);
  });

  it("pages: 20 by default, at most 100, an opaque bounded cursor", () => {
    expect(listClientNotesSchema.parse({ clientId: ID })).toEqual({
      clientId: ID,
      limit: 20,
    });
    for (const limit of [0, 101, 2.5]) {
      expect(
        issuesOf(listClientNotesSchema.safeParse({ clientId: ID, limit })),
      ).toContain("limit");
    }
    expect(
      issuesOf(
        listClientNotesSchema.safeParse({
          clientId: ID,
          cursor: "x".repeat(1025),
        }),
      ),
    ).toContain("cursor");
  });
});
