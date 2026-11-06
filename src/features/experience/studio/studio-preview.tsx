"use client";

import { useState } from "react";

import type { UiErrorCode } from "@/features/auth/client/call-action";
import type { SitePlan } from "@/features/sites/data/sites";

import type { ShowcaseGroup } from "../catalog/model";
import { memoryStudioActions } from "./memory-actions";
import { firstDraft, savedConfigOf } from "./saved";
import { SiteStudio } from "./site-studio";
import { universes } from "./universes";

// Fixed, so the server and the client render the same page.
const PUBLISHED_AT = "2026-11-05T10:00:00.000Z";

/** Her studio on an in-memory server: the design preview, never a real site. */
export function StudioPreview({
  plan,
  published,
  conflict,
  photoError,
  catalog,
  fontClasses,
}: {
  plan: SitePlan;
  published: boolean;
  conflict: boolean;
  photoError?: string;
  catalog: ShowcaseGroup[];
  fontClasses: string;
}) {
  const [start] = useState(() =>
    published || conflict
      ? savedConfigOf(firstDraft(universes.mila, "Atelier Mila"))
      : null,
  );
  const [actions] = useState(() =>
    memoryStudioActions({
      plan,
      start,
      published,
      conflict,
      photoError: photoError as UiErrorCode | undefined,
    }),
  );
  return (
    <SiteStudio
      site={
        start
          ? {
              plan,
              revision: 1,
              schemaVersion: 1,
              config: start,
              restoredFrom: null,
              updatedAt: null,
              published: published
                ? { versionId: "v1", number: 1, publishedAt: PUBLISHED_AT }
                : null,
            }
          : null
      }
      online={
        published && start
          ? { config: start, number: 1, publishedAt: PUBLISHED_AT }
          : null
      }
      plan={plan}
      catalog={catalog}
      businessName="Atelier Mila"
      slug="atelier-mila"
      photos={[]}
      fontClasses={fontClasses}
      actions={actions}
    />
  );
}
