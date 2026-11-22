import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  anonClient,
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
} from "./support/fixtures";

it("limits reviews to the visitor's past, eligible appointments in that business", async () => {
  const owner = await createProfessional("review");
  const business = await createBusiness(owner.userId),
    other = await createBusiness(owner.userId);
  const service = await createService(business.id, { durationMinutes: 30 });
  const email = "review-" + randomUUID() + "@example.test";
  const client = await createClientRecord(business.id, email, "Lou");
  const token = randomBytes(32).toString("hex");
  const { rows } = await db.query<{ id: string }>(
    "insert into private.client_hub_accounts(email) values ($1) returning id",
    [email],
  );
  await db.query(
    "insert into private.client_hub_sessions(account_id,token_hash,created_at,expires_at,last_seen_at) values ($1,$2,now(),now()+interval '1 day',now())",
    [rows[0]!.id, createHash("sha256").update(token).digest("hex")],
  );
  const args = {
    p_session_token: token,
    p_slug: business.slug,
    p_stars: 5,
    p_comment: "Très bien.",
  };
  const save = (slug = business.slug, stars = 5) =>
    bookingClient().rpc("client_hub_business_review", {
      ...args,
      p_slug: slug,
      p_stars: stars,
    });
  expect(
    (await anonClient().rpc("client_hub_business_review", args)).error,
  ).toBeTruthy();
  const empty = async () =>
    expect((await save()).data).toEqual({ eligible: false });
  const starts = new Date(Date.now() - 3 * 86400000);
  const visit = await insertAppointment({
    businessId: business.id,
    clientId: client,
    serviceId: service,
    startsAt: starts.toISOString(),
    endsAt: new Date(starts.getTime() + 30 * 60000).toISOString(),
  });
  await empty(); // an address in a record alone grants no access
  await db.query(
    "insert into public.client_hub_access(business_id,client_id,email,granted_by) values ($1,$2,$3,$4)",
    [business.id, client, email, owner.userId],
  );
  expect((await save(other.slug)).data).toEqual({ eligible: false });
  for (const status of ["no_show", "cancelled"]) {
    await db.query("update public.appointments set status=$2 where id=$1", [
      visit,
      status,
    ]);
    await empty();
  }
  await db.query(
    "update public.appointments set status='confirmed' where id=$1",
    [visit],
  );
  expect((await save(business.slug, 6)).error).toBeTruthy();
  expect((await save()).data).toMatchObject({ eligible: true, stars: 5 });
  expect(
    (await Promise.all([save(business.slug, 4), save(business.slug, 4)])).every(
      (r) => !r.error,
    ),
  ).toBe(true);
  const pub = await anonClient().rpc("get_public_business_reviews", {
    p_slug: business.slug,
  });
  expect(pub.data).toMatchObject({ count: 1, average: 4 });
  expect(
    (
      await anonClient().rpc("get_public_business_reviews", {
        p_slug: other.slug,
      })
    ).data,
  ).toEqual({ count: 0, average: null, reviews: [] });
});
