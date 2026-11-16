import { createHash, randomBytes, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postSubmission } from "@/app/api/client-hub/businesses/[businessId]/forms/[assignmentId]/submission/route";
import type {
  ClientFormDto,
  FormReceiptDto,
  FormTemplateDto,
  ProFormAssignmentDto,
  VisitFormsDto,
} from "@/features/client-forms/types";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  env,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// Client forms (docs/CLIENT_FORMS_CONTRACT.md) through PostgREST: the owner
// with her real session, the client through her Hub session token (service
// role, as the routes call it), and another business that knows every UUID.

type Rpc = { data: unknown; error: { message: string; hint?: string } | null };

async function call(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const { data, error } = await (
    client.rpc as unknown as (f: string, a: object) => Promise<Rpc>
  )(fn, args);
  return { data, error };
}

async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

async function refusal(promise: Promise<Rpc>): Promise<string | undefined> {
  return (await promise).error?.message;
}

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

type Shop = { owner: Professional; business: TestBusiness; service: string };

async function newShop(label: string): Promise<Shop> {
  const owner = await createProfessional(label);
  const business = await createBusiness(owner.userId, {
    name: `Studio ${label}`,
  });
  const service = await createService(business.id, { name: "Pose" });
  return { owner, business, service };
}

// Each visit on its own slot: the schedule never accepts two at once.
let slot = 24;
const nextSlot = () => (slot += 2);

async function visit(shop: Shop, clientId: string, hours = nextSlot()) {
  const startsAt = hoursFromNow(hours);
  return insertAppointment({
    businessId: shop.business.id,
    clientId,
    serviceId: shop.service,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
  });
}

/** Her Hub session for `email` (as client_hub_verify_code would create it). */
async function hubSession(email: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const { rows } = await db.query<{ id: string }>(
    `insert into private.client_hub_accounts (email) values ($1)
     on conflict (email) do update set last_login_at = now() returning id`,
    [email],
  );
  await db.query(
    `insert into private.client_hub_sessions (account_id, token_hash, created_at, expires_at, last_seen_at)
     values ($1, $2, now(), now() + interval '1 day', now())`,
    [rows[0]!.id, createHash("sha256").update(token).digest("hex")],
  );
  return token;
}

async function grantHub(shop: Shop, clientId: string, email: string) {
  await db.query(
    `insert into public.client_hub_access (business_id, client_id, email, granted_by)
     values ($1, $2, $3, $4)
     on conflict (business_id, client_id) do update
       set email = excluded.email, revoked_at = null, revoked_by = null`,
    [shop.business.id, clientId, email, shop.owner.userId],
  );
}

const fields = [
  { id: "q1", type: "boolean", label: "Allergies connues ?", required: true },
  {
    id: "q2",
    type: "short_text",
    label: "Lesquelles ?",
    required: true,
    showIf: { field: "q1", equals: true },
  },
  {
    id: "q3",
    type: "single_choice",
    label: "Première visite ?",
    required: false,
    options: [
      { id: "yes", label: "Oui" },
      { id: "no", label: "Non" },
    ],
  },
  {
    id: "q4",
    type: "attestation",
    label: "Exactitude",
    required: true,
    attestationText: "J'atteste que ces informations sont exactes.",
  },
];

const draft = (
  review: "none" | "professional" = "none",
  title = "Avant la pose",
) => ({
  title,
  intro: "Deux minutes avant votre rendez-vous.",
  review,
  frequency: { kind: "every_appointment" },
  fields,
});

/** A published template; its latest version id. */
async function publishedVersion(
  shop: Shop,
  review: "none" | "professional" = "none",
) {
  const created = await ok<FormTemplateDto>(
    call(shop.owner.client, "create_form_template", {
      p_business_id: shop.business.id,
      p_request_id: randomUUID(),
      p_draft: draft(review, `Formulaire ${review}`),
    }),
  );
  const published = await ok<FormTemplateDto>(
    call(shop.owner.client, "publish_form_template", {
      p_business_id: shop.business.id,
      p_template_id: created.templateId,
      p_expected_draft_version: created.draftVersion,
      p_request_id: randomUUID(),
    }),
  );
  return { template: published, versionId: published.published[0]!.versionId };
}

