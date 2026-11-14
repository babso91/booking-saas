import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade to the team (20261114090000) with a populated database: an owner,
// an admin, two services, past and upcoming appointments. Every member gets
// a profile; the owner's is bookable for every service and holds the
// existing appointments; no other column of an existing row changes (no
// version or updated_at bump) and no email is queued.

const BEFORE = "20261108090000";

let owner: Professional;
let admin: Professional;
let business: TestBusiness;
let services: string[];
let before: string;

async function hash() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(m::text, '|' order by m.id) from public.business_members m where m.business_id = $1),
       (select string_agg(s::text, '|' order by s.id) from public.services s where s.business_id = $1),
       (select string_agg((to_jsonb(a) - 'staff_id')::text, '|' order by a.id) from public.appointments a where a.business_id = $1),
       (select count(*) from public.email_events e where e.business_id = $1)
     )) as hash`,
    [business.id],
  );
  return rows[0].hash as string;
}

describe("upgrade to the team", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    owner = await createProfessional("team-upgrade-owner");
    admin = await createProfessional("team-upgrade-admin");
    business = await createBusiness(owner.userId);
    await db.query(
      `insert into public.business_members (business_id, user_id, role) values ($1, $2, 'admin')`,
      [business.id, admin.userId],
    );
    services = [
      await createService(business.id, { name: "Pose" }),
      await createService(business.id, { name: "Dépose" }),
    ];
    const client = await createClientRecord(business.id, "up@test.local");
    for (const days of [-3, 4]) {
      const startsAt = new Date(Date.now() + days * 86_400_000);
      await insertAppointment({
        businessId: business.id,
        clientId: client,
        serviceId: services[0]!,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        status: days < 0 ? "completed" : "confirmed",
      });
    }
    before = await hash();
    migrateUp();
  });

  it("rewrites nothing else", async () => {
    expect(await hash()).toBe(before);
  });

  it("gives each member a profile, the owner's bookable with her appointments", async () => {
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      bookable: boolean;
      services: string[] | null;
    }>(
      `select s.id, s.user_id, s.bookable,
              array_agg(ss.service_id order by ss.service_id) filter (where ss.service_id is not null) as services
       from public.staff_members s
       left join public.staff_services ss on ss.staff_id = s.id
       where s.business_id = $1
       group by s.id`,
      [business.id],
    );
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.user_id === owner.userId)!;
    const theirs = rows.find((r) => r.user_id === admin.userId)!;
    expect(mine.bookable).toBe(true);
    expect(mine.services).toEqual(services.toSorted());
    expect(theirs).toMatchObject({ bookable: false, services: null });

    const { rows: appointments } = await db.query(
      "select distinct staff_id from public.appointments where business_id = $1",
      [business.id],
    );
    expect(appointments).toEqual([{ staff_id: mine.id }]);

    const { data, error } = await owner.client.rpc("get_team", {
      p_business_id: business.id,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ id: mine.id, upcomingAppointments: 1 }),
      ]),
    });
  });
});
