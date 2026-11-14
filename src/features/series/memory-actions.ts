import {
  MAX_OCCURRENCES,
  seriesErrors,
  type SeriesActions,
  type SeriesOccurrence,
  type SeriesPreviewInput,
  type SeriesResult,
} from "./contract";
import { addWeeks, instantsOf } from "./local-time";

// An in-memory server of the PROPOSED series contract, for the preview and
// the tests only: real wall-clock resolution in the business's time zone,
// a horizon, busy slots, all-or-nothing commit, a replayed request id.

const fail = (code: string, keys?: string[]): SeriesResult<never> => ({
  ok: false,
  error: keys ? { code, keys } : { code },
});

export function memorySeries(
  options: {
    timeZone?: string;
    /** Last local date a series may reach, "YYYY-MM-DD". */
    horizon?: string;
    /** UTC instants already taken. */
    busy?: string[];
    delayMs?: number;
  } = {},
) {
  const timeZone = options.timeZone ?? "Europe/Paris";
  const horizon = options.horizon ?? "2027-01-31";
  const busy = new Set(options.busy ?? []);
  const proposals = new Map<string, SeriesOccurrence[]>();
  const repriced = new Set<string>();
  const receipts = new Map<
    string,
    { payload: string; result: SeriesResult<never> | Committed }
  >();
  const created: { seriesId: string; startsAt: string[] }[] = [];
  let quotePrice = 6500;
  let count = 0;
  type Committed = {
    ok: true;
    data: { seriesId: string; appointmentIds: string[] };
  };
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  function occurrencesOf(input: SeriesPreviewInput) {
    const locals: string[] = [];
    for (let rank = 0; locals.length < MAX_OCCURRENCES + 1; rank += 1) {
      const local = addWeeks(
        input.firstLocalStart,
        rank * input.repeatEveryWeeks,
      );
      if ("count" in input.end && rank >= input.end.count) break;
      if (
        "untilLocalDate" in input.end &&
        local.slice(0, 10) > input.end.untilLocalDate
      )
        break;
      locals.push(local);
    }
    return locals.map((local, rank): SeriesOccurrence => {
      const key = `occ-${rank + 1}`;
      const instants = instantsOf(local, timeZone);
      if (local.slice(0, 10) > horizon)
        return {
          key,
          requestedLocalStart: local,
          utcCandidates: instants,
          state: "outside_horizon",
        };
      if (instants.length === 0) {
        // Clocks go forward: suggest the same time one hour later.
        const later = `${local.slice(0, 11)}${String(Number(local.slice(11, 13)) + 1).padStart(2, "0")}${local.slice(13)}`;
        return {
          key,
          requestedLocalStart: local,
          utcCandidates: instantsOf(later, timeZone).slice(0, 1),
          state: "nonexistent",
        };
      }
      if (instants.length > 1)
        return {
          key,
          requestedLocalStart: local,
          utcCandidates: instants,
          state: "ambiguous",
        };
      return {
        key,
        requestedLocalStart: local,
        utcCandidates: instants,
        state: busy.has(instants[0]!) ? "conflict" : "available",
      };
    });
  }

  const actions: SeriesActions = {
    async preview(input) {
      await pause();
      const occurrences = occurrencesOf(input);
      if (occurrences.length > MAX_OCCURRENCES)
        return fail(seriesErrors.tooMany);
      const previewVersion = `pv-${(count += 1)}`;
      proposals.set(previewVersion, occurrences);
      return {
        ok: true,
        data: {
          previewVersion,
          timeZone,
          quote: {
            serviceName: "Remplissage gel",
            durationMinutes: 75,
            priceCents: quotePrice,
          },
          occurrences,
        },
      };
    },
    async commit(input) {
      await pause();
      const payload = JSON.stringify([input.previewVersion, input.selected]);
      const earlier = receipts.get(input.requestId);
      if (earlier)
        return earlier.payload === payload
          ? earlier.result
          : fail("idempotency_conflict");
      if (repriced.has(input.previewVersion))
        return fail(seriesErrors.quoteChanged);
      const proposal = proposals.get(input.previewVersion);
      if (!proposal) return fail(seriesErrors.stale);
      if (!input.selected.length) return fail("nothing_selected");
      for (const pick of input.selected) {
        const occurrence = proposal.find((item) => item.key === pick.key);
        if (
          !occurrence ||
          occurrence.state === "conflict" ||
          occurrence.state === "outside_horizon" ||
          !occurrence.utcCandidates.includes(pick.startsAt)
        )
          return fail(seriesErrors.stale);
      }
      const taken = input.selected.filter((pick) => busy.has(pick.startsAt));
      if (taken.length)
        return fail(
          seriesErrors.calendarConflict,
          taken.map((pick) => pick.key),
        );
      const seriesId = `series-${created.length + 1}`;
      const startsAt = input.selected.map((pick) => pick.startsAt);
      startsAt.forEach((instant) => busy.add(instant));
      created.push({ seriesId, startsAt });
      const result: Committed = {
        ok: true,
        data: {
          seriesId,
          appointmentIds: startsAt.map(
            (_, index) => `${seriesId}-a${index + 1}`,
          ),
        },
      };
      receipts.set(input.requestId, { payload, result });
      return result;
    },
  };
  return {
    actions,
    created,
    /** Someone takes a slot meanwhile (tests and preview only). */
    take(instant: string) {
      busy.add(instant);
    },
    /** The service's price changes: earlier previews are stale. */
    changeQuote(priceCents: number) {
      quotePrice = priceCents;
      for (const version of proposals.keys()) repriced.add(version);
    },
  };
}
