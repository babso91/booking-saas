"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { onboardingGateway } from "@/features/auth/gateway";

import {
  getSlugIssue,
  slugIssueMessages,
  suggestSlugs,
  type SlugIssue,
} from "./slug";

export type SlugCheckState =
  | { kind: "empty" }
  | { kind: "invalid"; issue: SlugIssue; message: string }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken"; suggestions: string[] }
  | { kind: "reserved"; suggestions: string[] }
  | { kind: "unverified" };

type RemoteResult =
  | { kind: "available" }
  | { kind: "taken" | "reserved"; suggestions: string[] }
  | { kind: "unverified" };

const DEBOUNCE_MS = 400;

function toRemoteResult(
  response: Awaited<ReturnType<typeof onboardingGateway.checkSlug>>,
): RemoteResult {
  if (!response.ok) return { kind: "unverified" };
  if (response.data.availability === "available") return { kind: "available" };
  return {
    kind: response.data.availability,
    suggestions: response.data.suggestions,
  };
}

/**
 * Debounced, cancellable availability check. Only the latest slug counts:
 * results for older values are ignored, and "checking" is derived (not set
 * synchronously) so fast typing never flashes stale statuses.
 */
export function useSlugCheck(
  slug: string,
  context: { location?: string; firstName?: string },
) {
  const [results, setResults] = useState<Record<string, RemoteResult>>({});
  const issue = getSlugIssue(slug);
  const needsCheck = issue === null && !(slug in results);
  const contextRef = useRef(context);

  useEffect(() => {
    contextRef.current = context;
  });

  useEffect(() => {
    if (!needsCheck) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await onboardingGateway.checkSlug(slug, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        const result = toRemoteResult(response);
        setResults((current) => ({ ...current, [slug]: result }));
      } catch {
        // Aborted: a newer value is being checked.
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [slug, needsCheck]);

  // Backend said the slug was taken at submit time: trust it over the cache.
  const markTaken = useCallback((takenSlug: string) => {
    setResults((current) => ({
      ...current,
      [takenSlug]: {
        kind: "taken",
        suggestions: suggestSlugs(takenSlug, contextRef.current),
      },
    }));
  }, []);

  // Immediate check (no debounce) when the user wants to continue now.
  const checkNow = useCallback(
    async (value: string): Promise<SlugCheckState> => {
      const result = toRemoteResult(await onboardingGateway.checkSlug(value));
      setResults((current) => ({ ...current, [value]: result }));
      return result;
    },
    [],
  );

  // Network failure: allow a new attempt for the current value.
  const retry = useCallback(() => {
    setResults((current) => {
      const next = { ...current };
      delete next[slug];
      return next;
    });
  }, [slug]);

  let state: SlugCheckState;
  if (issue === "empty") state = { kind: "empty" };
  else if (issue === "reserved")
    state = { kind: "reserved", suggestions: suggestSlugs(slug, context) };
  else if (issue)
    state = { kind: "invalid", issue, message: slugIssueMessages[issue] };
  else state = results[slug] ?? { kind: "checking" };

  return { state, markTaken, retry, checkNow };
}
