"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { callAction } from "@/features/auth/client/call-action";
import { checkSlugAction } from "@/features/onboarding/actions/onboarding";

import {
  getSlugIssue,
  slugify,
  slugIssueMessages,
  suggestSlugs,
  type SlugIssue,
} from "./slug";

export type SlugCheckState =
  | { kind: "empty" }
  | { kind: "invalid"; issue?: SlugIssue; message: string }
  | { kind: "checking"; slug: string }
  | { kind: "available"; slug: string }
  | { kind: "taken"; slug: string; suggestions: string[] }
  | { kind: "reserved"; slug: string; suggestions: string[] }
  | { kind: "unverified"; slug: string };

type ServerResult =
  | { kind: "available" | "taken" | "reserved" | "invalid"; slug: string }
  | { kind: "unverified"; slug: string };

const DEBOUNCE_MS = 400;
const MAX_SUGGESTIONS = 3;

async function checkOnServer(slug: string): Promise<ServerResult> {
  const result = await callAction(() => checkSlugAction({ slug }));
  if (!result.ok) return { kind: "unverified", slug };
  return { kind: result.data.reason, slug: result.data.slug };
}

/**
 * Debounced availability check through checkSlugAction (a UX pre-check: the
 * unique constraint decides at completion). Results are keyed by the
 * previewed slug, so answers for older values never show; "checking" is
 * derived rather than set, so fast typing never flashes stale statuses.
 * Suggestions are verified with the server before being offered.
 */
export function useSlugCheck(
  input: string,
  context: { location?: string; firstName?: string },
) {
  const slug = slugify(input);
  const issue = getSlugIssue(input);
  const [results, setResults] = useState<Record<string, ServerResult>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const contextRef = useRef(context);
  const needsCheck = issue === null && !(slug in results);

  useEffect(() => {
    contextRef.current = context;
  });

  const store = useCallback((key: string, result: ServerResult) => {
    setResults((current) => ({ ...current, [key]: result }));
  }, []);

  // Checks candidates in parallel and keeps the ones the server accepts.
  const loadSuggestions = useCallback(
    async (key: string) => {
      const candidates = suggestSlugs(key, contextRef.current).slice(
        0,
        MAX_SUGGESTIONS + 1,
      );
      const checked = await Promise.all(candidates.map(checkOnServer));
      checked.forEach((result) => store(result.slug, result));
      setSuggestions((current) => ({
        ...current,
        [key]: checked
          .filter((result) => result.kind === "available")
          .map((result) => result.slug)
          .slice(0, MAX_SUGGESTIONS),
      }));
    },
    [store],
  );

  useEffect(() => {
    if (!needsCheck) return;

    let active = true;
    const timer = window.setTimeout(async () => {
      const result = await checkOnServer(slug);
      if (!active) return;
      store(slug, result);
      if (result.kind === "taken" || result.kind === "reserved")
        void loadSuggestions(slug);
    }, DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [slug, needsCheck, store, loadSuggestions]);

  /** Immediate check (no debounce) when the user wants to continue now. */
  const checkNow = useCallback(async (): Promise<SlugCheckState> => {
    const result = await checkOnServer(slug);
    store(slug, result);
    if (result.kind === "taken" || result.kind === "reserved")
      void loadSuggestions(slug);
    return toState(result, []);
  }, [slug, store, loadSuggestions]);

  /** completeOnboarding answered slug_taken / slug_reserved: trust it. */
  const markUnavailable = useCallback(
    (unavailable: string, kind: "taken" | "reserved") => {
      store(unavailable, { kind, slug: unavailable });
      void loadSuggestions(unavailable);
    },
    [store, loadSuggestions],
  );

  /** Network failure: allow a new attempt for the current value. */
  const retry = useCallback(() => {
    setResults((current) => {
      const next = { ...current };
      delete next[slug];
      return next;
    });
  }, [slug]);

  let state: SlugCheckState;
  if (issue === "empty") state = { kind: "empty" };
  else if (issue)
    state = { kind: "invalid", issue, message: slugIssueMessages[issue] };
  else {
    const result = results[slug];
    state = result
      ? toState(result, suggestions[slug] ?? [])
      : { kind: "checking", slug };
  }

  return { state, checkNow, markUnavailable, retry };
}

function toState(result: ServerResult, suggestions: string[]): SlugCheckState {
  switch (result.kind) {
    case "available":
    case "unverified":
      return { kind: result.kind, slug: result.slug };
    case "taken":
    case "reserved":
      return { kind: result.kind, slug: result.slug, suggestions };
    case "invalid":
      return {
        kind: "invalid",
        message: "Ce lien n’est pas valide. Essaie une variante.",
      };
  }
}
