"use client";

import Link from "next/link";
import { useMemo } from "react";

import { readRetentionAction } from "./actions";
import type { RetentionActions } from "./contract";
import { RetentionTable } from "./retention-table";

// The retention table on the real report (public.crm_retention_report).
// A lost answer reads as a network error, never as an empty report.

export function RetentionScreen() {
  const actions = useMemo<RetentionActions>(
    () => ({
      async read(input) {
        try {
          const result = await readRetentionAction(input);
          return result.ok
            ? result
            : { ok: false, error: { code: result.error.code } };
        } catch {
          return { ok: false, error: { code: "network" } };
        }
      },
    }),
    [],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-8">
        <Link
          href="/app/loyalty"
          className="w-fit text-[13.5px] font-medium text-ink-soft underline decoration-line underline-offset-4"
        >
          ← Fidélité
        </Link>
        <RetentionTable actions={actions} />
      </div>
    </div>
  );
}