const assign = (
  shop: Shop,
  appointmentId: string,
  versionId: string,
  requestId = randomUUID(),
) =>
  call(shop.owner.client, "assign_visit_form", {
    p_business_id: shop.business.id,
    p_appointment_id: appointmentId,
    p_template_version_id: versionId,
    p_request_id: requestId,
  });

const submit = (
  token: string,
  shop: Shop,
  assignmentId: string,
  versionId: string,
  answers: unknown[],
  requestId = randomUUID(),
) =>
  call(bookingClient(), "client_hub_submit_form", {
    p_session_token: token,
    p_business_id: shop.business.id,
    p_assignment_id: assignmentId,
    p_template_version_id: versionId,
    p_request_id: requestId,
    p_answers: answers,
  });

const attest = {
  fieldId: "q4",
  value: true,
  attestedText: "J'atteste que ces informations sont exactes.",
};

/** One client of `shop` with Hub access, a visit, and a form sent for it. */
async function sentForm(shop: Shop, review: "none" | "professional" = "none") {
  const email = `cliente-${randomUUID().slice(0, 8)}@client.test`;
  const clientId = await createClientRecord(shop.business.id, email, "Léa");
  const appointmentId = await visit(shop, clientId);
  await grantHub(shop, clientId, email);
  const token = await hubSession(email);
  const { versionId } = await publishedVersion(shop, review);
  const assignment = await ok<ProFormAssignmentDto>(
    assign(shop, appointmentId, versionId),
  );
  return { email, clientId, appointmentId, token, versionId, assignment };
}

let shop: Shop;
let other: Shop;

beforeAll(async () => {
  shop = await newShop("forms");
  other = await newShop("forms-other");
});

describe("templates", () => {
  it("refuses a template the screen would refuse", async () => {
    const invalid = [
      { ...draft(), title: "  " },
      {
        ...draft(),
        fields: [
          {
            id: "a",
            type: "short_text",
            label: "A",
            required: false,
            showIf: { field: "b", equals: true },
          },
          { id: "b", type: "boolean", label: "B", required: false },
        ],
      },
      {
        ...draft(),
        fields: [
          {
            id: "a",
            type: "single_choice",
            label: "A",
            required: false,
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "x" },
            ],
          },
        ],
      },
      {
        ...draft(),
        fields: [{ id: "a", type: "attestation", label: "A", required: true }],
      },
      {
        ...draft(),
        fields: [
          {
            id: "a",
            type: "single_choice",
            label: "A",
            required: false,
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" },
            ],
          },
          {
            id: "b",
            type: "short_text",
            label: "B",
            required: false,
            showIf: { field: "a", equals: "z" },
          },
        ],
      },
      {
        ...draft(),
        frequency: { kind: "reuse_completed_for_days", days: 400 },
      },
    ];
    for (const value of invalid) {
      expect(
        await refusal(
          call(shop.owner.client, "create_form_template", {
            p_business_id: shop.business.id,
            p_request_id: randomUUID(),
            p_draft: value,
          }),
        ),
      ).toBe("invalid_template");
    }
  });

  it("saves a draft once per requestId, refuses a stale draft, publishes an immutable version", async () => {
    const created = await ok<FormTemplateDto>(
      call(shop.owner.client, "create_form_template", {
        p_business_id: shop.business.id,
        p_request_id: randomUUID(),
        p_draft: draft(),
      }),
    );
    expect(created).toMatchObject({
      status: "draft",
      draftVersion: 1,
      published: [],
    });

    const save = {
      p_business_id: shop.business.id,
      p_template_id: created.templateId,
      p_expected_draft_version: 1,
      p_request_id: randomUUID(),
      p_draft: { ...draft(), title: "Avant le soin" },
    };
    const saved = await ok<FormTemplateDto>(
      call(shop.owner.client, "save_form_draft", save),
    );
    expect(saved).toMatchObject({
      draftVersion: 2,
      draft: { title: "Avant le soin" },
    });
    expect(await ok(call(shop.owner.client, "save_form_draft", save))).toEqual(
      saved,
    );
    expect(
      await refusal(
        call(shop.owner.client, "save_form_draft", {
          ...save,
          p_draft: draft(),
        }),
      ),
    ).toBe("idempotency_conflict");
    expect(
      await refusal(
        call(shop.owner.client, "save_form_draft", {
          ...save,
          p_request_id: randomUUID(),
        }),
      ),
    ).toBe("version_conflict");

    const published = await ok<FormTemplateDto>(
      call(shop.owner.client, "publish_form_template", {
        p_business_id: shop.business.id,
        p_template_id: created.templateId,
        p_expected_draft_version: 2,
        p_request_id: randomUUID(),
      }),
    );
    expect(published).toMatchObject({ status: "active", draftVersion: 3 });
    expect(published.published).toHaveLength(1);
    await expect(
      db.query(
        "update private.form_versions set number = 9 where template_id = $1",
        [created.templateId],
      ),
    ).rejects.toThrow(/form_submission_immutable/);
  });

  it("answers another business as if nothing existed", async () => {
    const { template } = await publishedVersion(shop);
    expect(
      await refusal(
        call(other.owner.client, "read_form_template", {
          p_business_id: shop.business.id,
          p_template_id: template.templateId,
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        call(other.owner.client, "read_form_template", {
          p_business_id: other.business.id,
          p_template_id: template.templateId,
        }),
      ),
    ).toBe("not_found");
  });
});

