import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { NextRequest } from "next/server";

import { customHostResponse } from "@/features/domains-server/custom-host";
import { normalizeHostname } from "@/features/domains-server/hostname";
import { checkDomain, type Resolver } from "@/features/domains-server/verifier";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  createBusiness,
  createProfessional,
  db,
  env,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Her own domain (docs/SITE_DOMAIN_CONTRACT.md): the owner through
// PostgREST, the verifier with a scripted DNS and probe, and the proxy's
// handling of a request on her name.

const service = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
}) as AppSupabaseClient;

const TARGET = "sites.booking.test";
const FALLBACK = "http://localhost:3000/b/x";

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

type Domain = {
  id: string;
  hostname: string;
  state: string;
  generation: number;
  records: { type: string; name: string; value: string }[];
  reason: string | null;
};

let owner: Professional;
let business: TestBusiness;

const request = (
  who: Professional,
  b: TestBusiness,
  hostname: string,
  requestId = randomUUID(),
) =>
  call(who.client, "site_domain_request", {
    p_business_id: b.id,
    p_hostname: hostname,
    p_request_id: requestId,
    p_target: TARGET,
    p_fallback: FALLBACK,
  });
const read = () =>
  ok<Domain | null>(
    call(owner.client, "site_domain_read", {
      p_business_id: business.id,
      p_target: TARGET,
      p_fallback: FALLBACK,
    }),
  );
const begin = (domain: Domain, generation = domain.generation) =>
  call(owner.client, "site_domain_begin_check", {
    p_business_id: business.id,
    p_domain_id: domain.id,
    p_expected_generation: generation,
    p_target: TARGET,
    p_fallback: FALLBACK,
  });

/** A scripted DNS: TXT and CNAME records per name. */
function dns(records: {
  txt?: Record<string, string[]>;
  cname?: Record<string, string[]>;
}): Resolver {
  return {
    resolveTxt: async (name) => {
      const values = records.txt?.[name];
      if (!values) throw new Error("ENODATA");
      return values.map((v) => [v]);
    },
    resolveCname: async (name) => {
      const values = records.cname?.[name];
      if (!values) throw new Error("ENODATA");
      return values;
    },
    resolve4: async () => {
      throw new Error("ENODATA");
    },
  };
}

async function check(
  domain: Domain,
  resolver: Resolver,
  probeAnswer: string | null = null,
) {
  // Checks are limited to one per 30 seconds: the test steps around it.
  await db.query(
    "update private.site_domains set checked_at = null where id = $1",
    [domain.id],
  );
  const begun = await ok<{
    id: string;
    hostname: string;
    generation: number;
    state: string;
    challenge: string;
  }>(begin(domain));
  await checkDomain(
    { service, resolver, probe: async () => probeAnswer, target: TARGET },
    begun,
  );
  return (await read())!;
}

const host = () => `salon-${randomUUID().slice(0, 8)}.example.test`;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  owner = await createProfessional("domain-owner");
  business = await createBusiness(owner.userId);
});

describe("hostname", () => {
  it("normalises what she types, and refuses an IP, a port or a bare name", () => {
    expect(normalizeHostname(" https://Salon-A.Example.test/rdv ")).toBe(
      "salon-a.example.test",
    );
    expect(normalizeHostname("salon-a.example.test.")).toBe(
      "salon-a.example.test",
    );
    for (const bad of [
      "192.168.1.1",
      "salon.test:8080",
      "localhost",
      "-a.example.test",
      "a..test",
    ]) {
      expect(normalizeHostname(bad), bad).toBeNull();
    }
  });
});

