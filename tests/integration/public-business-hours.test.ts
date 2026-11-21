import { beforeAll, describe, expect, it } from "vitest";

import { getPublicBusinessHours } from "@/features/businesses/data/public-business";

import {
  anonClient,
  createBusiness,
  createProfessional,
  db,
  setWeeklyHours,
  type TestBusiness,
} from "./support/fixtures";

// Her usual hours for her site's "Infos pratiques" (Higani point 5): read
// by anyone who can read her public profile, ranges in order (a lunch
// break is two ranges), nothing internal.

const client = anonClient();
let business: TestBusiness;

beforeAll(async () => {
  const owner = await createProfessional("hours");
  business = await createBusiness(owner.userId, { name: "Maison Alma" });
  await setWeeklyHours(business.id, [
    [1, "14:00", "19:00"],
    [1, "09:00", "12:30"],
    [6, "10:00", "17:00"],
  ]);
});

describe("get_public_business_hours", () => {
  it("gives her usual week to an anonymous client, in order", async () => {
    expect(await getPublicBusinessHours(client, business.slug)).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "12:30" },
      { weekday: 1, startsAt: "14:00", endsAt: "19:00" },
      { weekday: 6, startsAt: "10:00", endsAt: "17:00" },
    ]);
  });

  it("answers by slug, ignoring case and spaces like her profile", async () => {
    expect(
      await getPublicBusinessHours(client, ` ${business.slug.toUpperCase()} `),
    ).toHaveLength(3);
  });

  it("answers nothing for an unknown slug", async () => {
    expect(await getPublicBusinessHours(client, "nobody-here")).toEqual([]);
  });

  it("returns only weekday and times", async () => {
    const { data, error } = await client.rpc("get_public_business_hours", {
      p_slug: business.slug,
    });
    expect(error).toBeNull();
    expect(Object.keys(data![0]!).sort()).toEqual([
      "ends_at",
      "starts_at",
      "weekday",
    ]);
  });

  it("is read-only: the table stays closed to anonymous clients", async () => {
    const { data } = await client
      .from("business_hours")
      .select("id")
      .eq("business_id", business.id);
    expect(data ?? []).toEqual([]);
    const count = await db.query(
      "select count(*)::int as n from public.business_hours where business_id = $1",
      [business.id],
    );
    expect(count.rows[0].n).toBe(3);
  });
});
