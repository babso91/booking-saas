import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  openProConfig,
  sealProConfig,
  type ProConfigDocument,
  type ProConfigPayload,
} from "./format";
import { applyToSnapshot, planImport, planIsEmpty } from "./plan";

const ids = {
  stagingBusiness: "11111111-1111-4111-8111-111111111111",
  stagingUser: "22222222-2222-4222-8222-222222222222",
  prodBusiness: "33333333-3333-4333-8333-333333333333",
  prodUser: "44444444-4444-4444-8444-444444444444",
  cils: "55555555-5555-4555-8555-555555555555",
  rehaussement: "66666666-6666-4666-8666-666666666666",
  test: "77777777-7777-4777-8777-777777777777",
};

function payload(patch: Partial<ProConfigPayload> = {}): ProConfigPayload {
  return {
    format: "booking.professional-config",
    formatVersion: 1,
    exportedAt: "2026-10-31T10:00:00.000Z",
    source: {
      environment: "staging",
      businessId: ids.stagingBusiness,
      userId: ids.stagingUser,
    },
    consent: {
      reference: "PILOTE-2026-001",
      grantedAt: "2026-10-30T09:00:00.000Z",
    },
    business: {
      name: "Studio Izabela",
      slug: "studio-izabela",
      description: "Extensions de cils",
      phone: "+33 6 12 34 56 78",
      location: "Lyon",
      timezone: "Europe/Paris",
      cancellationPolicy: null,
    },
    settings: {
      currency: "EUR",
      slotIntervalMinutes: 15,
      bufferMinutes: 10,
      minimumBookingNoticeMinutes: 120,
      maximumBookingAdvanceDays: 90,
      reactivationAfterDays: 60,
      automaticReactivationEnabled: false,
    },
    services: [
      {
        sourceId: ids.cils,
        name: "Pose cil à cil",
        description: null,
        durationMinutes: 120,
        priceCents: 9000,
        active: true,
        displayOrder: 0,
      },
      {
        sourceId: ids.rehaussement,
        name: "Réhaussement",
        description: "Avec teinture",
        durationMinutes: 60,
        priceCents: 5500,
        active: true,
        displayOrder: 1,
      },
    ],
    hours: [
      { weekday: 2, startsAt: "09:00", endsAt: "12:30" },
      { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
    ],
    memberPreferences: {
      appearance: {
        style: "ecrin",
        ambiance: "atelier",
        mode: "dark",
        accent: "#2F6F5E",
        motion: "discrete",
      },
    },
    assets: [],
    excluded: { services: [ids.test], clients: 14, appointments: 52 },
    ...patch,
  };
}

/** Her new business in production, as onboarding left it. */
function freshProduction(): ProConfigDocument {
  return sealProConfig(
    payload({
      source: {
        environment: "production",
        businessId: ids.prodBusiness,
        userId: ids.prodUser,
      },
      consent: { reference: "dry-run", grantedAt: "2026-10-31T10:00:00.000Z" },
      business: { ...payload().business, slug: "izabela-cils", phone: null },
      settings: { ...payload().settings, bufferMinutes: 0 },
      services: [],
      hours: [],
      memberPreferences: null,
      excluded: { services: [], clients: 0, appointments: 0 },
    }),
  );
}

/** A sealed document changed, then sealed again. */
function reseal(
  document: ProConfigDocument,
  patch: Partial<ProConfigPayload>,
): ProConfigDocument {
  const rest: Partial<ProConfigDocument> = { ...document };
  delete rest.checksum;
  return sealProConfig({ ...(rest as ProConfigPayload), ...patch });
}

describe("transfer format", () => {
  it("seals and opens a document; the same data, the same checksum", () => {
    const document = sealProConfig(payload());
    expect(document.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(openProConfig(JSON.parse(JSON.stringify(document)))).toEqual({
      ok: true,
      document,
    });
    const reordered = JSON.parse(
      canonicalJson({ ...document, business: { ...document.business } }),
    );
    expect(openProConfig(reordered).ok).toBe(true);
  });

  it("refuses a document edited after export", () => {
    const document = sealProConfig(payload());
    const edited = {
      ...document,
      services: [{ ...document.services[0]!, priceCents: 1 }],
    };
    expect(openProConfig(edited)).toEqual({
      ok: false,
      reason: "checksum_mismatch",
    });
    expect(openProConfig({ ...document, checksum: undefined })).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["another format", { format: "other" }],
    ["a future version", { formatVersion: 2 }],
    ["clients smuggled in", { clients: [{ email: "x@y.z" }] }],
    ["appointments smuggled in", { appointments: [] }],
    ["calendar tokens smuggled in", { calendar: { refreshToken: "x" } }],
    ["an Auth password smuggled in", { auth: { password: "x" } }],
    ["no consent", { consent: undefined }],
    [
      "an asset marked transferred",
      { assets: [{ kind: "logo", path: "a", transferred: true }] },
    ],
    [
      "an unknown style",
      {
        memberPreferences: {
          appearance: {
            ...payload().memberPreferences!.appearance,
            style: "aurore",
          },
        },
      },
    ],
    [
      "overlapping hours",
      {
        hours: [
          { weekday: 1, startsAt: "09:00", endsAt: "12:00" },
          { weekday: 1, startsAt: "11:00", endsAt: "13:00" },
        ],
      },
    ],
    [
      "a service twice",
      { services: [payload().services[0]!, payload().services[0]!] },
    ],
    [
      "a bad environment name",
      { source: { ...payload().source, environment: "Prod; rm" } },
    ],
  ])("refuses %s", (_label, patch) => {
    const raw = { ...payload(), ...patch } as Record<string, unknown>;
    expect(openProConfig({ ...raw, checksum: "sha256:0" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(() => sealProConfig(raw as ProConfigPayload)).toThrow();
  });

  it.each([
    ["09:00–24:00", "09:00", "24:00"],
    ["00:00–24:00 (the whole day)", "00:00", "24:00"],
    ["00:00–23:59", "00:00", "23:59"],
  ])("accepts hours %s", (_label, startsAt, endsAt) => {
    const document = sealProConfig(
      payload({ hours: [{ weekday: 1, startsAt, endsAt }] }),
    );
    expect(openProConfig(JSON.parse(JSON.stringify(document))).ok).toBe(true);
  });

  it.each([
    ["24:00 as a start", "24:00", "24:00"],
    ["24:01 as an end", "09:00", "24:01"],
    ["25:00 as an end", "09:00", "25:00"],
    ["24:30 as an end", "09:00", "24:30"],
    ["an end before its start", "10:00", "09:00"],
    ["an empty range", "10:00", "10:00"],
    ["H:MM", "9:00", "12:00"],
  ])("refuses hours with %s", (_label, startsAt, endsAt) => {
    expect(() =>
      sealProConfig(payload({ hours: [{ weekday: 1, startsAt, endsAt }] })),
    ).toThrow();
  });

  it("refuses a range starting before another one ends at 24:00", () => {
    expect(() =>
      sealProConfig(
        payload({
          hours: [
            { weekday: 5, startsAt: "18:00", endsAt: "24:00" },
            { weekday: 5, startsAt: "23:00", endsAt: "23:30" },
          ],
        }),
      ),
    ).toThrow();
  });

  it("LIMIT (documented): a document changed and given a recomputed checksum opens; the checksum proves no origin", () => {
    const document = sealProConfig(payload());
    const forged = reseal(document, {
      consent: { reference: "INVENTÉ", grantedAt: document.consent.grantedAt },
      services: [{ ...document.services[0]!, priceCents: 1 }],
    });
    expect(openProConfig(JSON.parse(JSON.stringify(forged))).ok).toBe(true);
  });

  it("refuses what is not a document", () => {
    for (const raw of [null, "x", [], 42]) {
      expect(openProConfig(raw)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("import plan (dry run)", () => {
  it("staging → a fresh production business: everything to create, nothing copied by id", () => {
    const source = sealProConfig(payload());
    const plan = planImport(source, freshProduction(), {});
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([
      "slug_differs:studio-izabela→izabela-cils (kept)",
    ]);
    expect(plan.business).toEqual([
      { field: "phone", from: null, to: "+33 6 12 34 56 78" },
    ]);
    expect(plan.settings).toEqual([
      { field: "bufferMinutes", from: 0, to: 10 },
    ]);
    expect(plan.services.map((step) => step.action)).toEqual([
      "create",
      "create",
    ]);
    expect(plan.hours).toMatchObject({ action: "replace", expected: [] });
    expect(plan.memberPreferences).toEqual({
      action: "set",
      appearance: payload().memberPreferences!.appearance,
    });
  });

  it("applied once, planned again: nothing left to do (idempotent); the test service never travels", () => {
    const source = sealProConfig(payload());
    const plan = planImport(source, freshProduction(), {});
    const applied = applyToSnapshot(freshProduction(), {}, plan, (sourceId) =>
      sourceId.replace(/^./, "9"),
    );
    expect(Object.keys(applied.links).sort()).toEqual(
      [ids.cils, ids.rehaussement].sort(),
    );
    expect(Object.values(applied.links)).not.toContain(ids.cils);
    expect(Object.keys(applied.links)).not.toContain(ids.test);

    const again = planImport(source, applied.destination, applied.links);
    expect(planIsEmpty(again)).toBe(true);
  });

  it("the simulated destination is a valid sealed document: it opens, and its plan is empty", () => {
    const source = sealProConfig(
      payload({
        hours: [
          { weekday: 5, startsAt: "09:00", endsAt: "12:00" },
          { weekday: 5, startsAt: "18:00", endsAt: "24:00" },
          { weekday: 6, startsAt: "00:00", endsAt: "24:00" },
        ],
      }),
    );
    const plan = planImport(source, freshProduction(), {});
    const applied = applyToSnapshot(freshProduction(), {}, plan, (sourceId) =>
      sourceId.replace(/^./, "9"),
    );
    const opened = openProConfig(
      JSON.parse(JSON.stringify(applied.destination)),
    );
    expect(opened.ok).toBe(true);
    expect(applied.destination.hours).toEqual(source.hours);
    const again = planImport(
      source,
      (opened as { document: ProConfigDocument }).document,
      applied.links,
    );
    expect(planIsEmpty(again)).toBe(true);
    // Only the destination's own: its environment, business and member.
    expect(applied.destination.source).toEqual(freshProduction().source);
  });

  it("a later export with a changed price updates the linked service, and creates only the new one", () => {
    const first = sealProConfig(payload());
    const applied = applyToSnapshot(
      freshProduction(),
      {},
      planImport(first, freshProduction(), {}),
      (sourceId) => sourceId.replace(/^./, "9"),
    );
    const newer = sealProConfig(
      payload({
        services: [
          { ...payload().services[0]!, priceCents: 9500 },
          payload().services[1]!,
          { ...payload().services[1]!, sourceId: ids.test, name: "Brow lift" },
        ],
      }),
    );
    const plan = planImport(newer, applied.destination, applied.links);
    expect(plan.services).toEqual([
      {
        action: "update",
        sourceId: ids.cils,
        targetId: applied.links[ids.cils],
        changes: [{ field: "priceCents", from: 9000, to: 9500 }],
      },
      {
        action: "unchanged",
        sourceId: ids.rehaussement,
        targetId: applied.links[ids.rehaussement],
      },
      expect.objectContaining({ action: "create" }),
    ]);
  });

  it("her own choice in production wins over the staging one", () => {
    const production = reseal(freshProduction(), {
      memberPreferences: {
        appearance: {
          ...payload().memberPreferences!.appearance,
          style: "studio",
        },
      },
    });
    const plan = planImport(sealProConfig(payload()), production, {});
    expect(plan.memberPreferences).toEqual({ action: "keep_destination" });
  });

  it("services she created herself in production are left alone", () => {
    const own = {
      ...payload().services[0]!,
      sourceId: "88888888-8888-4888-8888-888888888888",
      name: "Sa prestation",
    };
    const production = reseal(freshProduction(), { services: [own] });
    const plan = planImport(sealProConfig(payload()), production, {});
    expect(plan.untouchedServices).toEqual([own.sourceId]);
    expect(plan.services.every((step) => step.action === "create")).toBe(true);
  });

  it.each([
    [
      "the same environment",
      () => reseal(freshProduction(), { source: { ...payload().source } }),
      {},
      "same_environment",
    ],
    [
      "another currency",
      () =>
        reseal(freshProduction(), {
          settings: { ...payload().settings, currency: "CHF" },
        }),
      {},
      "currency_mismatch",
    ],
    [
      "a link to a service that is gone",
      () => freshProduction(),
      { [ids.cils]: "99999999-9999-4999-8999-999999999999" },
      "link_target_missing:99999999-9999-4999-8999-999999999999",
    ],
  ])("refuses to plan into %s", (_label, destination, links, refusal) => {
    const plan = planImport(sealProConfig(payload()), destination(), links);
    expect(plan.refusals).toContain(refusal);
    expect(plan.services).toEqual([]);
    expect(planIsEmpty(plan)).toBe(false);
  });
});
