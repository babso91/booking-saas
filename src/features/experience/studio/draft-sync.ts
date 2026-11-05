"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UiError, UiResult } from "@/features/auth/client/call-action";
import type { SiteConfig as SavedConfig } from "@/features/sites/config";

import type { SiteConfig } from "../engine/config";
import { renderConfigOf } from "../engine/from-site";
import { canonical } from "./canonical";
import { savedConfigOf } from "./saved";

// Her draft, saved by itself (docs/SITE_PUBLISHING_CONTRACT.md § 2, § 6,
// § 7). Every change is sent a moment after she stops, on the revision it
// was based on; never two at once. The server answers a new revision, or:
//
// - stale_site_draft: her draft changed elsewhere (another tab, another
//   device). Nothing is overwritten and nothing of hers is dropped: what
//   is saved now is read, and she chooses — keep hers (sent again on that
//   revision) or take the saved one. A resend of what is already saved is
//   no conflict (the server answers it as done).
// - any other refusal or a lost answer: said, her changes kept, sent again
//   on her retry (or her next change).

export const SAVE_DELAY_MS = 900;

export type DraftStatus =
  | { kind: "saved" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "error"; error: UiError }
  /** Changed elsewhere: the saved draft, to keep hers or take it. */
  | { kind: "conflict"; theirs: SiteConfig; revision: number };

type Saved = { revision: number; json: string };

export function useDraftSync({
  value,
  revision: initialRevision,
  saved: initialSaved,
  save,
  read,
  replace,
}: {
  /** Her draft as the studio holds it. */
  value: SiteConfig;
  /** The revision her draft was read at (0: none saved yet). */
  revision: number;
  /** What the server holds at that revision (null: nothing yet). */
  saved: SavedConfig | null;
  save: (
    expectedRevision: number,
    config: SavedConfig,
  ) => Promise<UiResult<{ revision: number }>>;
  read: () => Promise<
    UiResult<{ revision: number; config: SavedConfig | null } | null>
  >;
  /** Puts the saved draft in her studio (she took it). */
  replace: (config: SiteConfig) => void;
}) {
  const last = useRef<Saved>({
    revision: initialRevision,
    json: initialSaved ? canonical(initialSaved) : "",
  });
  const [status, setStatus] = useState<DraftStatus>({ kind: "saved" });
  /** What the server holds, as rendered state (last.current, for actions). */
  const [savedJson, setSavedJson] = useState(() =>
    initialSaved ? canonical(initialSaved) : "",
  );
  const [revision, setRevision] = useState(initialRevision);
  const inFlight = useRef<Promise<number | null> | null>(null);
  const latest = useRef(value);
  const alive = useRef(true);
  useEffect(() => {
    latest.current = value;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const outgoing = (config: SiteConfig) => savedConfigOf(config);
  const dirty = canonical(outgoing(value)) !== savedJson;
  const blocked = status.kind === "conflict";
  /** Waiting for her to stop, or her next save. */
  const shown: DraftStatus =
    status.kind === "saved" && dirty ? { kind: "pending" } : status;

  /**
   * Sends her draft now (if it differs from what is saved), or `now`.
   * Resolves to
   * the revision it is saved at, or null when it is not (said in status).
   */
  const flush = useCallback(
    (now?: SiteConfig): Promise<number | null> => {
      if (inFlight.current) return inFlight.current;
      // `now`: a draft just set (publishing), not rendered yet.
      const config = outgoing(now ?? latest.current);
      const json = canonical(config);
      if (json === last.current.json && last.current.revision > 0)
        return Promise.resolve(last.current.revision);
      const run = (async () => {
        setStatus({ kind: "saving" });
        const result = await save(last.current.revision, config);
        if (!alive.current) return null;
        if (result.ok) {
          last.current = { revision: result.data.revision, json };
          setSavedJson(json);
          setRevision(result.data.revision);
          const more =
            canonical(outgoing(latest.current)) !== last.current.json;
          // More since: the wait below starts again (savedJson changed).
          setStatus({ kind: more ? "pending" : "saved" });
          return result.data.revision;
        }
        if (result.error.code === "stale_site_draft") {
          const now = await read();
          if (!alive.current) return null;
          if (!now.ok) {
            setStatus({ kind: "error", error: now.error });
            return null;
          }
          const theirs = now.data;
          if (!theirs?.config) {
            setStatus({ kind: "error", error: result.error });
            return null;
          }
          setStatus({
            kind: "conflict",
            theirs: renderConfigOf(theirs.config),
            revision: theirs.revision,
          });
          return null;
        }
        setStatus({ kind: "error", error: result.error });
        return null;
      })();
      inFlight.current = run;
      void run.finally(() => {
        inFlight.current = null;
      });
      return run;
    },
    [read, save],
  );

  // A moment after she stops changing it, while nothing blocks.
  useEffect(() => {
    if (!dirty || blocked || status.kind === "error") return;
    const timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each change restarts the wait
  }, [value, blocked, status.kind, savedJson]);

  // Leaving with changes not saved yet: the browser asks first.
  useEffect(() => {
    if (!dirty && status.kind !== "conflict") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, status.kind]);

  return {
    status: shown,
    revision,
    dirty,
    flush,
    /** After an error: send her draft again. */
    retry: () => {
      setStatus({ kind: "pending" });
      void flush();
    },
    /** Conflict: her draft wins, sent on the revision saved meanwhile. */
    keepMine: () => {
      if (status.kind !== "conflict") return;
      last.current = { revision: status.revision, json: "" };
      setSavedJson("");
      setRevision(status.revision);
      setStatus({ kind: "pending" });
      void flush();
    },
    /** Conflict: the saved draft replaces hers in the studio. */
    takeTheirs: () => {
      if (status.kind !== "conflict") return;
      const json = canonical(outgoing(status.theirs));
      last.current = { revision: status.revision, json };
      setSavedJson(json);
      setRevision(status.revision);
      replace(status.theirs);
      setStatus({ kind: "saved" });
    },
    /** Another draft the server now holds (a restored version). */
    adopt: (config: SavedConfig, at: number) => {
      last.current = { revision: at, json: canonical(config) };
      setSavedJson(canonical(config));
      setRevision(at);
      replace(renderConfigOf(config));
      setStatus({ kind: "saved" });
    },
  };
}
