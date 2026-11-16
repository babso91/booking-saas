import type {
  ReferralActions,
  ReferralLinkDto,
  TierProgressDto,
  TierResult,
} from "./contract";

// In-memory stand-ins of the PROPOSED tiers and referral contract, for the
// design preview and the tests only. Never used by a real page.

export function sampleProgress(
  over: Partial<TierProgressDto> = {},
): TierProgressDto {
  return {
    tiers: [
      { id: "t-silver", name: "Argent", threshold: 3, perk: null },
      { id: "t-gold", name: "Or", threshold: 6, perk: "Un soin offert par an" },
      {
        id: "t-diamond",
        name: "Diamant",
        threshold: 10,
        perk: "Priorité sur les créneaux libérés",
      },
    ],
    tierId: "t-silver",
    currentValue: 4,
    windowEnd: "2027-06-30T22:00:00.000Z",
    ruleVersion: 1,
    ...over,
  };
}

export function memoryReferral(
  start: ReferralLinkDto | null = null,
  options: { delayMs?: number } = {},
) {
  const state = { link: start, created: 0 };
  const answered = new Map<string, TierResult<ReferralLinkDto>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  const actions: ReferralActions = {
    async current() {
      await pause();
      return { ok: true, data: state.link ? { ...state.link } : null };
    },
    async create({ requestId }) {
      await pause();
      const earlier = answered.get(requestId);
      if (earlier) return earlier;
      state.created += 1;
      state.link = {
        url: `https://booking.app/b/atelier-maelys?parrain=demo${state.created}`,
        expiresAt: "2027-02-14T23:00:00.000Z",
        state: "active",
      };
      const result = { ok: true as const, data: { ...state.link } };
      answered.set(requestId, result);
      return result;
    },
  };
  return { actions, state };
}
