import type {
  CohortDto,
  RetentionActions,
  RetentionReportDto,
} from "./contract";

// An in-memory server of the PROPOSED retention report, for the preview and
// the tests only: fixed figures at a fixed date (14 November 2026). The
// later a cohort, the fewer of its windows have ended.

const base: {
  month: string;
  size: number;
  back: Record<30 | 60 | 90, number>;
}[] = [
  { month: "2026-05", size: 18, back: { 30: 5, 60: 8, 90: 10 } },
  { month: "2026-06", size: 22, back: { 30: 6, 60: 11, 90: 13 } },
  { month: "2026-07", size: 4, back: { 30: 1, 60: 2, 90: 2 } },
  { month: "2026-08", size: 25, back: { 30: 9, 60: 12, 90: 14 } },
  { month: "2026-09", size: 19, back: { 30: 7, 60: 9, 90: 9 } },
  { month: "2026-10", size: 21, back: { 30: 4, 60: 4, 90: 4 } },
];

// Last day of each month's window end vs 14 November 2026.
const observed = (month: string, windowDays: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const lastFirstVisit = Date.UTC(y, m, 0); // last day of the month
  return (
    lastFirstVisit + windowDays * 86_400_000 <=
    Date.parse("2026-11-14T00:00:00.000Z")
  );
};

export function memoryRetention(
  options: { delayMs?: number; empty?: boolean; failFirst?: boolean } = {},
) {
  let calls = 0;
  const actions: RetentionActions = {
    async read({ windowDays }) {
      if (options.delayMs)
        await new Promise((r) => setTimeout(r, options.delayMs));
      calls += 1;
      if (options.failFirst && calls === 1)
        return { ok: false, error: { code: "network" } };
      const cohorts: CohortDto[] = options.empty
        ? []
        : base.map((row) => ({
            month: row.month,
            size: row.size,
            returned: row.back[windowDays],
            fullyObserved: observed(row.month, windowDays),
          }));
      const report: RetentionReportDto = {
        definitionVersion: "retention-v1",
        windowDays,
        asOf: "2026-11-14T00:00:00.000Z",
        timeZone: "Europe/Paris",
        minCohortSize: 10,
        cohorts,
      };
      return { ok: true, data: report };
    },
  };
  return { actions };
}
