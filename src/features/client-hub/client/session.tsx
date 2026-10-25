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
// HttpOnly and read by the hub's API routes only: the only way to know who
// is signed in is to ask GET /api/client-hub/me, which this provider does.
//
// Isolation: every identity shown (a sign-in, a sign-out, an expiry, another
// customer signed in from another tab) gets a new `generation`. The screens
// are remounted under it (nothing typed, opened or read is kept), and every
// answer to a request started under an older generation is dropped,
// including a late 401, which can never sign out the newer session.
//
// Identity: the customer shown is the ACCOUNT that GET /me confirmed. Every
// private answer names the account it was served for (X-Client-Hub-Account,
// decided by the server among the browser's session cookies). An answer
// served for any other account, or for none, is never shown: the screens
// are veiled and who is signed in is checked again. So a request that left
// with another session's cookie (another tab signed someone else in
// meanwhile) cannot put that person's data on this customer's screens.
//
// Signing out ends the sessions this browser presented, on the server; it
// does NOT tell who is signed in afterwards: another tab may have signed
// someone else in while the answer was on its way (its cookie is intact).
// So a sign-out is reconciled with GET /me, like any other doubt: this
// tab's screens are dropped at once if they still show the customer who
// signed out, then /me says who, if anyone, is signed in. An answer that
// arrives after the tab moved on to someone else only re-checks her, veiled.
// Messages between tabs are requests to check, never orders: a tab acts on
// what /me confirms, not on what another tab believed.
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
      /** The account GET /me confirmed (X-Client-Hub-Account). */
      account: string;
      /** How many times GET /me confirmed her again (only ever grows). */
      confirmations: number;
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
  /**
   * A read of `generation` was refused (401) or served for another
   * account: her data is veiled and who is signed in is checked again (a
   * refusal with nobody signed in any more is an expiry).
   */
  distrust: (generation: number) => void;
  /** Whether answers of `generation` may still be considered. */
  isCurrent: (generation: number) => boolean;
  /** Whether an answer of `generation`, served for `account`, may be shown. */
  accepts: (generation: number, account: string | null) => boolean;
  signOut: (all: boolean) => Promise<HubResult<{ ended: true }>>;
};

const Context = createContext<HubContext | null>(null);

const CHANNEL = "client-hub-session";
/**
 * "Who is signed in changed here: check". Older tabs may still send
 * "signed-in" / "signed-out": any message is read as that request.
 */
