import { createHash, randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the Client Hub (20261021090000) to one cookie per session
// (20261024090000) with sessions in the database: no session, account or
// challenge is rewritten or ended by the upgrade; the existing sessions are
// usable through the new resolver (by id and token); the superseded
// single-token entry points are no longer open to the service role.

const BEFORE = "20261021090000";

const token = () => randomBytes(32).toString("hex");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let live: { id: string; token: string; account: string };
let revoked: { id: string; token: string };
let before: string;

async function snapshot() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(s::text, '|' order by s.id) from private.client_hub_sessions s),
       (select string_agg(a::text, '|' order by a.id) from private.client_hub_accounts a),
       (select string_agg(c::text, '|' order by c.id) from private.client_hub_challenges c)
     )) as hash`,
  );
  return rows[0].hash as string;
}

describe("upgrade to one cookie per Client Hub session", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    const { rows: accounts } = await db.query<{ id: string }>(
      `insert into private.client_hub_accounts (email) values ('legacy@client.test') returning id`,
    );
    const account = accounts[0]!.id;
    const liveToken = token();
    const revokedToken = token();
    const { rows } = await db.query<{ id: string }>(
      `insert into private.client_hub_sessions
         (account_id, token_hash, created_at, expires_at, last_seen_at, revoked_at)
       values ($1, $2, now(), now() + interval '7 days', now(), null),
              ($1, $3, now() - interval '1 hour', now() + interval '7 days', now(), now())
       returning id`,
      [account, sha256(liveToken), sha256(revokedToken)],
    );
    live = { id: rows[0]!.id, token: liveToken, account };
    revoked = { id: rows[1]!.id, token: revokedToken };
    before = await snapshot();
    migrateUp();
  });

  it("rewrites and ends nothing", async () => {
    expect(await snapshot()).toBe(before);
  });

  it("an existing session is resolved by its id and its own token; a revoked one is not", async () => {
    await db.query("begin");
    try {
      const { rows } = await db.query(
        "select status, session_id, session_token, account_id from public.client_hub_resolve_session($1::uuid[], $2::text[])",
        [
          [live.id, revoked.id],
          [live.token, revoked.token],
        ],
      );
      expect(rows[0]).toEqual({
        status: "ok",
        session_id: live.id,
        session_token: live.token,
        account_id: live.account,
      });
    } finally {
      await db.query("rollback");
    }
  });

  it("the service role opens and ends sessions through the new functions only", async () => {
    const { rows } = await db.query(
      `select p.proname, has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('client_hub_verify_code', 'client_hub_end_session',
                           'client_hub_sign_in', 'client_hub_sign_out',
                           'client_hub_resolve_session')
       order by p.proname`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.proname, r.service]))).toEqual(
      {
        client_hub_end_session: false,
        client_hub_resolve_session: true,
        client_hub_sign_in: true,
        client_hub_sign_out: true,
        client_hub_verify_code: false,
      },
    );
  });
});
