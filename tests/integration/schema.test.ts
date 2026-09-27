import { describe, expect, it } from "vitest";

import { db } from "./support/fixtures";

// The global setup already fails when a migration file is not applied. These
// tests assert the security-relevant shape of the migrated schema.

describe("migrated schema", () => {
  it("has the extensions required by the model", async () => {
    const { rows } = await db.query<{ extname: string }>(
      "select extname from pg_extension",
    );
    const names = rows.map((row) => row.extname);

    expect(names).toEqual(
      expect.arrayContaining(["btree_gist", "citext", "pgcrypto"]),
    );
  });

  it("enables RLS on every table of the public schema", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select relname from pg_class
       where relnamespace = 'public'::regnamespace
         and relkind in ('r', 'p')
         and not relrowsecurity`,
    );

    expect(rows).toEqual([]);
  });

  it("guards appointments with a buffer-aware exclusion constraint", async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'appointments_no_overlap'`,
    );

    expect(rows[0]?.def).toBe(
      "EXCLUDE USING gist (business_id WITH =, occupied_window WITH &&) " +
        "WHERE ((status <> 'cancelled'::appointment_status))",
    );
  });

  it("uses tenant-aware composite foreign keys for cross-entity links", async () => {
    const { rows } = await db.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.appointments'::regclass and contype = 'f'
       order by conname`,
    );
    const defs = rows.map((row) => row.def);

    expect(defs).toContain(
      "FOREIGN KEY (client_id, business_id) REFERENCES clients(id, business_id)",
    );
    expect(defs).toContain(
      "FOREIGN KEY (service_id, business_id) REFERENCES services(id, business_id)",
    );
  });

  it("gives anonymous callers no direct table privilege", async () => {
    const { rows } = await db.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`,
    );

    expect(rows).toEqual([]);
  });

  it("never lets API roles TRUNCATE (TRUNCATE bypasses RLS)", async () => {
    const { rows } = await db.query(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated')
         and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')`,
    );

    expect(rows).toEqual([]);
  });

  it("exposes exactly the intended functions to anonymous callers", async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and has_function_privilege('anon', p.oid, 'execute')
       order by p.proname`,
    );

    expect(rows.map((row) => row.proname)).toEqual([
      "create_public_booking",
      "get_available_slots",
      "get_public_business",
      "get_public_services",
    ]);
  });

  it("pins search_path on every SECURITY DEFINER function", async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prosecdef
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, '{}')) c
           where c like 'search_path=%'
         )`,
    );

    expect(rows).toEqual([]);
  });

  it("keeps the private schema unreachable for API roles", async () => {
    const { rows } = await db.query<{ anon: boolean; authenticated: boolean }>(
      `select has_schema_privilege('anon', 'private', 'usage') as anon,
              has_schema_privilege('authenticated', 'private', 'usage') as authenticated`,
    );

    expect(rows[0]).toEqual({ anon: false, authenticated: false });
  });
});
