// How many new clients come back (R4-01, measures). PROPOSED contract
// (docs/RETENTION_REPORT_PROPOSAL.md): no server serves it yet. The table
// takes its actions as a whole; only the design preview and the tests give
// it an in-memory server.
//
// Definition (versioned by the server): a cohort is the clients whose
// FIRST completed visit falls in a month; one "comes back" when a second
// visit is completed within the window after her first. Only cohorts whose
// window is fully observed get a rate. Completion date, not booking date;
// no amount paid is inferred from agenda prices.

export type CohortDto = {
  /** "2026-06": the month of the first completed visit, business time. */
  month: string;
  size: number;
  /** Second visit completed within the window (so far, if not observed). */
  returned: number;
  /** Every client's window has ended: the rate can be read. */
  fullyObserved: boolean;
};

export type RetentionReportDto = {
  definitionVersion: string;
  windowDays: 30 | 60 | 90;
  asOf: string;
  timeZone: string;
  /** Below this size, a rate is not shown: too few clients to mean much. */
  minCohortSize: number;
  cohorts: CohortDto[];
};

export type RetentionResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type RetentionActions = {
  read: (input: {
    windowDays: RetentionReportDto["windowDays"];
  }) => Promise<RetentionResult<RetentionReportDto>>;
};

export type CohortReading =
  { kind: "rate"; rate: number } | { kind: "immature" } | { kind: "too_small" };

/** What a row may honestly say. */
export function readCohort(cohort: CohortDto, minSize: number): CohortReading {
  if (!cohort.fullyObserved) return { kind: "immature" };
  if (cohort.size < minSize) return { kind: "too_small" };
  return { kind: "rate", rate: cohort.returned / cohort.size };
}

/**
 * The rate over every readable cohort, weighted by size; null when none
 * is readable (never an average of immature or tiny cohorts).
 */
export function overallRate(report: RetentionReportDto) {
  const readable = report.cohorts.filter(
    (c) => readCohort(c, report.minCohortSize).kind === "rate",
  );
  const size = readable.reduce((sum, c) => sum + c.size, 0);
  if (!size) return null;
  return {
    rate: readable.reduce((sum, c) => sum + c.returned, 0) / size,
    cohorts: readable.length,
    clients: size,
  };
}

export const percent = (value: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);

/** "juin 2026". */
export const monthName = (month: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-15T12:00:00.000Z`));
