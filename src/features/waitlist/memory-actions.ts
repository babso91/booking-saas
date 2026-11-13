import type {
  JoinWaitlistInput,
  WaitlistActions,
  WaitlistOfferDto,
  WaitlistResult,
} from "./contract";
import { offerErrors } from "./contract";

// An in-memory server of the PROPOSED waitlist contract, for the design
// preview and the tests only: a request id answers once, an offer can be
// taken by someone else, expire, or change price. Nothing here reaches a
// database; never used by a real page.

const fail = (code: string): WaitlistResult<never> => ({
  ok: false,
  error: { code },
});

export function sampleOffer(
  over: Partial<WaitlistOfferDto> = {},
): WaitlistOfferDto {
  return {
    id: "offer-a",
    version: 1,
    state: "offered",
    serviceName: "Rehaussement de cils",
    startsAt: "2026-11-19T13:00:00.000Z",
    endsAt: "2026-11-19T14:15:00.000Z",
    localStartsAt: "2026-11-19T14:00",
    timezone: "Europe/Paris",
    businessName: "Atelier Maëlys",
    priceCents: 6000,
    durationMinutes: 75,
    currency: "EUR",
    quoteRevision: 1,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    requestActive: true,
    ...over,
  };
}

export function memoryWaitlist(
  start: { offer?: WaitlistOfferDto; pendingConfirmation?: boolean } = {},
  options: { delayMs?: number } = {},
) {
  const state = {
    offer: start.offer ?? sampleOffer(),
    joined: [] as JoinWaitlistInput[],
    /** Set to make the next claim lose a race (someone else booked). */
    takenElsewhere: false,
  };
  const answered = new Map<string, WaitlistResult<unknown>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  const actions: WaitlistActions = {
    async join(input) {
      await pause();
      const earlier = answered.get(input.requestId);
      if (earlier) return earlier as WaitlistResult<never>;
      state.joined.push(input);
      const result: WaitlistResult<{
        id: string;
        state: "pending_confirmation" | "active";
        activeUntil: string;
      }> = {
        ok: true,
        data: {
          id: `req-${state.joined.length}`,
          state: start.pendingConfirmation ? "pending_confirmation" : "active",
          activeUntil: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        },
      };
      answered.set(input.requestId, result);
      return result;
    },
    async offer(offerId) {
      await pause();
      if (offerId !== state.offer.id) return fail(offerErrors.notFound);
      const offer = state.offer;
      if (
        offer.state === "offered" &&
        Date.parse(offer.expiresAt) <= Date.now()
      )
        state.offer = {
          ...offer,
          state: "expired",
          version: offer.version + 1,
        };
      return { ok: true, data: { ...state.offer } };
    },
    async claim(input) {
      await pause();
      const earlier = answered.get(input.requestId);
      if (earlier) return earlier as WaitlistResult<WaitlistOfferDto>;
      const offer = state.offer;
      if (input.offerId !== offer.id) return fail(offerErrors.notFound);
      if (offer.state !== "offered") return fail(offerErrors.stale);
      if (Date.parse(offer.expiresAt) <= Date.now()) {
        state.offer = {
          ...offer,
          state: "expired",
          version: offer.version + 1,
        };
        return fail(offerErrors.expired);
      }
      if (state.takenElsewhere) {
        state.offer = {
          ...offer,
          state: "unavailable",
          version: offer.version + 1,
        };
        return fail(offerErrors.unavailable);
      }
      if (input.expectedQuoteRevision !== offer.quoteRevision)
        return fail(offerErrors.quoteChanged);
      if (input.expectedVersion !== offer.version)
        return fail(offerErrors.stale);
      state.offer = {
        ...offer,
        state: "booked",
        version: offer.version + 1,
        requestActive: false,
      };
      const result = { ok: true as const, data: { ...state.offer } };
      answered.set(input.requestId, result);
      return result;
    },
  };
  return { actions, state };
}
