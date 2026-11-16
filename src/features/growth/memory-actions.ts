import {
  growthErrors,
  smsUnits,
  type AudienceCriteria,
  type CampaignActions,
  type CampaignDto,
  type Channel,
  type GrowthResult,
  type SuppressionReason,
} from "./contract";

// An in-memory server of the PROPOSED campaign contract, for the preview
// and the tests only. A fixed clock and fictional clients; nothing is
// sent anywhere, ever.

const fail = (code: string): GrowthResult<never> => ({
  ok: false,
  error: { code },
});

export type FakeClient = {
  id: string;
  lastCompleted: number | null; // days ago
  lastService: string;
  lastVisitCompleted: boolean;
  futureAppointment: boolean;
  consent: Record<Channel, boolean>;
  reachable: Record<Channel, boolean>;
  contactedDaysAgo: number | null;
};

/** The recipe's four clients (C1..C4), then a deterministic crowd. */
export function sampleClients(): FakeClient[] {
  const both = { email: true, sms: true };
  const clients: FakeClient[] = [
    // C1 just finished and has a future appointment.
    {
      id: "c1",
      lastCompleted: 2,
      lastService: "s-gel",
      lastVisitCompleted: true,
      futureAppointment: true,
      consent: both,
      reachable: both,
      contactedDaysAgo: null,
    },
    // C2 consents and is inactive: the only one that passes.
    {
      id: "c2",
      lastCompleted: 70,
      lastService: "s-gel",
      lastVisitCompleted: true,
      futureAppointment: false,
      consent: both,
      reachable: both,
      contactedDaysAgo: null,
    },
    // C3 unsubscribed.
    {
      id: "c3",
      lastCompleted: 65,
      lastService: "s-gel",
      lastVisitCompleted: true,
      futureAppointment: false,
      consent: { email: false, sms: false },
      reachable: both,
      contactedDaysAgo: null,
    },
    // C4's last visit was a no-show.
    {
      id: "c4",
      lastCompleted: 80,
      lastService: "s-gel",
      lastVisitCompleted: false,
      futureAppointment: false,
      consent: both,
      reachable: both,
      contactedDaysAgo: null,
    },
  ];
  for (let i = 5; i <= 64; i += 1)
    clients.push({
      id: `c${i}`,
      lastCompleted: 20 + ((i * 37) % 160),
      lastService: i % 3 === 0 ? "s-lift" : "s-gel",
      lastVisitCompleted: i % 11 !== 0,
      futureAppointment: i % 5 === 0,
      consent: { email: i % 7 !== 0, sms: i % 4 !== 0 },
      reachable: { email: i % 9 !== 0, sms: i % 6 !== 0 },
      contactedDaysAgo: i % 13 === 0 ? 3 : null,
    });
  return clients;
}

