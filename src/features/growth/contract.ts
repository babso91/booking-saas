// Rebooking and reactivation campaigns (R4-01). PROPOSED contract
// (docs/GROWTH_CAMPAIGNS_PROPOSAL.md): no server serves it yet, and no
// real message can leave: the transport is simulated until consent proof,
// unsubscribe, sender identity and budget are approved. The screens take
// their actions as a whole; only the design preview and the tests give
// them an in-memory server.

export type Channel = "email" | "sms";

/** Closed V1 criteria: no notes, answers, images or sensitive fields. */
export type AudienceCriteria =
  | {
      kind: "rebooking";
      /** Last completed visit of one of these services... */
      serviceIds: string[];
      /** ...at least this many days ago. */
      afterDays: number;
    }
  | {
      kind: "reactivation";
      /** No completed visit for at least this many days. */
      inactiveDays: number;
    };

export type SuppressionReason =
  | "future_appointment"
  | "no_consent"
  | "unreachable"
  | "recent_contact"
  | "last_visit_not_completed";

export type AudienceEstimate = {
  estimateId: string;
  /** Matching the criteria. */
  matched: number;
  /** Matching, reachable, consenting, not suppressed. */
  eligible: number;
  /** Aggregated only: never a client's name. */
  suppressedByReason: Partial<Record<SuppressionReason, number>>;
  estimatedUnits: number;
  estimateExpiresAt: string;
  timeZone: string;
  /** True while the transport is simulated: nothing really leaves. */
  simulated: boolean;
};

export type CampaignState =
  "scheduled" | "running" | "paused" | "completed" | "cancelled";

export type CampaignDto = {
  campaignId: string;
  version: number;
  state: CampaignState;
  channel: Channel;
  maxUnits: number;
  unitsUsed: number;
  counts: {
    /** Planned, not yet handed to the transport: a pause keeps them. */
    pending: number;
    /** Handed to the transport: may still arrive after a pause. */
    handedOff: number;
    /** Accepted by the provider (not proof of receipt). */
    accepted: number;
    /** Answer lost after handoff: never retried before reconciliation. */
    uncertain: number;
    failed: number;
    suppressed: number;
  };
  suppressedByReason: Partial<Record<SuppressionReason, number>>;
  /** Bookings carrying this campaign's reference within its window. */
  attributedBookings: number;
  attributionWindowDays: number;
  simulated: boolean;
};

export type GrowthResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type CampaignActions = {
  estimate: (input: {
    criteria: AudienceCriteria;
    channel: Channel;
    message: string;
  }) => Promise<GrowthResult<AudienceEstimate>>;
  schedule: (input: {
    estimateId: string;
    maxUnits: number;
    requestId: string;
  }) => Promise<GrowthResult<CampaignDto>>;
  read: (campaignId: string) => Promise<GrowthResult<CampaignDto>>;
  setState: (input: {
    campaignId: string;
    expectedVersion: number;
    requestId: string;
    action: "pause" | "resume" | "cancel";
  }) => Promise<GrowthResult<CampaignDto>>;
};

export const growthErrors = {
  estimateStale: "estimate_stale",
  quotaExceeded: "quota_exceeded",
  versionConflict: "version_conflict",
} as const;

export const reasonLabels: Record<SuppressionReason, string> = {
  future_appointment: "ont déjà un rendez-vous à venir",
  no_consent: "n’ont pas accepté ce type de message",
  unreachable: "n’ont pas de coordonnée pour ce canal",
  recent_contact: "ont été contactées récemment",
  last_visit_not_completed: "dernière visite annulée ou manquée",
};

/** SMS units for a message (GSM 160 / 153 per part; others 70 / 67). */
export function smsUnits(message: string) {
  if (!message) return 0;
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(
    message,
  );
  const [single, part] = gsm ? [160, 153] : [70, 67];
  return message.length <= single ? 1 : Math.ceil(message.length / part);
}
