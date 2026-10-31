import { beforeAll, describe, expect, it } from "vitest";

import {
  ExportRefused,
  exportProConfig,
} from "@/features/pro-config/transfer/export";
import { openProConfig } from "@/features/pro-config/transfer/format";
import {
  applyToSnapshot,
  planImport,
  planIsEmpty,
} from "@/features/pro-config/transfer/plan";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The export of one professional's configuration (docs/PRO_CONFIG_TRANSFER.md)
// against the local database only: what it reads, what it leaves out, and a
// dry run into a second local business standing for her production one.
// Nothing is written by the export.

let izabela: Professional;
let other: Professional;
let staging: TestBusiness;
let production: TestBusiness;
let lashes: string;
let testService: string;

const consent = {
  reference: "PILOTE-TEST",
  grantedAt: "2026-10-30T09:00:00.000Z",
};

async function snapshot() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(b::text, '|') from public.businesses b where b.id = $1),
       (select string_agg(s::text, '|' order by s.id) from public.services s where s.business_id = $1),
       (select string_agg(p::text, '|') from public.member_preferences p where p.business_id = $1)
     )) as hash`,
    [staging.id],
  );
  return rows[0].hash as string;
}

async function exportOf(
  businessId: string,
  userId: string,
  environment: string,
  excludeServiceIds: string[] = [],
) {
  const connection = await db.connect();
  try {
    return await exportProConfig(connection, {
      environment,
      businessId,
      userId,
      consent,
      excludeServiceIds,
    });
  } finally {
    connection.release();
  }
}

beforeAll(async () => {
  [izabela, other] = await Promise.all([
    createProfessional("izabela"),
    createProfessional("other"),
  ]);
  staging = await createBusiness(izabela.userId, { name: "Studio Izabela" });
  production = await createBusiness(izabela.userId, { name: "Izabela (prod)" });
  lashes = await createService(staging.id, {
    name: "Pose cil à cil",
    priceCents: 9000,
  });
  testService = await createService(staging.id, {
    name: "TEST ne pas réserver",
  });
  await setWeeklyHours(staging.id, [
    [2, "09:00", "12:30"],
    [2, "14:00", "19:00"],
  ]);
  await izabela.client.rpc("save_member_preferences", {
    p_business_id: staging.id,
    p_expected_version: 0,
    p_changes: { style: "ecrin", accent: "#2F6F5E" },
  });
  const fakeClient = await createClientRecord(
    staging.id,
    "fausse@example.test",
  );
  await insertAppointment({
    businessId: staging.id,
    clientId: fakeClient,
    serviceId: lashes,
    startsAt: "2031-03-03T10:00:00Z",
    endsAt: "2031-03-03T11:00:00Z",
  });
});

describe("export of a professional's configuration", () => {
  it("reads only the allowed configuration, sealed; clients and appointments only counted", async () => {
    const before = await snapshot();
    const document = await exportOf(staging.id, izabela.userId, "staging", [
      testService,
    ]);
    expect(await snapshot()).toBe(before);

    expect(openProConfig(JSON.parse(JSON.stringify(document))).ok).toBe(true);
    expect(document.services.map((service) => service.name)).toEqual([
      "Pose cil à cil",
    ]);
    expect(document.excluded).toEqual({
      services: [testService],
      clients: 1,
      appointments: 1,
    });
    expect(document.hours).toEqual([
      { weekday: 2, startsAt: "09:00", endsAt: "12:30" },
      { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
    ]);
    expect(document.memberPreferences?.appearance).toMatchObject({
      style: "ecrin",
      accent: "#2F6F5E",
    });
    const text = JSON.stringify(document);
    expect(text).not.toContain("fausse@example.test");
    expect(text).not.toContain(izabela.email);
  });

  it("is refused for someone who is not the business's owner", async () => {
    await expect(
      exportOf(staging.id, other.userId, "staging"),
    ).rejects.toBeInstanceOf(ExportRefused);
  });

  it("dry run into her other business: planned, applied on the snapshot, then nothing left", async () => {
    const source = await exportOf(staging.id, izabela.userId, "staging", [
      testService,
    ]);
    const destination = await exportOf(
      production.id,
      izabela.userId,
      "production",
    );
    const plan = planImport(source, destination, {});
    expect(plan.refusals).toEqual([]);
    expect(plan.services).toHaveLength(1);
    expect(plan.memberPreferences.action).toBe("set");
    const applied = applyToSnapshot(destination, {}, plan, () =>
      crypto.randomUUID(),
    );
    expect(
      planIsEmpty(planImport(source, applied.destination, applied.links)),
    ).toBe(true);
  });
});
