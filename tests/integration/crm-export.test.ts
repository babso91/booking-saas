import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GET as download } from "@/app/api/crm-export/[jobId]/route";
import {
  downloadCrmExportAction,
  listCrmExportsAction,
  requestCrmExportAction,
  revokeCrmExportAction,
} from "@/features/crm/export/actions";
import type { ExportJobDto } from "@/features/crm/export/model";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Points 146 and 182 (Higani backlog): she takes her client file out, as a
// CSV, through the real Server Actions, the route her browser opens, her
// Supabase session and RLS. The owner only; nothing stored; every download
// checked again and counted; erased records never exported.

let sessionClient: AppSupabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
const as = (professional: Professional | null) => {
  sessionClient = professional ? professional.client : anonClient();
};

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}
const failure = <T>(result: ActionResult<T>, code: AppErrorCode) =>
  expect(result).toMatchObject({ ok: false, error: { code } });

const TZ = "Europe/Paris";
const DAY = 86_400_000;

let owner: Professional;
let admin: Professional;
let otherOwner: Professional;
let business: TestBusiness;
let other: TestBusiness;
let service: string;
const local = async (instant: string) =>
  (
    await db.query<{ at: string }>(
      "select to_char($1::timestamptz at time zone $2, 'YYYY-MM-DD HH24:MI') as at",
      [instant, TZ],
    )
  ).rows[0]!.at;
const at = (days: number) => {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(9, 30, 0, 0);
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 45 * 60_000).toISOString(),
  };
};

async function open(jobId: string) {
  const response = await download(
    new NextRequest(`http://localhost:3000/api/crm-export/${jobId}`),
    { params: Promise.resolve({ jobId }) },
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    /** UTF-8 with its byte order mark, for French spreadsheets. */
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    // Decoded as a browser would: the mark itself is not text.
    text: new TextDecoder().decode(bytes),
  };
}
const lines = (csv: string) => csv.split("\r\n");
const request = (scope: ExportJobDto["scope"], requestId = randomUUID()) =>
  requestCrmExportAction({ scope, requestId });
const downloads = async (jobId: string) =>
  (
    await db.query<{ download_count: number; last_downloaded_at: Date | null }>(
      "select download_count, last_downloaded_at from public.crm_export_jobs where id = $1",
      [jobId],
    )
  ).rows[0]!;

const past = at(-3);
const cancelled = at(-10);
const upcoming = at(5);

beforeAll(async () => {
  owner = await createProfessional("crm-export");
  admin = await createProfessional("crm-export-admin");
  otherOwner = await createProfessional("crm-export-other");
  business = await createBusiness(owner.userId, { timezone: TZ });
  other = await createBusiness(otherOwner.userId, { timezone: TZ });
  await db.query(
    `insert into public.business_members (business_id, user_id, role)
     values ($1, $2, 'admin')`,
    [business.id, admin.userId],
  );
  service = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 45,
    priceCents: 6550,
  });

  const emma = await createClientRecord(
    business.id,
    "emma@client.test",
    "Emma",
  );
  await db.query(
    "update public.clients set last_name = 'Durand', phone = '06 12 34 56 78' where id = $1",
    [emma],
  );
  await insertAppointment({
    businessId: business.id,
    clientId: emma,
    serviceId: service,
    ...past,
    status: "completed",
  });
  await insertAppointment({
    businessId: business.id,
    clientId: emma,
    serviceId: service,
    ...cancelled,
    status: "cancelled",
  });
  await insertAppointment({
    businessId: business.id,
    clientId: emma,
    serviceId: service,
    ...upcoming,
  });
  // A first name a spreadsheet would run: kept as text in the file.
  const lea = await createClientRecord(business.id, "lea@client.test", "Léa");
  await db.query(
    "update public.clients set first_name = $2, last_name = 'Martin' where id = $1",
    [lea, '=HYPERLINK("http://x","clic")'],
  );
  await createClientRecord(business.id, "zoe@client.test", "Zoé");
  // Erased (point 205): never exported, nor its visit.
  const ines = await createClientRecord(
    business.id,
    "ines@client.test",
    "Inès",
  );
  await insertAppointment({
    businessId: business.id,
    clientId: ines,
    serviceId: service,
    ...at(-20),
    status: "completed",
  });
  await db.query("update public.clients set erased_at = now() where id = $1", [
    ines,
  ]);
  // Another business's record: never seen from hers.
  await createClientRecord(other.id, "nina@client.test", "Nina");
});