describe("the forms of a visit", () => {
  it("sends a form once per visit, never for a past or another business's visit", async () => {
    const clientId = await createClientRecord(
      shop.business.id,
      `v-${randomUUID().slice(0, 8)}@client.test`,
    );
    const appointmentId = await visit(shop, clientId);
    const { versionId } = await publishedVersion(shop);
    const requestId = randomUUID();
    const first = await ok<ProFormAssignmentDto>(
      assign(shop, appointmentId, versionId, requestId),
    );
    expect(first).toMatchObject({
      status: "assigned",
      version: 1,
      submission: null,
    });
    expect(await ok(assign(shop, appointmentId, versionId, requestId))).toEqual(
      first,
    );
    expect(await refusal(assign(shop, appointmentId, versionId))).toBe(
      "form_already_assigned",
    );

    const past = await visit(shop, clientId, -2);
    expect(await refusal(assign(shop, past, versionId))).toBe(
      "appointment_not_editable",
    );

    const theirs = await publishedVersion(other);
    expect(await refusal(assign(shop, appointmentId, theirs.versionId))).toBe(
      "not_found",
    );

    const read = await ok<VisitFormsDto>(
      call(shop.owner.client, "read_visit_forms", {
        p_business_id: shop.business.id,
        p_appointment_id: appointmentId,
      }),
    );
    expect(read.clientName).toBe("Cliente");
    expect(read.assignments).toHaveLength(1);
    expect(read.templates.map((t) => t.templateVersionId)).toContain(versionId);
  });

  it("withdraws only a form she has not answered", async () => {
    const sent = await sentForm(shop);
    const revoked = await ok<ProFormAssignmentDto>(
      call(shop.owner.client, "revoke_visit_form", {
        p_business_id: shop.business.id,
        p_assignment_id: sent.assignment.assignmentId,
        p_expected_version: 1,
        p_request_id: randomUUID(),
      }),
    );
    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
    expect(
      await refusal(
        submit(sent.token, shop, sent.assignment.assignmentId, sent.versionId, [
          { fieldId: "q1", value: false },
          attest,
        ]),
      ),
    ).toBe("form_revoked");

    const answered = await sentForm(shop);
    await ok(
      submit(
        answered.token,
        shop,
        answered.assignment.assignmentId,
        answered.versionId,
        [{ fieldId: "q1", value: false }, attest],
      ),
    );
    expect(
      await refusal(
        call(shop.owner.client, "revoke_visit_form", {
          p_business_id: shop.business.id,
          p_assignment_id: answered.assignment.assignmentId,
          p_expected_version: 2,
          p_request_id: randomUUID(),
        }),
      ),
    ).toBe("form_already_submitted");
  });
});

