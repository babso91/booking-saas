import "server-only";

import { after } from "next/server";

import { logCalendar } from "./log";

/**
 * Runs calendar work after the response was sent (Next.js `after`): a
 * provider webhook or a professional's request never waits for a sync.
 */
export function runAfterResponse(
  operation: string,
  task: () => Promise<unknown>,
) {
  after(async () => {
    try {
      await task();
    } catch {
      logCalendar("background_failed", { code: operation }, "error");
    }
  });
}
