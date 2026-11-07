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
//
// Saves run one after the other, in the order asked: `flush(config)`
// waits for whatever is in flight, then sends `config` itself on the
// revision saved by then, and answers the revision at which THAT draft is
// saved (null if it is not). Publishing relies on it: it never receives
// the revision of an earlier draft than the one it shows.
//
// Leaving the studio inside the app (a link, Back) unmounts it without any
// `beforeunload`: what is not saved yet is sent at once, and the studio's
// own links wait for it (useLeave in site-studio.tsx).

export const SAVE_DELAY_MS = 900;

const outgoing = (config: SiteConfig) => savedConfigOf(config);

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
  /** The last save asked: each one starts when the one before is done. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** A conflict waits for her choice: nothing is sent until then. */
  const conflicted = useRef(false);
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

  const dirty = canonical(outgoing(value)) !== savedJson;
  const blocked = status.kind === "conflict";
  /** Waiting for her to stop, or her next save. */
  const shown: DraftStatus =
    status.kind === "saved" && dirty ? { kind: "pending" } : status;

  /** One save, once the previous ones are done: `config` itself. */
  const attempt = useCallback(
    async (config: SavedConfig): Promise<number | null> => {
      if (conflicted.current) return null;
      const json = canonical(config);
      if (json === last.current.json && last.current.revision > 0)
        return last.current.revision;
      if (alive.current) setStatus({ kind: "saving" });
      const result = await save(last.current.revision, config);
      if (result.ok) {
        // Kept even once she has left: a later save starts from it.
        last.current = { revision: result.data.revision, json };
        if (!alive.current) return result.data.revision;
        setSavedJson(json);
        setRevision(result.data.revision);
        const more = canonical(outgoing(latest.current)) !== json;
        // More since: the wait below starts again (savedJson changed).
        setStatus({ kind: more ? "pending" : "saved" });
        return result.data.revision;
      }
      if (!alive.current) return null;
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
        conflicted.current = true;
        setStatus({
          kind: "conflict",
          theirs: renderConfigOf(theirs.config),
          revision: theirs.revision,
        });
        return null;
      }
      setStatus({ kind: "error", error: result.error });
      return null;
    },
    [read, save],
  );

  /**
   * Saves her draft as it is now, or `now` (a draft just set, not rendered
   * yet), after any save in flight. Resolves to the revision at which this
   * very draft is saved, or null when it is not (said in status).
   */
  const flush = useCallback(
    (now?: SiteConfig): Promise<number | null> => {
      const run = queue.current.then(() =>
        attempt(outgoing(now ?? latest.current)),
      );
      queue.current = run.catch(() => null);
      return run;
    },
    [attempt],
  );

  // Unmounted inside the app (a link, Back): no beforeunload is fired, so
  // what is not saved yet is sent now. Nothing is said any more, but the
  // save goes through (and only to her business: actions.ts).
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
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
    /** Something of hers is not saved yet (or is being saved). */
    unsaved: dirty || status.kind === "saving" || status.kind === "conflict",
    flush,
    /** After an error: send her draft again. */
    retry: () => {
      setStatus({ kind: "pending" });
      void flush();
    },
    /** Conflict: her draft wins, sent on the revision saved meanwhile. */
    keepMine: () => {
      if (status.kind !== "conflict") return;
      conflicted.current = false;
      last.current = { revision: status.revision, json: "" };
      setSavedJson("");
      setRevision(status.revision);
      setStatus({ kind: "pending" });
      void flush();
    },
    /** Conflict: the saved draft replaces hers in the studio. */
    takeTheirs: () => {
      if (status.kind !== "conflict") return;
      conflicted.current = false;
      const json = canonical(outgoing(status.theirs));
      last.current = { revision: status.revision, json };
      setSavedJson(json);
      setRevision(status.revision);
      replace(status.theirs);
      setStatus({ kind: "saved" });
    },
    /** Another draft the server now holds (a restored version). */
    adopt: (config: SavedConfig, at: number) => {
      conflicted.current = false;
      last.current = { revision: at, json: canonical(config) };
      setSavedJson(canonical(config));
      setRevision(at);
      replace(renderConfigOf(config));
      setStatus({ kind: "saved" });
    },
  };
}
