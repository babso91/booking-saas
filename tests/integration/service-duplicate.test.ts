import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  generateTeamInviteToken,
  hashTeamInviteToken,
  type TeamMemberDto,
} from "@/features/team/data/team";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  db,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Point 41 (Higani backlog): duplicating a service. The copy takes the
// description, price, length, category, questions and answers, the people
// who perform it and its loyalty points; it starts deactivated, right after
// the original, which stays exactly as it was.

let owner: Professional;
let business: TestBusiness;
let source: string;
let category: string;
let lea: TeamMemberDto;
let sam: TeamMemberDto;

type Row = { status: string; service_id: string | null };

async function call<T>(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await client.rpc(fn as never, args as never);
  return { data: data as T, error };
}
async function ok<T>(promise: Promise<{ data: T; error: unknown }>) {
  const { data, error } = await promise;
  expect(error).toBeNull();
  return data;
}

const duplicate = (
  requestId = randomUUID(),
  serviceId = source,
  client = owner.client,
) =>
  call<Row[]>(client, "duplicate_service", {
    p_business_id: business.id,
    p_request_id: requestId,
    p_service_id: serviceId,
  });

/** What she set on a service, ids left out, in order. */
async function shape(serviceId: string) {
  const service = await db.query(
    `select name, description, duration_minutes, price_cents, active,
            display_order, category_id
     from public.services where id = $1`,
    [serviceId],
  );
  const options = await db.query(
    `select o.question, o.required, o.display_order,
            coalesce(json_agg(json_build_object(
              'label', c.label, 'price', c.price_delta_cents,
              'minutes', c.duration_delta_minutes, 'order', c.display_order
            ) order by c.display_order, c.label) filter (where c.id is not null), '[]') as choices
     from public.service_options o
     left join public.service_option_choices c on c.option_id = o.id
     where o.service_id = $1
     group by o.id
     order by o.display_order, o.question`,
    [serviceId],
  );
  const staff = await db.query<{ staff_id: string }>(
    "select staff_id from public.staff_services where service_id = $1 order by staff_id",
    [serviceId],
  );
  const loyalty = await db.query<{ points: number }>(
    "select points from public.loyalty_service_rules where service_id = $1",
    [serviceId],
  );
  return {
    service: service.rows[0],
    options: options.rows,
    staff: staff.rows.map((row) => row.staff_id),
    points: loyalty.rows[0]?.points ?? null,
  };
}

async function staffMember(name: string) {
  return ok<TeamMemberDto>(
    call(owner.client, "create_staff_member", {
      p_business_id: business.id,
      p_operation_id: randomUUID(),
      p_display_name: name,
      p_bookable: true,
      p_service_ids: [],
    }),
  );
}

beforeAll(async () => {
  owner = await createProfessional("duplicate");
  business = await createBusiness(owner.userId);
  const { rows } = await db.query<{ id: string }>(
    "insert into public.service_categories (business_id, name) values ($1, 'Cils') returning id",
    [business.id],
  );
  category = rows[0]!.id;
  source = await createService(business.id, {
    name: "Rehaussement de cils",
    durationMinutes: 75,
    priceCents: 6000,
  });
  await db.query(
    "update public.services set description = 'Courbure naturelle, 6 semaines.', category_id = $2, display_order = 4 where id = $1",
    [source, category],
  );
  await db.query(
    `with effet as (
       insert into public.service_options (business_id, service_id, question, required, display_order)
       values ($1, $2, 'Effet', true, 0) returning id
     ), soin as (
       insert into public.service_options (business_id, service_id, question, required, display_order)
       values ($1, $2, 'Soin kératine', false, 1) returning id
     )
     insert into public.service_option_choices
       (business_id, option_id, label, price_delta_cents, duration_delta_minutes, display_order)
     select $1, effet.id, label, price, minutes, rank from effet,
       (values ('Naturel', 0, 0, 0), ('Intense', 1000, 15, 1)) c(label, price, minutes, rank)
     union all
     select $1, soin.id, 'Avec soin', 1500, 10, 0 from soin`,
    [business.id, source],
  );
  lea = await staffMember("Léa");
  sam = await staffMember("Sam");
  await staffMember("Nina"); // performs other services
  await db.query(
    `insert into public.staff_services (staff_id, business_id, service_id)
     values ($1, $3, $4), ($2, $3, $4) on conflict do nothing`,
    [lea.id, sam.id, business.id, source],
  );
  await ok(
    call(owner.client, "loyalty_set_service_rule", {
      p_business_id: business.id,
      p_service_id: source,
      p_points: 30,
    }),
  );
});

