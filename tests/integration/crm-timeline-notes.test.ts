import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createClientNoteAction,
  deleteClientNoteAction,
  listClientNotesAction,
  updateClientNoteAction,
} from "@/features/crm/actions/client-notes";
import {
  getClientProfileAction,
  listClientTimelineAction,
} from "@/features/crm/actions/crm";
import type {
  ClientTimelineEvent,
  ClientTimelinePageDto,
  NoteTimelineEvent,
} from "@/features/crm/types";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// CRM V1, PR #19 (backend): private dated notes in the relationship
// timeline (public.crm_client_timeline, 20261015090000), through the real
// Server Actions, the user's session and row level security. Arrangement and
// inspection go through `db` (postgres).

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));

function as(professional: Professional | null) {
  sessionClient = professional ? professional.client : anonClient();
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

let ownerA: Professional;
let ownerB: Professional;
let A: TestBusiness;
let B: TestBusiness;
let coupe: string;

beforeAll(async () => {
  ownerA = await createProfessional("crm-tl-notes-a");
  ownerB = await createProfessional("crm-tl-notes-b");
  A = await createBusiness(ownerA.userId, { timezone: "Europe/Paris" });
  B = await createBusiness(ownerB.userId, { timezone: "America/Vancouver" });
  coupe = await createService(A.id, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4500,
  });
});

async function customer(business: string, firstName: string) {
  const { rows } = await db.query<{ id: string }>(
    "insert into public.clients (business_id, first_name) values ($1, $2) returning id",
    [business, firstName],
  );
  return rows[0]!.id;
}

/**
 * A note written at a chosen instant (arrangement only). The database dates
 * every note itself (client_notes_guard): the guard is disabled inside this
 * one transaction, invisible to any other session, and enabled again before
 * commit.
 */
async function arrangeNote(
  business: string,
  client: string,
  content: string,
  at: string,
  options: { author?: string | null; editedAt?: string; version?: number } = {},
) {
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(
      "alter table public.client_notes disable trigger client_notes_guard",
    );
    const { rows } = await connection.query<{ id: string }>(
      `insert into public.client_notes
         (business_id, client_id, content, created_by, updated_by, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        business,
        client,
        content,
        options.author ?? null,
        options.editedAt ? (options.author ?? null) : null,
        options.version ?? 1,
        at,
        options.editedAt ?? at,
      ],
    );
    await connection.query(
      "alter table public.client_notes enable trigger client_notes_guard",
    );
    await connection.query("commit");
    return rows[0]!.id;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

async function loyalty(business: string, client: string, at: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.loyalty_events
       (business_id, client_id, type, points_delta, reason, idempotency_key, created_at)
     values ($1, $2, 'manual_adjustment', 5, 'Geste', $3, $4) returning id`,
    [business, client, `crm-tl-${randomUUID()}`, at],
  );
  return rows[0]!.id;
}

