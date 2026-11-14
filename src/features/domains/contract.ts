// Her own domain for her site (R5-02). PROPOSED contract
// (docs/SITE_DOMAIN_PROPOSAL.md): no server serves it yet. No domain is
// bought, no DNS is read, no certificate is requested from here: the
// screen takes its actions as a whole; only the design preview and the
// tests give it an in-memory server. Her usual address keeps serving
// whatever happens.

export type DomainState =
  | "awaiting_dns"
  | "verified"
  | "provisioning_tls"
  | "active"
  | "error"
  | "suspended"
  | "detached";

export type DnsRecord = {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
};

export type SiteDomainDto = {
  id: string;
  hostname: string;
  state: DomainState;
  /** Bumped by every new challenge: late answers of an older one are ignored. */
  generation: number;
  records: DnsRecord[];
  proofExpiresAt: string | null;
  /** Always served, before, during and after. */
  fallbackUrl: string;
  /** Stable reason when state is error or suspended. */
  reason:
    | "proof_missing"
    | "proof_mismatch"
    | "target_mismatch"
    | "tls_failed"
    | "dns_lost"
    | null;
  checkedAt: string | null;
};

export type DomainResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type SiteDomainActions = {
  read: () => Promise<DomainResult<SiteDomainDto | null>>;
  request: (input: {
    hostname: string;
    requestId: string;
  }) => Promise<DomainResult<SiteDomainDto>>;
  /** Check again now; a new challenge if the proof expired. */
  retry: (input: {
    id: string;
    expectedGeneration: number;
    requestId: string;
  }) => Promise<DomainResult<SiteDomainDto>>;
  detach: (input: {
    id: string;
    expectedGeneration: number;
    requestId: string;
  }) => Promise<DomainResult<null>>;
};

export const domainErrors = {
  taken: "domain_taken",
  proofExpired: "proof_expired",
  generationChanged: "domain_generation_changed",
  unavailable: "domain_unavailable",
} as const;

/**
 * A public hostname she may type: lower case, no scheme, path, port or
 * trailing dot; at least one dot; labels of letters, digits and hyphens;
 * never an IP address. Returns null when it is not one.
 */
export function normalizeHostname(input: string) {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!;
  host = host.replace(/\.$/, "");
  if (host.includes(":") || host.includes("@")) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (host.length > 253 || !host.includes(".")) return null;
  const labels = host.split(".");
  if (
    !labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) ||
    !/^[a-z]{2,}$/.test(labels.at(-1)!)
  )
    return null;
  return host;
}
