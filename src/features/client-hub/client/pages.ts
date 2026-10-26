"use client";

import { useEffect, useRef, useState } from "react";

import type { HubError, HubResult } from "./api";
import { useClientHub } from "./session";

// A cursor-paginated list of the signed-in customer (appointments, points
// history). The first page is read for each `key` (business, scope); "more"
// appends the next one. Every answer is checked against the session
// generation, the key it was asked for and the account it was served for: a
// page of another list, another business or another customer is never
// appended (an answer served for another account, or a 401, veils her data
// while who is signed in is checked; see useHubRead).

type Page<T> = { items: T[]; nextCursor: string | null };

export type PagedList<T> =
  | { status: "loading" }
  | { status: "error"; error: HubError }
  | {
      status: "ready";
      items: T[];
      nextCursor: string | null;
      more: "idle" | "loading" | HubError;
    };

export function useHubPages<T extends { id: string }>(
  key: string | null,
  load: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<HubResult<Page<T>>>,
) {
  const { session, distrust, accepts, isCurrent, recheck } = useClientHub();
  const signedIn = session.status === "signed-in";
  const owner = session.generation;
  const confirmations = signedIn ? session.confirmations : -1;
  const [run, setRun] = useState(0);
  // A first page dropped while her identity was in doubt is read again
  // once GET /me confirmed her since (see useHubRead).
  const [doubt, setDoubt] = useState<{ for: string; at: number } | null>(null);
  const doubts = useRef(0);
  const confirmationsNow = useRef(confirmations);
  useEffect(() => {
    confirmationsNow.current = confirmations;
  });
  const baseKey = `${owner}|${key}|${run}`;
  const listKey =
    doubt !== null && doubt.for === baseKey && confirmations > doubt.at
      ? `${baseKey}|again`
      : baseKey;
  const [state, setState] = useState<{ for: string; list: PagedList<T> }>({
    for: "",
    list: { status: "loading" },
  });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  /** The list currently shown, for "more" answers to check against. */
  const shown = useRef(listKey);
  useEffect(() => {
    shown.current = listKey;
  });
  const more = useRef<AbortController | null>(null);

  /**
   * Whether the answer may be considered (`false`: dropped while who is
   * signed in is checked; "error": still served for someone else after
   * that check, shown as an error).
   */
  const settle = (result: HubResult<unknown>, generation: number) => {
    const refused =
      !result.ok && result.error.code === "client_hub_unauthenticated";
    if (refused || (result.account && !accepts(generation, result.account))) {
      // Checked again once; if the server still disagrees with the
      // confirmed identity, the answer is an error (no loop of checks).
      if (doubts.current > 0) return "error";
      doubts.current += 1;
      distrust(generation);
      return false;
    }
    doubts.current = 0;
    if (!result.ok && result.error.code === "client_hub_not_found") recheck();
    return true;
  };
  /** Its items, only if served for the confirmed account. */
  const pageOf = (result: HubResult<Page<T>>, generation: number) =>
    result.ok && accepts(generation, result.account)
      ? ({ ok: true, page: result.data } as const)
      : ({
          ok: false,
          // Data naming no account is never shown either.
          error: result.ok ? { code: "internal" as const } : result.error,
        } as const);

  useEffect(() => {
    if (!signedIn || key === null) return;
    const controller = new AbortController();
    void loadRef.current(null, controller.signal).then((result) => {
      if (controller.signal.aborted || !isCurrent(owner)) return;
      const considered = settle(result, owner);
      if (considered === false) {
        setDoubt({ for: baseKey, at: confirmationsNow.current });
        return;
      }
      const page =
        considered === "error"
          ? ({ ok: false, error: { code: "internal" } } as const)
          : pageOf(result, owner);
      setState({
        for: listKey,
        list: page.ok
          ? {
              status: "ready",
              items: page.page.items,
              nextCursor: page.page.nextCursor,
              more: "idle",
            }
          : { status: "error", error: page.error },
      });
    });
    return () => {
      controller.abort();
      more.current?.abort();
    };
    // `settle` only closes over stable context callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accepts,
    baseKey,
    distrust,
    isCurrent,
    key,
    listKey,
    owner,
    recheck,
    signedIn,
  ]);

  const list: PagedList<T> =
    state.for === listKey ? state.list : { status: "loading" };

  function loadMore() {
    if (list.status !== "ready" || !list.nextCursor) return;
    if (list.more === "loading") return;
    const asked = listKey;
    const cursor = list.nextCursor;
    const controller = new AbortController();
    more.current = controller;
    setState((value) =>
      value.for === asked && value.list.status === "ready"
        ? { ...value, list: { ...value.list, more: "loading" } }
        : value,
    );
    void loadRef.current(cursor, controller.signal).then((result) => {
      if (controller.signal.aborted || !isCurrent(owner)) return;
      if (shown.current !== asked) return; // another list by now
      const considered = settle(result, owner);
      const page =
        considered === "error"
          ? ({ ok: false, error: { code: "internal" } } as const)
          : pageOf(result, owner);
      setState((value) => {
        if (value.for !== asked || value.list.status !== "ready") return value;
        if (considered === false) {
          // Dropped: what she had is kept (veiled until confirmed), and
          // the next page can be asked for again.
          return { ...value, list: { ...value.list, more: "idle" } };
        }
        if (!page.ok) {
          return { ...value, list: { ...value.list, more: page.error } };
        }
        // A page only adds what is not shown yet.
        const seen = new Set(value.list.items.map((item) => item.id));
        return {
          ...value,
          list: {
            status: "ready",
            items: [
              ...value.list.items,
              ...page.page.items.filter((item) => !seen.has(item.id)),
            ],
            nextCursor: page.page.nextCursor,
            more: "idle",
          },
        };
      });
    });
  }

  return {
    list,
    loadMore,
    reload: () => setRun((value) => value + 1),
  };
}