async function email(business: string, client: string, at: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.email_events
       (business_id, client_id, type, recipient_email, dedupe_key, created_at, scheduled_for)
     values ($1, $2, 'booking_confirmation', 'cliente@example.test', $3, $4, $4)
     returning id`,
    [business, client, `crm-tl-${randomUUID()}`, at],
  );
  return rows[0]!.id;
}

async function visit(client: string, startsAt: string) {
  return insertAppointment({
    businessId: A.id,
    clientId: client,
    serviceId: coupe,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
    status: "completed",
  });
}

/** Every page of a customer's timeline, `limit` at a time. */
async function allPages(clientId: string, limit: number) {
  const pages: ClientTimelineEvent[][] = [];
  let cursor: string | null = null;
  do {
    const page: ClientTimelinePageDto = ok(
      await listClientTimelineAction({ clientId, limit, cursor }),
    );
    pages.push(page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

const ids = (events: ClientTimelineEvent[]) => events.map((event) => event.id);
const notes = (events: ClientTimelineEvent[]) =>
  events.filter((event): event is NoteTimelineEvent => event.kind === "note");
/** Event ids of one instant: descending, compared byte by byte. */
const byIdDesc = (...values: string[]) =>
  [...values].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));

describe("notes in the relationship timeline", () => {
  let mixed: string;
  let expected: string[];

  beforeAll(async () => {
    mixed = await customer(A.id, "Mixte");
    const appointment = await visit(mixed, "2026-06-10T08:00:00.000Z");
    const n1 = await arrangeNote(
      A.id,
      mixed,
      "Avant la fidélité",
      "2026-06-11T12:00:00Z",
      {
        author: ownerA.userId,
      },
    );
    const entry = await loyalty(A.id, mixed, "2026-06-12T09:00:00Z");
    const n2 = await arrangeNote(
      A.id,
      mixed,
      "Entre deux",
      "2026-06-13T12:00:00.123456Z",
    );
    const sent = await email(A.id, mixed, "2026-06-14T09:00:00Z");
    // Same instant as the email: ordered by event id ("note:" after "email:").
    const n3 = await arrangeNote(
      A.id,
      mixed,
      "Même instant que l'email",
      "2026-06-14T09:00:00Z",
    );
    // Two notes of one instant: ordered by id.
    const n4 = await arrangeNote(
      A.id,
      mixed,
      "Jumelle 1",
      "2026-06-16T00:00:00Z",
    );
    const n5 = await arrangeNote(
      A.id,
      mixed,
      "Jumelle 2",
      "2026-06-16T00:00:00Z",
    );
    expected = [
      ...byIdDesc(`note:${n4}`, `note:${n5}`),
      ...byIdDesc(`note:${n3}`, `email:${sent}`),
      `note:${n2}`,
      `loyalty:${entry}`,
      `note:${n1}`,
      `appointment:${appointment}`,
    ];
  });

  it("are interleaved with appointments, loyalty and emails: newest first, ties by event id", async () => {
    as(ownerA);
    const page = ok(
      await listClientTimelineAction({ clientId: mixed, limit: 100 }),
    );
    expect(ids(page.events)).toEqual(expected);

    const first = notes(page.events).find(
      (event) => event.note.content === "Avant la fidélité",
    )!;
    expect(first).toMatchObject({
      kind: "note",
      occurredAt: {
        at: "2026-06-11T12:00:00.000Z",
        local: "2026-06-11T14:00",
        occurrence: null,
      },
      note: {
        clientId: mixed,
        content: "Avant la fidélité",
        version: 1,
        edited: false,
        createdBy: ownerA.userId,
        updatedBy: null,
      },
    });
    expect(first.id).toBe(`note:${first.note.id}`);
    expect(first.note.createdAt).toEqual(first.occurredAt);
    expect(first.note.updatedAt).toEqual(first.note.createdAt);
    // No invented author: unknown stays null.
    expect(
      notes(page.events).find((event) => event.note.content === "Entre deux")!
        .note.createdBy,
    ).toBeNull();
  });

  it("paginate deterministically at every page size: no duplicate, no gap, ties across boundaries", async () => {
    as(ownerA);
    for (const limit of [1, 2, 3, 4, 5]) {
      const pages = await allPages(mixed, limit);
      expect(ids(pages.flat())).toEqual(expected);
      expect(pages).toHaveLength(Math.ceil(expected.length / limit));
    }
  });

  it("an edit keeps the note's place and shows the current content", async () => {
    const clientId = await customer(A.id, "Édition");
    await visit(clientId, "2026-05-01T08:00:00.000Z");
    as(ownerA);
    const written = ok(
      await createClientNoteAction({
        clientId,
        content: "Version initiale",
        requestId: randomUUID(),
      }),
    ).note;
    await email(A.id, clientId, new Date(Date.now() + 3_600_000).toISOString());
    const before = ok(await listClientTimelineAction({ clientId }));
    const position = ids(before.events).indexOf(`note:${written.id}`);
    expect(position).toBe(1);

    const edited = ok(
      await updateClientNoteAction({
        clientId,
        noteId: written.id,
        expectedVersion: 1,
        content: "Version corrigée",
      }),
    ).note;
    const after = ok(await listClientTimelineAction({ clientId }));
    expect(ids(after.events)).toEqual(ids(before.events));
    const event = notes(after.events)[0]!;
    expect(event).toMatchObject({
      id: `note:${written.id}`,
      occurredAt: written.createdAt,
      note: {
        content: "Version corrigée",
        version: 2,
        edited: true,
        createdBy: ownerA.userId,
        updatedBy: ownerA.userId,
        createdAt: written.createdAt,
        updatedAt: edited.updatedAt,
      },
    });
    expect(new Date(event.note.updatedAt.at).getTime()).toBeGreaterThan(
      new Date(event.note.createdAt.at).getTime(),
    );
    // The very DTO of the notes list and of the edit's answer.
    expect(event.note).toEqual(edited);
    const listed = ok(await listClientNotesAction({ clientId })).notes;
    expect(listed).toEqual([event.note]);
  });

  it("a deleted note is no longer read, even under a cursor that stopped on it", async () => {
    const clientId = await customer(A.id, "Suppression");
    const appointment = await visit(clientId, "2026-04-01T08:00:00.000Z");
    const older = await arrangeNote(
      A.id,
      clientId,
      "Ancienne",
      "2026-04-02T08:00:00Z",
    );
    const boundary = await arrangeNote(
      A.id,
      clientId,
      "À la frontière",
      "2026-04-03T08:00:00Z",
    );
    const newest = await arrangeNote(
      A.id,
      clientId,
      "Récente",
      "2026-04-04T08:00:00Z",
    );
    as(ownerA);
    const first = ok(await listClientTimelineAction({ clientId, limit: 2 }));
    expect(ids(first.events)).toEqual([`note:${newest}`, `note:${boundary}`]);

    ok(
      await deleteClientNoteAction({
        clientId,
        noteId: boundary,
        expectedVersion: 1,
      }),
    );
    const second = ok(
      await listClientTimelineAction({
        clientId,
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect(ids(second.events)).toEqual([
      `note:${older}`,
      `appointment:${appointment}`,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      ids(ok(await listClientTimelineAction({ clientId })).events),
    ).toEqual([
      `note:${newest}`,
      `note:${older}`,
      `appointment:${appointment}`,
    ]);
  });

  it("no notes: the timeline is as before; only notes: only notes; nothing: empty", async () => {
    const withoutNotes = await customer(A.id, "Sans note");
    const appointment = await visit(withoutNotes, "2026-03-01T08:00:00.000Z");
    const entry = await loyalty(A.id, withoutNotes, "2026-03-02T08:00:00Z");
    const onlyNotes = await customer(A.id, "Que des notes");
    const n1 = await arrangeNote(
      A.id,
      onlyNotes,
      "Une",
      "2026-03-01T08:00:00Z",
    );
    const n2 = await arrangeNote(
      A.id,
      onlyNotes,
      "Deux",
      "2026-03-02T08:00:00Z",
    );
    const nothing = await customer(A.id, "Rien");
    as(ownerA);
    expect(
      ids(
        ok(await listClientTimelineAction({ clientId: withoutNotes })).events,
      ),
    ).toEqual([`loyalty:${entry}`, `appointment:${appointment}`]);
    expect(
      ids(ok(await listClientTimelineAction({ clientId: onlyNotes })).events),
    ).toEqual([`note:${n2}`, `note:${n1}`]);
    expect(
      ok(await listClientTimelineAction({ clientId: nothing })),
    ).toMatchObject({ events: [], nextCursor: null });
  });

  it("a long note is returned whole", async () => {
    const clientId = await customer(A.id, "Longue");
    const content = `${"Suivi détaillé, ".repeat(320).slice(0, 4999)}.`;
    as(ownerA);
    ok(
      await createClientNoteAction({
        clientId,
        content,
        requestId: randomUUID(),
      }),
    );
    const [event] = notes(
      ok(await listClientTimelineAction({ clientId })).events,
    );
    expect(event!.note.content).toBe(content);
    expect(event!.note.content).toHaveLength(5000);
  });

  it("stay with their customer and business; never anonymous", async () => {
    const owner = await customer(A.id, "Titulaire");
    const neighbour = await customer(A.id, "Voisine");
    const note = await arrangeNote(
      A.id,
      owner,
      "Privée",
      "2026-02-01T08:00:00Z",
    );
    as(ownerA);
    expect(
      ok(await listClientTimelineAction({ clientId: neighbour })).events,
    ).toEqual([]);

    as(ownerB);
    failure(
      await listClientTimelineAction({ clientId: owner }),
      "client_not_found",
    );
    const intruder = await ownerB.client.rpc("crm_client_timeline", {
      p_business_id: A.id,
      p_client_id: owner,
    });
    expect(intruder.error).toMatchObject({
      code: "42501",
      message: "forbidden",
    });
    // Through B's own business, A's customer does not exist.
    const throughB = await ownerB.client.rpc("crm_client_timeline", {
      p_business_id: B.id,
      p_client_id: owner,
    });
    expect(throughB.error).toMatchObject({ message: "client_not_found" });

    as(null);
    failure(
      await listClientTimelineAction({ clientId: owner }),
      "unauthenticated",
    );
    const anonymous = await anonClient().rpc("crm_client_timeline", {
      p_business_id: A.id,
      p_client_id: owner,
    });
    expect(anonymous.error?.code).toBe("42501");
    expect(anonymous.data).toBeNull();

    // The note is untouched and only ever read by A's members.
    const { rows } = await db.query(
      "select content from public.client_notes where id = $1",
      [note],
    );
    expect(rows).toEqual([{ content: "Privée" }]);
  });

  it("are dated in the business's time zone: repeated autumn hour, local midnight, another zone", async () => {
    const paris = await customer(A.id, "Paris");
    const first = await arrangeNote(
      A.id,
      paris,
      "02:30 été",
      "2026-10-25T00:30:00Z",
    );
    const second = await arrangeNote(
      A.id,
      paris,
      "02:30 hiver",
      "2026-10-25T01:30:00Z",
    );
    const midnight = await arrangeNote(
      A.id,
      paris,
      "Minuit",
      "2026-03-28T23:00:00Z",
    );
    as(ownerA);
    const page = ok(await listClientTimelineAction({ clientId: paris }));
    expect(page.timezone).toBe("Europe/Paris");
    expect(
      notes(page.events).map((event) => [event.note.id, event.occurredAt]),
    ).toEqual([
      [
        second,
        {
          at: "2026-10-25T01:30:00.000Z",
          local: "2026-10-25T02:30",
          occurrence: "second",
        },
      ],
      [
        first,
        {
          at: "2026-10-25T00:30:00.000Z",
          local: "2026-10-25T02:30",
          occurrence: "first",
        },
      ],
      [
        midnight,
        {
          at: "2026-03-28T23:00:00.000Z",
          local: "2026-03-29T00:00",
          occurrence: null,
        },
      ],
    ]);
    // Profile and timeline read the same zone.
    expect(ok(await getClientProfileAction({ clientId: paris })).timezone).toBe(
      page.timezone,
    );

    // Vancouver: the same kind of instant, its own wall clock and repeated hour.
    const vancouver = await customer(B.id, "Vancouver");
    const pdt = await arrangeNote(
      B.id,
      vancouver,
      "01:30 PDT",
      "2026-11-01T08:30:00Z",
    );
    const pst = await arrangeNote(
      B.id,
      vancouver,
      "01:30 PST",
      "2026-11-01T09:30:00Z",
    );
    const sameInstant = await arrangeNote(
      B.id,
      vancouver,
      "Minuit à Paris",
      "2026-03-28T23:00:00Z",
    );
    as(ownerB);
    const other = ok(await listClientTimelineAction({ clientId: vancouver }));
    expect(other.timezone).toBe("America/Vancouver");
    expect(
      Object.fromEntries(
        notes(other.events).map((event) => [
          event.note.id,
          event.occurredAt.local,
        ]),
      ),
    ).toEqual({
      [pst]: "2026-11-01T01:30",
      [pdt]: "2026-11-01T01:30",
      [sameInstant]: "2026-03-28T16:00",
    });
    expect(
      notes(other.events).map((event) => event.occurredAt.occurrence),
    ).toEqual(["second", "first", null]);
  });
});