export function memoryCampaigns(
  options: {
    delayMs?: number;
    budgetUnits?: number;
    clients?: FakeClient[];
    /** Fixed by default (tests); the preview passes the real clock. */
    now?: () => number;
  } = {},
) {
  const clients = options.clients ?? sampleClients();
  let budget = options.budgetUnits ?? 500;
  let count = 0;
  const estimates = new Map<
    string,
    {
      eligible: number;
      units: number;
      channel: Channel;
      expires: number;
      stale: boolean;
    }
  >();
  const campaigns = new Map<string, CampaignDto>();
  const answered = new Map<string, GrowthResult<CampaignDto>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  const now = options.now ?? (() => Date.parse("2026-11-14T10:00:00.000Z"));

  function evaluate(criteria: AudienceCriteria, channel: Channel) {
    const matched = clients.filter((client) =>
      criteria.kind === "rebooking"
        ? client.lastCompleted !== null &&
          client.lastCompleted >= criteria.afterDays &&
          criteria.serviceIds.includes(client.lastService)
        : client.lastCompleted !== null &&
          client.lastCompleted >= criteria.inactiveDays,
    );
    const suppressed: Partial<Record<SuppressionReason, number>> = {};
    let eligible = 0;
    for (const client of matched) {
      const reason: SuppressionReason | null = client.futureAppointment
        ? "future_appointment"
        : !client.lastVisitCompleted
          ? "last_visit_not_completed"
          : !client.consent[channel]
            ? "no_consent"
            : !client.reachable[channel]
              ? "unreachable"
              : client.contactedDaysAgo !== null
                ? "recent_contact"
                : null;
      if (reason) suppressed[reason] = (suppressed[reason] ?? 0) + 1;
      else eligible += 1;
    }
    return { matched: matched.length, eligible, suppressed };
  }

  async function once(requestId: string, run: () => GrowthResult<CampaignDto>) {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier;
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }

  const actions: CampaignActions = {
    async estimate({ criteria, channel, message }) {
      await pause();
      const { matched, eligible, suppressed } = evaluate(criteria, channel);
      const perClient = channel === "sms" ? smsUnits(message) : 1;
      const estimateId = `est-${(count += 1)}`;
      const expires = now() + 30 * 60_000;
      estimates.set(estimateId, {
        eligible,
        units: eligible * perClient,
        channel,
        expires,
        stale: false,
      });
      return {
        ok: true,
        data: {
          estimateId,
          matched,
          eligible,
          suppressedByReason: suppressed,
          estimatedUnits: eligible * perClient,
          estimateExpiresAt: new Date(expires).toISOString(),
          timeZone: "Europe/Paris",
          simulated: true,
        },
      };
    },
    schedule: (input) =>
      once(input.requestId, () => {
        const estimate = estimates.get(input.estimateId);
        if (!estimate || estimate.stale)
          return fail(growthErrors.estimateStale);
        if (input.maxUnits > budget) return fail(growthErrors.quotaExceeded);
        budget -= input.maxUnits;
        const campaign: CampaignDto = {
          campaignId: `camp-${campaigns.size + 1}`,
          version: 1,
          state: "scheduled",
          channel: estimate.channel,
          maxUnits: input.maxUnits,
          unitsUsed: 0,
          counts: {
            pending: estimate.eligible,
            handedOff: 0,
            accepted: 0,
            uncertain: 0,
            failed: 0,
            suppressed: 0,
          },
          suppressedByReason: {},
          attributedBookings: 0,
          attributionWindowDays: 14,
          simulated: true,
        };
        campaigns.set(campaign.campaignId, campaign);
        return { ok: true, data: structuredClone(campaign) };
      }),
    async read(campaignId) {
      await pause();
      const campaign = campaigns.get(campaignId);
      return campaign
        ? { ok: true, data: structuredClone(campaign) }
        : fail("not_found");
    },
    setState: (input) =>
      once(input.requestId, () => {
        const campaign = campaigns.get(input.campaignId);
        if (!campaign) return fail("not_found");
        if (campaign.version !== input.expectedVersion)
          return fail(growthErrors.versionConflict);
        const state =
          input.action === "pause"
            ? "paused"
            : input.action === "resume"
              ? "running"
              : "cancelled";
        const next = {
          ...campaign,
          version: campaign.version + 1,
          state,
        } satisfies CampaignDto;
        campaigns.set(campaign.campaignId, next);
        return { ok: true, data: structuredClone(next) };
      }),
  };

  return {
    actions,
    /** Earlier estimates no longer hold (audience or text changed server side). */
    staleEstimates() {
      for (const estimate of estimates.values()) estimate.stale = true;
    },
    /** The simulated worker moves a campaign on (tests and preview only). */
    advance(campaignId: string) {
      const campaign = campaigns.get(campaignId);
      if (
        !campaign ||
        campaign.state === "paused" ||
        campaign.state === "cancelled"
      )
        return;
      const batch = Math.min(
        campaign.counts.pending,
        Math.max(1, Math.ceil(campaign.counts.pending / 2)),
      );
      const lost = batch > 2 ? 1 : 0;
      const suppressed = batch > 3 ? 1 : 0;
      const sent = batch - lost - suppressed;
      const pending = campaign.counts.pending - batch;
      campaigns.set(campaignId, {
        ...campaign,
        version: campaign.version + 1,
        state: pending ? "running" : "completed",
        unitsUsed: campaign.unitsUsed + sent + lost,
        counts: {
          ...campaign.counts,
          pending,
          handedOff: campaign.counts.handedOff + sent + lost,
          accepted: campaign.counts.accepted + sent,
          uncertain: campaign.counts.uncertain + lost,
          suppressed: campaign.counts.suppressed + suppressed,
        },
        suppressedByReason: suppressed
          ? {
              ...campaign.suppressedByReason,
              future_appointment:
                (campaign.suppressedByReason.future_appointment ?? 0) +
                suppressed,
            }
          : campaign.suppressedByReason,
        attributedBookings: campaign.attributedBookings + (sent > 1 ? 1 : 0),
      });
    },
    get budget() {
      return budget;
    },
  };
}
