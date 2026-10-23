"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ClientHubProfileDto } from "@/features/client-hub/types";

import { endSession, fetchProfile, type HubError, type HubResult } from "./api";

// The customer's session as the hub's screens see it. The cookie itself is
// HttpOnly and scoped to /api/client-hub: the only way to know who is signed
// in is to ask GET /api/client-hub/me, which this provider does.
//
// Isolation: every identity shown (a sign-in, a sign-out, an expiry, another
// customer signed in from another tab) gets a new `generation`. The screens
// are remounted under it (nothing typed, opened or read is kept), and every
// answer to a request started under an older generation is dropped,
// including a late 401, which can never sign out the newer session.
//
// Verification: the cookie may change in another tab without any message
// reaching this one. So when the tab is left, her data is veiled at once
// (`check: "pending"`), and shown again only once GET /me confirms who is
// signed in: the same customer gets her screens back as she left them;
// another one gets fresh screens; no answer keeps the veil, with a retry.

export type SignedOutReason = "expired" | "signed-out" | "elsewhere" | null;

export type HubSession =
  | { status: "checking"; generation: number }
  | { status: "signed-out"; generation: number; reason: SignedOutReason }
  | {
      status: "signed-in";
      generation: number;
      profile: ClientHubProfileDto;
      /**
       * `ok`: her identity is confirmed, her data may be shown. `pending`:
       * being checked again (data veiled). `failed`: it could not be checked
       * (data stays veiled, a retry is offered); not an expiry.
       */
      check: "ok" | "pending" | "failed";
    }
  | { status: "error"; generation: number; error: HubError };

type HubContext = {
  session: HubSession;
  /** Reads who is signed in again (keeps the screens if nothing changed). */
  recheck: () => void;
  /** Veils her data and confirms who is signed in before showing it again. */
  verify: () => void;
  /** A code was just verified: a new identity. */
  signedIn: (session: { email: string; expiresAt: string }) => void;
  /** A read of `generation` answered 401: that session is over. */
  expire: (generation: number) => void;
  /** Whether answers of `generation` may still be shown. */
  isCurrent: (generation: number) => boolean;
  signOut: (all: boolean) => Promise<HubResult<{ ended: true }>>;
};

const Context = createContext<HubContext | null>(null);

const CHANNEL = "client-hub-session";
type Message = { type: "signed-in" | "signed-out" };

/** Longest timer the browser keeps (about 24 days). */
const MAX_TIMER = 2_147_483_647;