describe("points 146 and 182: her client file, taken out", () => {
  it("prepares her records at once, for 24 hours, and answers a replay the same", async () => {
    as(owner);
    const requestId = randomUUID();
    const job = ok(await request("contacts", requestId));
    expect(job).toMatchObject({
      scope: "contacts",
      status: "ready",
      rowCount: 3,
    });
    const hours =
      (Date.parse(job.expiresAt!) - Date.parse(job.requestedAt)) / 3_600_000;
    expect(hours).toBeCloseTo(24, 5);

    expect(ok(await request("contacts", requestId))).toEqual(job);
    failure(
      await request("contacts_and_visits", requestId),
      "idempotency_conflict",
    );
    expect(ok(await listCrmExportsAction())[0]).toEqual(job);
  });

  it("downloads her records as a CSV, formulas kept as text, erased ones left out", async () => {
    as(owner);
    const job = ok(await request("contacts"));
    expect(ok(await downloadCrmExportAction(job.jobId))).toEqual({
      url: `/api/crm-export/${job.jobId}`,
    });
    const file = await open(job.jobId);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(file.headers.get("cache-control")).toBe("no-store");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
      new Date(),
    );
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="clientes-${business.slug}-${today}.csv"`,
    );
    expect(file.bom).toBe(true);
    expect(lines(file.text)).toEqual([
      "Prénom;Nom;E-mail;Téléphone;Fiche créée le;Visites passées;Dernière visite;Prochain rendez-vous",
      `Emma;Durand;emma@client.test;06 12 34 56 78;${today};1;${await local(past.startsAt)};${await local(upcoming.startsAt)}`,
      `"'=HYPERLINK(""http://x"",""clic"")";Martin;lea@client.test;;${today};0;;`,
      `Zoé;;zoe@client.test;;${today};0;;`,
      "",
    ]);
    expect(file.text).not.toContain("Inès");
    expect(file.text).not.toContain("Nina");
    const counted = await downloads(job.jobId);
    expect(counted.download_count).toBe(1);
    expect(counted.last_downloaded_at).not.toBeNull();
  });

  it("downloads one line per visit, a record without a visit keeping its line", async () => {
    as(owner);
    const job = ok(await request("contacts_and_visits"));
    expect(job.rowCount).toBe(5);
    const file = await open(job.jobId);
    expect(file.status).toBe(200);
    expect(lines(file.text)).toEqual([
      "Prénom;Nom;E-mail;Téléphone;Rendez-vous;Prestation;Durée (min);Prix (EUR);Statut",
      `Emma;Durand;emma@client.test;06 12 34 56 78;${await local(cancelled.startsAt)};Coupe;45;65,50;Annulé`,
      `Emma;Durand;emma@client.test;06 12 34 56 78;${await local(past.startsAt)};Coupe;45;65,50;Terminé`,
      `Emma;Durand;emma@client.test;06 12 34 56 78;${await local(upcoming.startsAt)};Coupe;45;65,50;À venir`,
      `"'=HYPERLINK(""http://x"",""clic"")";Martin;lea@client.test;;;;;;`,
      "Zoé;;zoe@client.test;;;;;;",
      "",
    ]);
  });

  it("is hers alone: not an admin, not another owner, not a stranger", async () => {
    as(owner);
    const job = ok(await request("contacts"));

    as(admin);
    failure(await request("contacts"), "permission_denied");
    failure(await listCrmExportsAction(), "permission_denied");
    failure(await downloadCrmExportAction(job.jobId), "permission_denied");
    failure(await revokeCrmExportAction(job.jobId), "permission_denied");
    expect((await open(job.jobId)).status).toBe(403);

    as(otherOwner);
    // Her own business answers: that export is not one of its own.
    failure(await downloadCrmExportAction(job.jobId), "export_expired");
    expect((await open(job.jobId)).status).toBe(404);
    expect(ok(await listCrmExportsAction())).toEqual([]);

    as(null);
    expect((await open(job.jobId)).status).toBe(401);
    expect((await downloads(job.jobId)).download_count).toBe(0);
  });

  it("withdrawn at once, or expired after 24 hours: nothing more to download", async () => {
    as(owner);
    const withdrawn = ok(await request("contacts"));
    const revoked = ok(await revokeCrmExportAction(withdrawn.jobId));
    expect(revoked).toMatchObject({ status: "revoked", expiresAt: null });
    expect(ok(await revokeCrmExportAction(withdrawn.jobId))).toEqual(revoked);
    failure(await downloadCrmExportAction(withdrawn.jobId), "export_expired");
    const refused = await open(withdrawn.jobId);
    expect(refused.status).toBe(410);
    expect(refused.text).not.toContain("Emma");

    const old = ok(await request("contacts"));
    await db.query(
      "update public.crm_export_jobs set expires_at = now() - interval '1 second' where id = $1",
      [old.jobId],
    );
    const listed = ok(await listCrmExportsAction()).find(
      (job) => job.jobId === old.jobId,
    );
    expect(listed?.status).toBe("expired");
    failure(await downloadCrmExportAction(old.jobId), "export_expired");
    expect((await open(old.jobId)).status).toBe(410);
    expect((await downloads(old.jobId)).download_count).toBe(0);

    failure(await revokeCrmExportAction(randomUUID()), "not_found");
    expect((await open("not-a-uuid")).status).toBe(404);
  });

  it("the table answers only through her session: no direct read for an admin", async () => {
    const { data, error } = await admin.client
      .from("crm_export_jobs")
      .select("id")
      .eq("business_id", business.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const forged = await admin.client.from("crm_export_jobs").insert({
      business_id: business.id,
      request_id: randomUUID(),
      scope: "contacts",
      expires_at: new Date(Date.now() + DAY).toISOString(),
    });
    expect(forged.error).not.toBeNull();
  });
});
