import "server-only";

import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The domain verifier (docs/SITE_DOMAIN_CONTRACT.md): reads public DNS and
// probes the name over HTTPS, then reports to the database with the
// generation it checked. Never writes DNS, never requests a certificate.

export type Resolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
};

export type Probe = (hostname: string) => Promise<string | null>;

export const systemResolver: Resolver = {
  resolveTxt: (name) => dns.resolveTxt(name),
  resolveCname: (name) => dns.resolveCname(name),
  resolve4: (name) => dns.resolve4(name),
};

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 4_096;

/** A public unicast IPv4 address: never private, loopback, link-local, metadata or multicast. */
export function isPublicIPv4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * Our probe on the name: the domain id it answers, or null. The name is
 * resolved once and every address must be public; the connection goes to
 * that address (no second resolution an attacker could rebind), with the
 * certificate checked against the name. No redirect is followed.
 */
export const httpsProbe: Probe = async (hostname) => {
  const addresses = await attempt(() => dns.resolve4(hostname), [] as string[]);
  if (addresses.length === 0 || !addresses.every(isPublicIPv4)) return null;
  return new Promise<string | null>((resolve) => {
    const req = httpsRequest(
      {
        host: addresses[0],
        servername: hostname,
        port: 443,
        path: "/api/domains/probe",
        method: "GET",
        headers: { host: hostname },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > PROBE_MAX_BYTES) req.destroy();
        });
        res.on("end", () => {
          try {
            const id = (JSON.parse(body) as { domainId?: unknown }).domainId;
            resolve(typeof id === "string" ? id : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
};

const attempt = async <T>(read: () => Promise<T>, fallback: T) => {
  try {
    return await read();
  } catch {
    return fallback;
  }
};

type Checked = {
  id: string;
  hostname: string;
  generation: number;
  state: string;
  challenge: string;
};

/** Does the name show our proof and point to our target? */
export async function dnsVerdict(
  resolver: Resolver,
  domain: Checked,
  target: string,
): Promise<"dns_ok" | "proof_missing" | "proof_mismatch" | "target_mismatch"> {
  const txt = (
    await attempt(
      () => resolver.resolveTxt(`_booking-verify.${domain.hostname}`),
      [],
    )
  ).map((parts) => parts.join(""));
  if (txt.length === 0) return "proof_missing";
  if (!txt.includes(`booking-verify=${domain.challenge}`))
    return "proof_mismatch";
  const cname = await attempt(() => resolver.resolveCname(domain.hostname), []);
  if (cname.some((name) => name.replace(/\.$/, "").toLowerCase() === target)) {
    return "dns_ok";
  }
  // An apex name cannot be a CNAME: the same addresses as the target do.
  const [mine, ours] = await Promise.all([
    attempt(() => resolver.resolve4(domain.hostname), []),
    attempt(() => resolver.resolve4(target), []),
  ]);
  return mine.length > 0 && mine.every((ip) => ours.includes(ip))
    ? "dns_ok"
    : "target_mismatch";
}

async function report(
  service: AppSupabaseClient,
  domain: Checked,
  outcome: "dns_ok" | "https_ok" | "failure",
  reason: string | null = null,
) {
  const { error } = await service.rpc("site_domain_report", {
    p_domain_id: domain.id,
    p_generation: domain.generation,
    p_outcome: outcome,
    p_reason: reason as string,
  });
  if (error) throw databaseException(error);
}

/** One check of one domain, reported with its generation. */
export async function checkDomain(
  deps: {
    service: AppSupabaseClient;
    resolver: Resolver;
    probe: Probe;
    target: string;
  },
  domain: Checked,
): Promise<void> {
  const verdict = await dnsVerdict(deps.resolver, domain, deps.target);
  if (verdict !== "dns_ok") {
    // An active domain whose DNS went away; otherwise not there yet.
    await report(
      deps.service,
      domain,
      "failure",
      domain.state === "active" ? "dns_lost" : verdict,
    );
    return;
  }
  if (domain.state === "awaiting_dns" || domain.state === "error") {
    await report(deps.service, domain, "dns_ok");
    domain = { ...domain, state: "provisioning_tls" };
  }
  // Certificate and routing: our probe must answer on the name, for it.
  if ((await deps.probe(domain.hostname)) === domain.id) {
    await report(deps.service, domain, "https_ok");
  }
}