export function ClientHubSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [session, setSession] = useState<HubSession>({
    status: "checking",
    generation: 0,
  });
  const generation = useRef(0);
  const current = useRef<HubSession>(session);
  const checks = useRef(0);
  const expiresAt = useRef<number | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const apply = useCallback((next: HubSession) => {
    generation.current = next.generation;
    current.current = next;
    setSession(next);
  }, []);

  /** A new identity (or none): everything shown so far is dropped. */
  const advance = useCallback(
    (
      next:
        | { status: "checking" }
        | { status: "signed-out"; reason: SignedOutReason }
        | { status: "signed-in"; profile: ClientHubProfileDto; check: "ok" }
        | { status: "error"; error: HubError },
    ) => {
      apply({ ...next, generation: generation.current + 1 } as HubSession);
    },
    [apply],
  );

  /** Hides her data until the next check confirms who is signed in. */
  const veil = useCallback(() => {
    const now = current.current;
    if (now.status === "signed-in" && now.check === "ok") {
      apply({ ...now, check: "pending" });
    }
  }, [apply]);

  const check = useCallback(
    (options: { fresh: boolean; veil?: boolean }) => {
      const token = (checks.current += 1);
      if (options.fresh) advance({ status: "checking" });
      else if (options.veil) veil();
      void fetchProfile().then((result) => {
        if (token !== checks.current) return; // a newer check runs
        const now = current.current;
        if (result.ok) {
          if (
            now.status === "signed-in" &&
            now.profile.email === result.data.email
          ) {
            // Same customer: her screens come back as she left them (her
            // businesses may have changed; their reads check).
            apply({ ...now, profile: result.data, check: "ok" });
          } else {
            advance({ status: "signed-in", profile: result.data, check: "ok" });
          }
          return;
        }
        if (result.error.code === "client_hub_unauthenticated") {
          expiresAt.current = null;
          if (now.status === "signed-in") {
            advance({ status: "signed-out", reason: "expired" });
          } else if (now.status !== "signed-out") {
            // Nobody was shown: no new identity, the screens (a code being
            // typed on the sign-in page) stay as they are.
            apply({
              status: "signed-out",
              reason: null,
              generation: now.generation,
            });
          }
          return;
        }
        // No answer. Veiled data stays veiled: who is signed in is unknown
        // (not an expiry: a retry is offered). Data shown and not in doubt
        // stays (its own reads say so). Otherwise the failure is shown.
        if (now.status === "signed-in") {
          if (now.check !== "ok") apply({ ...now, check: "failed" });
          return;
        }
        apply({
          status: "error",
          error: result.error,
          generation: now.generation,
        });
      });
    },
    [advance, apply, veil],
  );

  const recheck = useCallback(() => check({ fresh: false }), [check]);
  const verify = useCallback(
    () => check({ fresh: false, veil: true }),
    [check],
  );

  const post = useCallback((message: Message) => {
    try {
      channel.current?.postMessage(message);
    } catch {
      // The other tabs check again when they become visible anyway.
    }
  }, []);

  useEffect(() => {
    check({ fresh: false });

    if (typeof BroadcastChannel === "function") {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = (event: MessageEvent<Message>) => {
        if (event.data?.type === "signed-out") {
          // Ended in another tab: nothing of it stays on screen here.
          checks.current += 1;
          expiresAt.current = null;
          if (current.current.status !== "signed-out") {
            advance({ status: "signed-out", reason: "elsewhere" });
          }
        } else if (event.data?.type === "signed-in") {
          check({ fresh: true });
        }
      };
    }
    // Leaving the tab veils her data at once (another tab may sign someone
    // else in); coming back confirms who is signed in before showing it.
    const onVisible = () => {
      if (document.visibilityState === "hidden") veil();
      else check({ fresh: false, veil: true });
    };
    // Restored from the back-forward cache: what it shows may belong to a
    // session that ended since. Hidden at once, then checked.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) check({ fresh: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      checks.current += 1;
      channel.current?.close();
      channel.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [advance, check, veil]);

  // The session ends at a known instant (7 days, never extended): the
  // screens stop showing it then, before any read is refused.
  const signedInGeneration =
    session.status === "signed-in" ? session.generation : null;
  useEffect(() => {
    if (signedInGeneration === null || expiresAt.current === null) return;
    const delay = Math.min(
      Math.max(expiresAt.current - Date.now(), 0),
      MAX_TIMER,
    );
    const timer = window.setTimeout(() => {
      if (generation.current !== signedInGeneration) return;
      expiresAt.current = null;
      advance({ status: "signed-out", reason: "expired" });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [advance, signedInGeneration]);

  // Stable callbacks (they read refs only): a re-check of the same customer
  // never restarts the screens' reads.
  const signedIn = useCallback(
    ({ expiresAt: until }: { email: string; expiresAt: string }) => {
      const at = Date.parse(until);
      expiresAt.current = Number.isFinite(at) ? at : null;
      check({ fresh: true });
      post({ type: "signed-in" });
    },
    [check, post],
  );
  const expire = useCallback(
    (expired: number) => {
      if (expired !== generation.current) return; // an older session's 401
      checks.current += 1;
      expiresAt.current = null;
      advance({ status: "signed-out", reason: "expired" });
    },
    [advance],
  );
  const isCurrent = useCallback(
    (value: number) => value === generation.current,
    [],
  );
  const signOut = useCallback(
    async (all: boolean) => {
      const result = await endSession(all);
      // Without a confirmed answer the cookie may still be there: the
      // screen says so and keeps the session (never a false sign-out).
      if (result.ok) {
        // The cookie is gone: whatever this tab showed, nobody is signed in.
        checks.current += 1;
        expiresAt.current = null;
        advance({ status: "signed-out", reason: "signed-out" });
        post({ type: "signed-out" });
      }
      return result;
    },
    [advance, post],
  );

  const value = useMemo<HubContext>(
    () => ({ session, recheck, verify, signedIn, expire, isCurrent, signOut }),
    [expire, isCurrent, recheck, session, signOut, signedIn, verify],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useClientHub() {
  const context = useContext(Context);
  if (!context) {
    throw new Error(
      "useClientHub must be used inside ClientHubSessionProvider",
    );
  }
  return context;
}

export type HubRead<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: HubError };

/**
 * One read of the signed-in customer's data, started again when `key`
 * changes. Answers of an older key, an older session or a superseded read
 * are dropped; a 401 ends the session (if it is still the current one); a
 * 404 asks who is signed in again (an access may have been revoked).
 */
export function useHubRead<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<HubResult<T>>,
): HubRead<T> & { reload: () => void } {
  const { session, expire, isCurrent, recheck } = useClientHub();
  const signedIn = session.status === "signed-in";
  const owner = session.generation;
  const [run, setRun] = useState(0);
  const [state, setState] = useState<{ for: string; read: HubRead<T> }>({
    for: "",
    read: { status: "loading" },
  });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const readKey = `${owner}|${key}|${run}`;

  useEffect(() => {
    if (!signedIn || key === null) return;
    const controller = new AbortController();
    void loadRef.current(controller.signal).then((result) => {
      if (controller.signal.aborted || !isCurrent(owner)) return;
      if (!result.ok && result.error.code === "client_hub_unauthenticated") {
        expire(owner);
        return;
      }
      if (!result.ok && result.error.code === "client_hub_not_found") {
        recheck();
      }
      setState({
        for: readKey,
        read: result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", error: result.error },
      });
    });
    return () => controller.abort();
  }, [expire, isCurrent, key, owner, readKey, recheck, signedIn]);

  // Another key, read or session than the one answered: nothing of it.
  const read =
    state.for === readKey ? state.read : { status: "loading" as const };
  return { ...read, reload: () => setRun((value) => value + 1) };
}