describe("point 41: duplicating a service", () => {
  it("copies what she set, deactivated, right after the original; the original is untouched", async () => {
    const before = await shape(source);
    const [row] = await ok(duplicate());
    expect(row).toMatchObject({ status: "created" });
    const copy = row!.service_id!;
    expect(copy).not.toBe(source);

    const original = await shape(source);
    expect(original).toEqual(before);
    const copied = await shape(copy);
    expect(copied).toEqual({
      ...before,
      service: {
        ...before.service,
        name: "Rehaussement de cils (copie)",
        active: false,
      },
    });
    expect(copied.staff).toEqual(expect.arrayContaining([lea.id, sam.id]));
    expect(copied.points).toBe(30);
    expect(copied.options).toHaveLength(2);

    // Its own questions: nothing shared with the original.
    const shared = await db.query(
      `select 1 from public.service_options a
       join public.service_options b on a.id = b.id
       where a.service_id = $1 and b.service_id = $2`,
      [source, copy],
    );
    expect(shared.rowCount).toBe(0);

    // Listed right after the original (same place, its name sorts after).
    const order = await db.query<{ id: string }>(
      "select id from public.services where business_id = $1 order by display_order, name, id",
      [business.id],
    );
    const ids = order.rows.map((r) => r.id);
    expect(ids.indexOf(copy)).toBe(ids.indexOf(source) + 1);

    // Nothing booked travels with it.
    const booked = await db.query(
      "select 1 from public.appointments where service_id = $1",
      [copy],
    );
    expect(booked.rowCount).toBe(0);
  });

  it("hidden until she activates it; then quoted like the original", async () => {
    const [row] = await ok(duplicate());
    const copy = row!.service_id!;
    const visitor = anonClient();
    const listed = async () =>
      (
        (await ok(
          call<{ id: string }[]>(visitor, "get_public_services", {
            p_slug: business.slug,
          }),
        )) ?? []
      ).map((service) => service.id);
    expect(await listed()).not.toContain(copy);

    await db.query("update public.services set active = true where id = $1", [
      copy,
    ]);
    expect(await listed()).toContain(copy);
    const intense = async (serviceId: string) => {
      const { rows } = await db.query<{ id: string }>(
        `select c.id from public.service_option_choices c
         join public.service_options o on o.id = c.option_id
         where o.service_id = $1 and c.label in ('Intense', 'Avec soin')`,
        [serviceId],
      );
      const [quote] = await ok(
        call<
          {
            price_cents: number;
            duration_minutes: number;
            options: Record<string, unknown>[];
          }[]
        >(visitor, "quote_public_service", {
          p_slug: business.slug,
          p_service_id: serviceId,
          p_option_choice_ids: rows.map((r) => r.id),
        }),
      );
      // What she is quoted, ids aside.
      return {
        price: quote!.price_cents,
        minutes: quote!.duration_minutes,
        options: quote!.options.map((option) => {
          const shown = { ...option };
          delete shown.choiceId;
          delete shown.optionId;
          return shown;
        }),
      };
    };
    expect(await intense(copy)).toEqual(await intense(source));
    expect(await intense(copy)).toMatchObject({ price: 8500, minutes: 100 });
  });

  it("once per request: a retry answers the same copy, another command is refused", async () => {
    const requestId = randomUUID();
    const [first] = await ok(duplicate(requestId));
    const [again] = await ok(duplicate(requestId));
    expect(again).toEqual({
      status: "replayed",
      service_id: first!.service_id,
    });
    const count = await db.query(
      "select 1 from public.services where business_id = $1 and name like '% (copie)'",
      [business.id],
    );

    const other = await createService(business.id, { name: "Teinture" });
    const conflict = await duplicate(requestId, other);
    expect(conflict.error?.message).toBe("idempotency_conflict");

    await db.query("delete from public.services where id = $1", [
      first!.service_id,
    ]);
    const [gone] = await ok(duplicate(requestId));
    expect(gone).toEqual({ status: "deleted", service_id: null });
    const after = await db.query(
      "select 1 from public.services where business_id = $1 and name like '% (copie)'",
      [business.id],
    );
    expect(after.rowCount).toBe(count.rowCount! - 1);
  });

  it("a name at the limit stays within it", async () => {
    const long = await createService(business.id, { name: "N".repeat(120) });
    const [row] = await ok(duplicate(randomUUID(), long));
    const { rows } = await db.query<{ name: string }>(
      "select name from public.services where id = $1",
      [row!.service_id],
    );
    expect(rows[0]!.name).toHaveLength(120);
    expect(rows[0]!.name.endsWith(" (copie)")).toBe(true);
  });

  it("the owner's and admins': a practitioner, a stranger or another business's service gets nothing", async () => {
    const member = await staffMember("Inès");
    const ines = await createProfessional("duplicate-practitioner");
    const token = generateTeamInviteToken();
    await ok(
      call(owner.client, "send_team_invitation", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: member.id,
        p_expected_revision: member.revision,
        p_email: ines.email,
        p_role: "practitioner",
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    await ok(
      call(ines.client, "accept_team_invitation", {
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    const before = await db.query(
      "select count(*)::int as n from public.services where business_id = $1",
      [business.id],
    );

    expect(
      (await duplicate(randomUUID(), source, ines.client)).error?.message,
    ).toBe("forbidden");
    const stranger = await createProfessional("duplicate-stranger");
    expect(
      (await duplicate(randomUUID(), source, stranger.client)).error?.message,
    ).toBe("forbidden");

    const elsewhere = await createBusiness(stranger.userId);
    const theirs = await createService(elsewhere.id, { name: "Ailleurs" });
    expect((await duplicate(randomUUID(), theirs)).error?.message).toBe(
      "service_not_found",
    );

    const after = await db.query(
      "select count(*)::int as n from public.services where business_id = $1",
      [business.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