type Message = { type: "check" };

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
  // Her session's end, as the sign-in in THIS tab announced it (verify
  // answers it; /me does not). It belongs to the account the first check
  // after that sign-in confirmed (`account`, null until then), and to no
  // one else: confirming any other identity drops it. At that instant a
  // timer asks /me (veiled) instead of deciding: the server says whether
  // she is still signed in. Used once (no loop when it is already past).
  const deadline = useRef<{
    at: number;
    /** Checks started from this one on may bind it (the sign-in's check). */
    from: number;
    account: string | null;
  } | null>(null);
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
        | {
            status: "signed-in";
            profile: ClientHubProfileDto;
            account: string;
            confirmations: number;
            check: "ok";
          }
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
    (options: {
      fresh: boolean;
      veil?: boolean;
      /** Why, if /me finds nobody signed in (shown on the sign-in page). */
      out?: SignedOutReason;
    }): number => {
      const token = (checks.current += 1);
      if (options.fresh) advance({ status: "checking" });
      else if (options.veil) veil();
      void fetchProfile().then((answer) => {
        let result = answer;
        if (token !== checks.current) return; // a newer check runs
        const now = current.current;
        if (result.ok && result.account) {
          // The deadline is hers only: bound to the account confirmed by
          // her sign-in's check, dropped as soon as anyone else is.
          const due = deadline.current;
          if (due && due.account === null && token >= due.from) {
            deadline.current = { ...due, account: result.account };
          } else if (
            due &&
            due.account !== null &&
            due.account !== result.account
          ) {
            deadline.current = null;
          }
          if (now.status === "signed-in" && now.account === result.account) {
            // Same customer: her screens come back as she left them (her
            // businesses may have changed; their reads check).
            apply({
              ...now,
              profile: result.data,
              check: "ok",
              confirmations: now.confirmations + 1,
            });
          } else {
            advance({
              status: "signed-in",
              profile: result.data,
              account: result.account,
              confirmations: 0,
              check: "ok",
            });
          }
          return;
        }
        if (result.ok) {
          // A profile that names no account: who it is cannot be told.
          result = {
            ok: false,
            error: { code: "internal" },
            account: null,
          };
        }
        if (result.error.code === "client_hub_unauthenticated") {
          deadline.current = null;
          if (now.status === "signed-in") {
            advance({ status: "signed-out", reason: options.out ?? "expired" });
          } else if (now.status !== "signed-out") {
            // Nobody was shown: no new identity, the screens (a code being
            // typed on the sign-in page) stay as they are.
            apply({
              status: "signed-out",
              reason: options.out ?? null,
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
      return token;
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
      // Another tab signed in or out: her data is hidden at once, and /me
      // says who is signed in now (the same customer keeps her screens).
      channel.current.onmessage = () => {
        check({ fresh: false, veil: true, out: "elsewhere" });
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

  // At her deadline (7 days, never extended), her data is veiled and /me
  // asked: still signed in (clock skew), her screens come back; over, the
  // sign-in page says it expired; no answer, the veil stays with a retry.
  // Only for the account the deadline belongs to; another identity shown
  // (another tab's sign-in) has no deadline here: its end is learnt from
  // the server (a refused read, the tab's return, another tab's message).
  const signedInAccount =
    session.status === "signed-in" ? session.account : null;
  const signedInGeneration =
    session.status === "signed-in" ? session.generation : null;
  useEffect(() => {
    const due = deadline.current;
    if (signedInAccount === null || !due || due.account !== signedInAccount)
      return;
    const delay = Math.min(Math.max(due.at - Date.now(), 0), MAX_TIMER);
    const timer = window.setTimeout(() => {
      if (deadline.current !== due) return; // replaced or dropped meanwhile
      deadline.current = null; // used once
      check({ fresh: false, veil: true, out: "expired" });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [check, signedInAccount, signedInGeneration]);

  // Stable callbacks (they read refs only): a re-check of the same customer
  // never restarts the screens' reads.
  const signedIn = useCallback(
    ({ expiresAt: until }: { email: string; expiresAt: string }) => {
      const at = Date.parse(until);
      deadline.current = null;
      const from = check({ fresh: true });
      if (Number.isFinite(at)) deadline.current = { at, from, account: null };
      post({ type: "check" });
    },
    [check, post],
  );
  const distrust = useCallback(
    (owner: number) => {
      if (owner !== generation.current) return; // an older session's answer
      check({ fresh: false, veil: true });
    },
    [check],
  );
  const isCurrent = useCallback(
    (value: number) => value === generation.current,
    [],
  );
  const accepts = useCallback((owner: number, account: string | null) => {
    const now = current.current;
    return (
      owner === generation.current &&
      now.status === "signed-in" &&
      account !== null &&
      account === now.account
    );
  }, []);
  const signOut = useCallback(
    async (all: boolean) => {
      const owner = generation.current;
      const result = await endSession(all);
      // Without a confirmed answer the cookie may still be there: the
      // screen says so and keeps the session (never a false sign-out).
      if (result.ok) {
        // Her sessions are over; whether someone else is signed in on this
        // browser now is for /me to say. Still showing her: her screens go
        // at once. Already showing someone else (her answer was late):
        // that customer is only checked again, veiled, never signed out.
        if (owner === generation.current) {
          deadline.current = null;
          check({ fresh: true, out: "signed-out" });
        } else {
          check({ fresh: false, veil: true, out: "elsewhere" });
        }
        post({ type: "check" });
      }
      return result;
    },
    [check, post],
  );

  const value = useMemo<HubContext>(
    () => ({
      session,
      recheck,
      verify,
      signedIn,
      distrust,
      isCurrent,
      accepts,
      signOut,
    }),
    [accepts, distrust, isCurrent, recheck, session, signOut, signedIn, verify],
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
 * are dropped. An answer served for another account than the confirmed one
 * (or a 401) is dropped too: her data is veiled while who is signed in is
 * checked, and the read starts again once she is confirmed (another
 * customer gets new screens). A 404 asks who is signed in again (an access
 * may have been revoked).
 */
export function useHubRead<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<HubResult<T>>,
): HubRead<T> & { reload: () => void } {
  const { session, distrust, accepts, isCurrent, recheck } = useClientHub();
  const signedIn = session.status === "signed-in";
  const owner = session.generation;
  const confirmations = signedIn ? session.confirmations : -1;
  const [run, setRun] = useState(0);
  // A read dropped while her identity was in doubt (`at`: the confirmations
  // then) is read again once GET /me confirmed her since.
  const [doubt, setDoubt] = useState<{ for: string; at: number } | null>(null);
  const doubts = useRef(0);
  const confirmationsNow = useRef(confirmations);
  useEffect(() => {
    confirmationsNow.current = confirmations;
  });
  const [state, setState] = useState<{ for: string; read: HubRead<T> }>({
    for: "",
    read: { status: "loading" },
  });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const baseKey = `${owner}|${key}|${run}`;
  const again =
    doubt !== null && doubt.for === baseKey && confirmations > doubt.at;
  const readKey = again ? `${baseKey}|again` : baseKey;

  useEffect(() => {
    if (!signedIn || key === null) return;
    const controller = new AbortController();
    void loadRef.current(controller.signal).then((result) => {
      if (controller.signal.aborted || !isCurrent(owner)) return;
      const refused =
        !result.ok && result.error.code === "client_hub_unauthenticated";
      if (refused || (result.account && !accepts(owner, result.account))) {
        // Refused, or served for someone else: never shown. Read again once
        // she is confirmed, once: if the server still disagrees with the
        // confirmed identity, an error is shown (no loop of checks).
        if (doubts.current === 0) {
          doubts.current += 1;
          setDoubt({ for: baseKey, at: confirmationsNow.current });
          distrust(owner);
        } else {
          setState({
            for: readKey,
            read: { status: "error", error: { code: "internal" } },
          });
        }
        return;
      }
      doubts.current = 0;
      if (!result.ok && result.error.code === "client_hub_not_found") {
        recheck();
      }
      setState({
        for: readKey,
        read:
          result.ok && accepts(owner, result.account)
            ? { status: "ready", data: result.data }
            : {
                status: "error",
                // Data naming no account is never shown either.
                error: result.ok ? { code: "internal" } : result.error,
              },
      });
    });
    return () => controller.abort();
  }, [
    accepts,
    baseKey,
    distrust,
    isCurrent,
    key,
    owner,
    readKey,
    recheck,
    signedIn,
  ]);

  // Another key, read or session than the one answered: nothing of it.
  const read =
    state.for === readKey ? state.read : { status: "loading" as const };
  return { ...read, reload: () => setRun((value) => value + 1) };
}
