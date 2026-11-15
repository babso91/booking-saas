// A series of appointments she books for one client (M2-R07), as served
// (docs/APPOINTMENT_SERIES_CONTRACT.md). The planner takes its actions as a
// whole: the agenda gives it Cloud's Server Actions (real-actions.ts), the
// design preview and the tests an in-memory server.
//
// The preview books nothing. Confirming creates every kept occurrence or
// none: one failure fails the whole batch.

export type SeriesPreviewInput = {
  clientId: string;
  serviceId: string;
  optionChoiceIds: string[];
  /** Local wall-clock time in the business's time zone, "YYYY-MM-DDTHH:mm". */
  firstLocalStart: string;
  repeatEveryWeeks: number;
  end: { count: number } | { untilLocalDate: string };
};

export type OccurrenceState =
  "available" | "conflict" | "ambiguous" | "nonexistent" | "outside_horizon";

export type SeriesOccurrence = {
  /** Stable per series and rank. */
  key: string;
  requestedLocalStart: string;
  /**
   * available: one instant. ambiguous (clocks go back): two, earlier
   * first. nonexistent (clocks go forward): the server's suggested
   * replacement, if any. conflict / outside_horizon: the instant asked.
   */
  utcCandidates: string[];
  state: OccurrenceState;
};

export type SeriesPreview = {
  /** Proves the rule and choices the server computed this preview from. */
  previewVersion: string;
  timeZone: string;
  quote: { serviceName: string; durationMinutes: number; priceCents: number };
  occurrences: SeriesOccurrence[];
};

export type SeriesCommitInput = {
  requestId: string;
  previewVersion: string;
  selected: { key: string; startsAt: string }[];
};

export type SeriesResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; keys?: string[] } };

export type SeriesActions = {
  preview: (input: SeriesPreviewInput) => Promise<SeriesResult<SeriesPreview>>;
  commit: (
    input: SeriesCommitInput,
  ) => Promise<SeriesResult<{ seriesId: string; appointmentIds: string[] }>>;
};

/** Refusals handled by name (proposed codes). */
export const seriesErrors = {
  stale: "series_stale",
  quoteChanged: "quote_changed",
  calendarConflict: "calendar_conflict",
  tooMany: "too_many_occurrences",
} as const;

export const MAX_OCCURRENCES = 12;