describe("a domain's life", () => {
  it("goes from its challenge to active only on evidence: the proof, then our probe on the name", async () => {
    const name = host();
    const requestId = randomUUID();
    let domain = await ok<Domain>(request(owner, business, name, requestId));
    expect(domain).toMatchObject({
      hostname: name,
      state: "awaiting_dns",
      generation: 1,
    });
    expect(await ok(request(owner, business, name, requestId))).toEqual(domain);
    const txt = domain.records.find((r) => r.type === "TXT")!;
    expect(txt.name).toBe(`_booking-verify.${name}`);
    expect(domain.records.find((r) => r.type === "CNAME")!.value).toBe(TARGET);

    domain = await check(domain, dns({}));
    expect(domain).toMatchObject({ state: "error", reason: "proof_missing" });
    domain = await check(
      domain,
      dns({ txt: { [txt.name]: ["booking-verify=autre"] } }),
    );
    expect(domain.reason).toBe("proof_mismatch");
    domain = await check(
      domain,
      dns({
        txt: { [txt.name]: [txt.value] },
        cname: { [name]: ["ailleurs.test"] },
      }),
    );
    expect(domain.reason).toBe("target_mismatch");
    expect(
      await ok(call(service, "site_domain_tls_allowed", { p_hostname: name })),
    ).toBe(false);

    const right = dns({
      txt: { [txt.name]: [txt.value] },
      cname: { [name]: [`${TARGET}.`] },
    });
    domain = await check(domain, right);
    expect(domain.state).toBe("provisioning_tls");
    // A certificate may be issued now, not before.
    expect(
      await ok(call(service, "site_domain_tls_allowed", { p_hostname: name })),
    ).toBe(true);
    // The probe answers for another domain (routing elsewhere): not active.
    domain = await check(domain, right, randomUUID());
    expect(domain.state).toBe("provisioning_tls");
    domain = await check(domain, right, domain.id);
    expect(domain.state).toBe("active");

    // Its DNS goes away: no longer served.
    domain = await check(domain, dns({}));
    expect(domain).toMatchObject({ state: "error", reason: "dns_lost" });
  });

  it("a pending request blocks nobody: the first proof seen wins, then the name is taken", async () => {
    const name = host();
    const mine = await ok<Domain>(request(owner, business, name));
    const other = await createProfessional("domain-other");
    const theirs = await createBusiness(other.userId);
    // Asking without any proof never squats the name.
    const pending = await ok<Domain>(request(other, theirs, name));
    expect(pending.state).toBe("awaiting_dns");

    const txt = mine.records.find((r) => r.type === "TXT")!;
    await check(
      mine,
      dns({ txt: { [txt.name]: [txt.value] }, cname: { [name]: [TARGET] } }),
    );
    expect((await read())!.state).toBe("provisioning_tls");
    // Theirs lost it; asking again now: taken, without saying by whom.
    const { rows } = await db.query(
      "select state from private.site_domains where id = $1",
      [pending.id],
    );
    expect(rows[0].state).toBe("detached");
    expect((await request(other, theirs, name)).error?.message).toBe(
      "domain_taken",
    );
    expect(
      (await request(owner, business, "pas un domaine")).error?.message,
    ).toBe("invalid_input");
  });

  it("an expired proof gets a new challenge; an older generation is refused", async () => {
    const name = host();
    const first = await ok<Domain>(request(owner, business, name));
    await db.query(
      "update private.site_domains set proof_expires_at = now() - interval '1 second' where id = $1",
      [first.id],
    );
    expect(await ok(begin(first))).toEqual({ proofExpired: true });
    const renewed = (await read())!;
    expect(renewed.generation).toBe(2);
    expect(renewed.records[0]!.value).not.toBe(first.records[0]!.value);
    expect((await begin(first, 1)).error?.message).toBe(
      "domain_generation_changed",
    );
    // The verifier's report for generation 1 is stale.
    expect(
      await ok(
        call(service, "site_domain_report", {
          p_domain_id: first.id,
          p_generation: 1,
          p_outcome: "dns_ok",
          p_reason: null,
        }),
      ),
    ).toBe("stale");
  });

  it("detaching frees the name and stops serving it", async () => {
    const name = host();
    const domain = await ok<Domain>(request(owner, business, name));
    await db.query(
      "update private.site_domains set state = 'active' where id = $1",
      [domain.id],
    );
    await ok(
      call(owner.client, "site_domain_detach", {
        p_business_id: business.id,
        p_domain_id: domain.id,
        p_expected_generation: 1,
        p_request_id: randomUUID(),
      }),
    );
    expect(await read()).toBeNull();
    expect(
      await ok(call(service, "site_domain_route", { p_hostname: name })),
    ).toEqual([]);
    const other = await createProfessional("domain-next");
    const theirs = await createBusiness(other.userId);
    expect((await request(other, theirs, name)).error).toBeNull();
  });

  it("only the owner manages it", async () => {
    const admin = await createProfessional("domain-admin");
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $2, 'admin')",
      [business.id, admin.userId],
    );
    expect((await request(admin, business, host())).error?.message).toBe(
      "forbidden",
    );
  });
});

describe("certificates", () => {
  it("are never allowed while routing by name is off", async () => {
    const { GET: ask } = await import("@/app/api/domains/tls-ask/route");
    const name = host();
    const domain = await ok<Domain>(request(owner, business, name));
    await db.query(
      "update private.site_domains set state = 'provisioning_tls' where id = $1",
      [domain.id],
    );
    const asked = (hostname: string) =>
      ask(
        new Request(`http://localhost/api/domains/tls-ask?domain=${hostname}`),
      );
    delete process.env.SITE_DOMAINS_ENABLED;
    expect((await asked(name)).status).toBe(404);
    process.env.SITE_DOMAINS_ENABLED = "true";
    expect((await asked(name)).status).toBe(200);
    expect((await asked(host())).status).toBe(404);
    delete process.env.SITE_DOMAINS_ENABLED;
  });

  it("the probe never connects to a private address", async () => {
    const { isPublicIPv4 } = await import("@/features/domains-server/verifier");
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "192.168.1.1",
      "172.20.0.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPublicIPv4(ip), ip).toBe(false);
    }
    expect(isPublicIPv4("93.184.216.34")).toBe(true);
  });
});

describe("a request on her name", () => {
  it("serves her public page only: never the professional space; unknown names are not served", async () => {
    const name = host();
    const domain = await ok<Domain>(request(owner, business, name));
    await db.query(
      "update private.site_domains set state = 'active' where id = $1",
      [domain.id],
    );
    const on = (hostname: string, path: string) =>
      customHostResponse(
        new NextRequest(`https://${hostname}${path}`, {
          headers: { host: hostname },
        }),
      );

    const home = await on(name, "/");
    expect(home!.headers.get("x-middleware-rewrite")).toContain(
      `/b/${business.slug}`,
    );
    expect((await on(name, "/app"))!.status).toBe(404);
    expect((await on(name, "/login"))!.status).toBe(404);
    expect((await on(name, "/api/public/businesses/x"))!.status).toBe(200);
    expect((await on(name, "/api/bookingsX"))!.status).toBe(404);
    expect(
      (await on(`${name}.`, "/"))!.headers.get("x-middleware-rewrite"),
    ).toContain(`/b/${business.slug}`);
    const action = await customHostResponse(
      new NextRequest(`https://${name}/`, {
        method: "POST",
        headers: { host: name, "next-action": "abc" },
      }),
    );
    expect(action!.status).toBe(404);
    expect((await on(host(), "/"))!.status).toBe(404);
    // Our own host: as usual.
    expect(await on("localhost:3000", "/app")).toBeNull();
  });
});