describe("her answers", () => {
  it("is readable only through her own active Hub access", async () => {
    const sent = await sentForm(shop);
    const read = (token: string, business = shop) =>
      call(bookingClient(), "client_hub_form", {
        p_session_token: token,
        p_business_id: business.business.id,
        p_assignment_id: sent.assignment.assignmentId,
      });
    const form = await ok<ClientFormDto>(read(sent.token));
    expect(form).toMatchObject({
      appointmentId: sent.appointmentId,
      status: "assigned",
      canSubmit: true,
      receipt: null,
      businessName: "Studio forms",
    });
    expect(form.fields.map((f) => f.id)).toEqual(["q1", "q2", "q3", "q4"]);

    const stranger = await hubSession(
      `autre-${randomUUID().slice(0, 8)}@client.test`,
    );
    expect(await refusal(read(stranger))).toBe("client_hub_not_found");
    expect(await refusal(read(sent.token, other))).toBe("client_hub_not_found");

    await db.query(
      "update public.client_hub_access set revoked_at = now() where business_id = $1 and client_id = $2",
      [shop.business.id, sent.clientId],
    );
    expect(await refusal(read(sent.token))).toBe("client_hub_not_found");
  });

  it("follows the conditions: q1 false / q2 absent is valid; q1 true / q2 absent names q2", async () => {
    const first = await sentForm(shop);
    const receipt = await ok<FormReceiptDto>(
      submit(
        first.token,
        shop,
        first.assignment.assignmentId,
        first.versionId,
        [{ fieldId: "q1", value: false }, attest],
      ),
    );
    expect(receipt.status).toBe("completed");

    const second = await sentForm(shop);
    const missing = await submit(
      second.token,
      shop,
      second.assignment.assignmentId,
      second.versionId,
      [{ fieldId: "q1", value: true }, attest],
    );
    expect(missing.error).toMatchObject({
      message: "field_required",
      hint: "q2",
    });

    expect(
      await refusal(
        submit(
          second.token,
          shop,
          second.assignment.assignmentId,
          second.versionId,
          [
            { fieldId: "q1", value: false },
            { fieldId: "q2", value: "pollen" },
            attest,
          ],
        ),
      ),
    ).toBe("invalid_input");
    expect(
      await refusal(
        submit(
          second.token,
          shop,
          second.assignment.assignmentId,
          second.versionId,
          [
            { fieldId: "q1", value: false },
            { ...attest, attestedText: "Un autre texte" },
          ],
        ),
      ),
    ).toBe("stale_form");
    expect(
      await refusal(
        submit(
          second.token,
          shop,
          second.assignment.assignmentId,
          randomUUID(),
          [{ fieldId: "q1", value: false }, attest],
        ),
      ),
    ).toBe("stale_form");
  });

  it("gives one receipt per requestId and refuses the same key with other answers", async () => {
    const sent = await sentForm(shop);
    const requestId = randomUUID();
    const answers = [
      { fieldId: "q1", value: false },
      { fieldId: "q3", value: "yes" },
      attest,
    ];
    const [a, b] = await Promise.all([
      ok<FormReceiptDto>(
        submit(
          sent.token,
          shop,
          sent.assignment.assignmentId,
          sent.versionId,
          answers,
          requestId,
        ),
      ),
      ok<FormReceiptDto>(
        submit(
          sent.token,
          shop,
          sent.assignment.assignmentId,
          sent.versionId,
          answers,
          requestId,
        ),
      ),
    ]);
    expect(a).toEqual(b);
    expect(
      await refusal(
        submit(
          sent.token,
          shop,
          sent.assignment.assignmentId,
          sent.versionId,
          [{ fieldId: "q1", value: false }, attest],
          requestId,
        ),
      ),
    ).toBe("idempotency_conflict");
    const { rows } = await db.query(
      "select answers from private.form_submissions where assignment_id = $1",
      [sent.assignment.assignmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].answers).toEqual([
      { fieldId: "q1", value: false },
      { fieldId: "q3", value: "yes" },
      expect.objectContaining({
        fieldId: "q4",
        value: true,
        attestedText: attest.attestedText,
      }),
    ]);
  });

  it("waits for a revocation in flight, then finds nothing to answer", async () => {
    const sent = await sentForm(shop);
    const revocation = await openTransaction();
    await revocation.connection.query(
      "update public.client_hub_access set revoked_at = now() where business_id = $1 and client_id = $2",
      [shop.business.id, sent.clientId],
    );
    const pending = outcome(
      db.query(
        "select public.client_hub_submit_form($1, $2, $3, $4, $5, $6::jsonb)",
        [
          sent.token,
          shop.business.id,
          sent.assignment.assignmentId,
          sent.versionId,
          randomUUID(),
          JSON.stringify([{ fieldId: "q1", value: false }, attest]),
        ],
      ),
    );
    // The submission's backend, once it has started.
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
      const { rows } = await db.query<{ pid: number }>(
        "select pid from pg_stat_activity where query like 'select public.client_hub_submit_form%' and pid <> pg_backend_pid()",
      );
      pid = rows[0]?.pid;
      if (pid === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    await waitUntilBlocked(pid!);
    await closeTransaction(revocation, "commit");
    expect(await pending).toBe("client_hub_not_found");
  });

  it("is no longer asked when the visit is cancelled", async () => {
    const sent = await sentForm(shop);
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [sent.appointmentId],
    );
    const form = await ok<ClientFormDto>(
      call(bookingClient(), "client_hub_form", {
        p_session_token: sent.token,
        p_business_id: shop.business.id,
        p_assignment_id: sent.assignment.assignmentId,
      }),
    );
    expect(form).toMatchObject({ status: "revoked", canSubmit: false });
  });

  it("waits for the professional's review when the template asks for it", async () => {
    const sent = await sentForm(shop, "professional");
    const receipt = await ok<FormReceiptDto>(
      submit(sent.token, shop, sent.assignment.assignmentId, sent.versionId, [
        { fieldId: "q1", value: false },
        attest,
      ]),
    );
    expect(receipt.status).toBe("submitted");
    const review = {
      p_business_id: shop.business.id,
      p_assignment_id: sent.assignment.assignmentId,
      p_expected_version: 2,
      p_request_id: randomUUID(),
    };
    const reviewed = await ok<ProFormAssignmentDto>(
      call(shop.owner.client, "review_visit_form", review),
    );
    expect(reviewed).toMatchObject({ status: "completed", version: 3 });
    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.submission?.answers[0]).toEqual({
      fieldId: "q1",
      value: false,
    });
    expect(
      await refusal(
        call(shop.owner.client, "review_visit_form", {
          ...review,
          p_request_id: randomUUID(),
        }),
      ),
    ).toBe("version_conflict");
  });
});

