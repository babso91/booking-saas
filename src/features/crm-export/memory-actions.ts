import {
  exportErrors,
  type CrmExportActions,
  type ExportJobDto,
  type ExportResult,
} from "./contract";

// An in-memory server of the PROPOSED export contract, for the preview and
// the tests only. No file is produced: "download" hands back a fake link
// the preview never opens.

const fail = (code: string): ExportResult<never> => ({
  ok: false,
  error: { code },
});

export function memoryCrmExport(
  options: {
    delayMs?: number;
    now?: () => number;
    role?: "owner" | "practitioner";
  } = {},
) {
  const jobs: ExportJobDto[] = [];
  const answered = new Map<string, ExportResult<ExportJobDto>>();
  let role = options.role ?? "owner";
  const now = options.now ?? (() => Date.parse("2026-11-14T10:00:00.000Z"));
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  const expire = () => {
    for (const job of jobs)
      if (
        job.status === "ready" &&
        job.expiresAt &&
        Date.parse(job.expiresAt) <= now()
      )
        job.status = "expired";
  };

  const actions: CrmExportActions = {
    async list() {
      await pause();
      expire();
      return { ok: true, data: structuredClone(jobs) };
    },
    async request({ scope, requestId }) {
      await pause();
      const earlier = answered.get(requestId);
      if (earlier) return earlier;
      if (role !== "owner") return fail(exportErrors.permissionDenied);
      if (jobs.some((job) => job.status === "requested"))
        return fail(exportErrors.inProgress);
      const job: ExportJobDto = {
        jobId: `exp-${jobs.length + 1}`,
        scope,
        status: "requested",
        requestedAt: new Date(now()).toISOString(),
        expiresAt: null,
        rowCount: null,
      };
      jobs.unshift(job);
      const result = { ok: true as const, data: structuredClone(job) };
      answered.set(requestId, result);
      return result;
    },
    async download(jobId) {
      await pause();
      expire();
      // The role is checked again at every download.
      if (role !== "owner") return fail(exportErrors.permissionDenied);
      const job = jobs.find((item) => item.jobId === jobId);
      if (!job || job.status !== "ready") return fail(exportErrors.expired);
      return { ok: true, data: { url: `about:blank#${jobId}` } };
    },
    async revoke(jobId) {
      await pause();
      const job = jobs.find((item) => item.jobId === jobId);
      if (!job) return fail("not_found");
      job.status = "revoked";
      job.expiresAt = null;
      return { ok: true, data: structuredClone(job) };
    },
  };
  return {
    actions,
    /** The worker finishes the oldest pending export (tests and preview only). */
    finish(rowCount = 128) {
      const job = [...jobs]
        .reverse()
        .find((item) => item.status === "requested");
      if (!job) return;
      job.status = "ready";
      job.rowCount = rowCount;
      job.expiresAt = new Date(now() + 24 * 3_600_000).toISOString();
    },
    setRole(next: "owner" | "practitioner") {
      role = next;
    },
  };
}
