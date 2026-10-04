import { describe, expect, it } from "vitest";

import { describeSyncStatus } from "./sync-status-copy";

describe("describeSyncStatus", () => {
  it("an error or an incomplete sync wins over an untrusted zone", () => {
    for (const syncStatus of ["error", "incomplete"] as const) {
      expect(
        describeSyncStatus({
          syncStatus,
          timezoneTrusted: false,
          lastError: "provider_unavailable",
        }).label,
      ).not.toMatch(/marge/);
    }
  });

  it("explains the margin: unknown zone, or approximate events in a trusted calendar", () => {
    expect(
      describeSyncStatus({
        syncStatus: "degraded",
        timezoneTrusted: false,
        lastError: "untrusted_timezone",
      }),
    ).toMatchObject({
      label: "Synchronisé avec une marge : fuseau horaire non reconnu",
      healthy: false,
    });
    expect(
      describeSyncStatus({
        syncStatus: "degraded",
        timezoneTrusted: true,
        lastError: "approximate_events",
      }),
    ).toMatchObject({ label: "Synchronisé avec une marge", healthy: false });
    expect(
      describeSyncStatus({
        syncStatus: "synced",
        timezoneTrusted: true,
        lastError: null,
      }).healthy,
    ).toBe(true);
  });
});