describe("the submission route", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  });

  const post = (
    sent: Awaited<ReturnType<typeof sentForm>>,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    postSubmission(
      new NextRequest(
        new URL(
          `/api/client-hub/businesses/${shop.business.id}/forms/${sent.assignment.assignmentId}/submission`,
          "http://localhost:3000",
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `client_hub_session=${sent.token}`,
            ...headers,
          },
          body: JSON.stringify(body),
        },
      ),
      {
        params: Promise.resolve({
          businessId: shop.business.id,
          assignmentId: sent.assignment.assignmentId,
        }),
      },
    );

  it("names the missing question, refuses another origin, then records the answers", async () => {
    const sent = await sentForm(shop);
    const missing = await post(sent, {
      templateVersionId: sent.versionId,
      requestId: randomUUID(),
      answers: [{ fieldId: "q1", value: true }, attest],
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({
      error: { code: "field_required", fieldErrors: { q2: expect.any(Array) } },
    });

    const crossSite = await post(
      sent,
      {
        templateVersionId: sent.versionId,
        requestId: randomUUID(),
        answers: [],
      },
      { origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);

    const done = await post(sent, {
      templateVersionId: sent.versionId,
      requestId: randomUUID(),
      answers: [{ fieldId: "q1", value: false }, attest],
    });
    expect(done.status).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(await done.json()).toMatchObject({ data: { status: "completed" } });
  });
});
