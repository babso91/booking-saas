import {
  domainErrors,
  type DomainResult,
  type SiteDomainActions,
  type SiteDomainDto,
} from "./contract";

// An in-memory server of the PROPOSED domain contract, for the preview and
// the tests only. A scripted DNS: nothing is resolved, bought or issued.
// The recipe's fixture: salon-a.example.test, NXDOMAIN → exact TXT → TLS
// pending → active.

const fail = (code: string): DomainResult<never> => ({
  ok: false,
  error: { code },
});

export function memorySiteDomain(
  options: {
    delayMs?: number;
    now?: () => number;
    /** Hostnames another business already holds. */
    taken?: string[];
    /** What each successive check finds (last one repeats). */
    script?: ("nothing" | "wrong_txt" | "txt_ok" | "tls_failed" | "tls_ok")[];
    start?: SiteDomainDto | null;
  } = {},
) {
  let domain: SiteDomainDto | null = options.start
    ? structuredClone(options.start)
    : null;
  const taken = new Set(options.taken ?? []);
  const script = options.script ?? ["nothing", "txt_ok", "tls_ok"];
  const now = options.now ?? (() => Date.parse("2026-11-14T10:00:00.000Z"));
  let step = 0;
  const answered = new Map<string, DomainResult<SiteDomainDto | null>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  const records = (hostname: string, generation: number) => [
    {
      type: "TXT" as const,
      name: `_reservation.${hostname}`,
      value: `rsv-verif=g${generation}-7f3a9c`,
    },
    {
      type: "CNAME" as const,
      name: hostname,
      value: "sites.reservation.example",
    },
  ];
  const fresh = (hostname: string, generation: number): SiteDomainDto => ({
    id: "dom-1",
    hostname,
    state: "awaiting_dns",
    generation,
    records: records(hostname, generation),
    proofExpiresAt: new Date(now() + 48 * 3_600_000).toISOString(),
    fallbackUrl: "https://reservation.example/b/atelier-maelys",
    reason: null,
    checkedAt: null,
  });

  async function once<T extends SiteDomainDto | null>(
    requestId: string,
    run: () => DomainResult<T>,
  ) {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier as DomainResult<T>;
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }

  const actions: SiteDomainActions = {
    async read() {
      await pause();
      return { ok: true, data: domain ? structuredClone(domain) : null };
    },
    request: ({ hostname, requestId }) =>
      once(requestId, () => {
        if (taken.has(hostname)) return fail(domainErrors.taken);
        domain = fresh(hostname, (domain?.generation ?? 0) + 1);
        step = 0;
        return { ok: true, data: structuredClone(domain) };
      }),
    retry: ({ id, expectedGeneration, requestId }) =>
      once(requestId, () => {
        if (!domain || domain.id !== id) return fail(domainErrors.unavailable);
        if (domain.generation !== expectedGeneration)
          return fail(domainErrors.generationChanged);
        if (
          domain.proofExpiresAt &&
          Date.parse(domain.proofExpiresAt) < now()
        ) {
          domain = fresh(domain.hostname, domain.generation + 1);
          return fail(domainErrors.proofExpired);
        }
        const found = script[Math.min(step, script.length - 1)]!;
        step += 1;
        const checkedAt = new Date(now()).toISOString();
        const next: SiteDomainDto =
          found === "nothing"
            ? {
                ...domain,
                state: "awaiting_dns",
                reason: "proof_missing",
                checkedAt,
              }
            : found === "wrong_txt"
              ? {
                  ...domain,
                  state: "error",
                  reason: "proof_mismatch",
                  checkedAt,
                }
              : found === "txt_ok"
                ? {
                    ...domain,
                    state: "provisioning_tls",
                    reason: null,
                    checkedAt,
                  }
                : found === "tls_failed"
                  ? {
                      ...domain,
                      state: "error",
                      reason: "tls_failed",
                      checkedAt,
                    }
                  : {
                      ...domain,
                      state: "active",
                      reason: null,
                      proofExpiresAt: null,
                      checkedAt,
                    };
        domain = next;
        return { ok: true, data: structuredClone(next) };
      }),
    detach: ({ id, expectedGeneration, requestId }) =>
      once(requestId, () => {
        if (!domain || domain.id !== id) return fail(domainErrors.unavailable);
        if (domain.generation !== expectedGeneration)
          return fail(domainErrors.generationChanged);
        domain = null;
        return { ok: true, data: null };
      }),
  };
  return {
    actions,
    get domain() {
      return domain;
    },
    /** A new challenge was issued elsewhere (another tab). */
    bumpGeneration() {
      if (domain) domain = fresh(domain.hostname, domain.generation + 1);
    },
  };
}
