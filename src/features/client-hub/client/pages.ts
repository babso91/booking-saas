"use client";

import { useEffect, useRef, useState } from "react";

import type { HubError, HubResult } from "./api";
import { useClientHub } from "./session";

// A cursor-paginated list of the signed-in customer (appointments, points
// history). The first page is read for each `key` (business, scope); "more"
// appends the next one. Every answer is checked against the session
// generation and the key it was asked for: a page of another list, another
// business or another customer is never appended.

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
  const { session, expire, isCurrent, recheck } = useClientHub();
  const signedIn = session.status === "signed-in";
  const owner = session.generation;
  const [run, setRun] = useState(0);
  const listKey = `${owner}|${key}|${run}`;
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

  const settle = (result: HubResult<unknown>, generation: number) => {
    if (!result.ok && result.error.code === "client_hub_unauthenticated") {
      expire(generation);
      return false;
    }
    if (!result.ok && result.error.code === "client_hub_not_found") recheck();
    return true;
  };

  useEffect(() => {
    if (!signedIn || key === null) return;
    const controller = new AbortController();
    void loadRef.current(null, controller.signal).then((result) => {
      if (controller.signal.aborted || !isCurrent(owner)) return;
      if (!settle(result, owner)) return;
      setState({
        for: listKey,
        list: result.ok
          ? {
              status: "ready",
              items: result.data.items,
              nextCursor: result.data.nextCursor,
              more: "idle",
            }
          : { status: "error", error: result.error },
      });
    });
    return () => {
      controller.abort();
      more.current?.abort();
    };
    // `settle` only closes over stable context callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expire, isCurrent, key, listKey, owner, recheck, signedIn]);

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
      if (!settle(result, owner)) return;
      setState((value) => {
        if (value.for !== asked || value.list.status !== "ready") return value;
        if (!result.ok) {
          return { ...value, list: { ...value.list, more: result.error } };
        }
        // A page only adds what is not shown yet.
        const seen = new Set(value.list.items.map((item) => item.id));
        return {
          ...value,
          list: {
            status: "ready",
            items: [
              ...value.list.items,
              ...result.data.items.filter((item) => !seen.has(item.id)),
            ],
            nextCursor: result.data.nextCursor,
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
