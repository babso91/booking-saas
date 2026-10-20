import { useSyncExternalStore } from "react";

import { fingerprintOf } from "@/features/agenda/client/request-id";
import { callAction, type UiResult } from "@/features/auth/client/call-action";
import {
  adjustPointsAction,
  redeemRewardAction,
} from "@/features/loyalty/actions/loyalty";

import type { RedemptionDto } from "../types";

// Loyalty writes identified by a `requestId` (issue a reward, credit or
// debit points), each kept as its own operation until its outcome is known.
//
// - One record per operation, never one mutable key: an answer resolves
//   only the operation it belongs to, so a late answer can neither erase
//   nor change another operation.
// - Written to localStorage *before* the request is sent, scoped by user,
//   business and customer: it survives unmounting, a full reload and is
//   seen by the other tabs, so an operation whose answer was lost is sent
//   again with the same requestId and the same payload (the backend applies
//   a requestId once, docs/LOYALTY_CONTRACT.md).
// - Removed only when the outcome is known: success, or a refusal that
//   proves nothing was written (the SQL function raised, its transaction
//   rolled back). Without an answer (network, internal, session lost
//   mid-request) it stays, as uncertain, until resent or explicitly
//   dismissed by the professional.
// - The same content again reuses the pending operation's requestId, never
//   a new one; another content gets its own operation.
//
// Cancelling a reward and reversing an adjustment carry no requestId in the
// contract: they act on one existing row, once (a retry answers the same
// correction or `invalid_redemption_transition`), so they are not kept here.

export type LoyaltyScope = {
  userId: string;
  businessId: string;
  clientId: string;
};

export type RedeemCommand = { clientId: string; rewardId: string };
export type AdjustCommand = {
  clientId: string;
  pointsDelta: number;
  reason: string;
};

export type PendingOperation =
  | {
      requestId: string;
      kind: "redeem";
      command: RedeemCommand;
      /** For display only (the reward as chosen). */
      label: { rewardName: string; pointsRequired: number };
      fingerprint: string;
      createdAt: string;
    }
  | {
      requestId: string;
      kind: "credit" | "debit";
      command: AdjustCommand;
      fingerprint: string;
      createdAt: string;
    };

export type OperationResult =
  UiResult<RedemptionDto> | UiResult<{ entryId: string }>;

const PREFIX = "loyalty-pending:";
/** Refusals proving nothing was written: the operation is over. */
const DEFINITE = new Set([
  "validation_error",
  "forbidden",
  "no_business",
  "client_not_found",
  "reward_not_found",
  "reward_unavailable",
  "loyalty_program_inactive",
  "insufficient_points",
  "idempotency_conflict",
]);

const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
/** Bumped by every confirmed write (screens re-read their data). */
let settled = 0;

export function scopeKey(scope: LoyaltyScope) {
  return `${PREFIX}${scope.userId}:${scope.businessId}:${scope.clientId}`;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, operations: PendingOperation[]) {
  const value = operations.length > 0 ? JSON.stringify(operations) : null;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  emit();
}

function emit() {
  listeners.forEach((listener) => listener());
}

/** Store changes, here or in another tab. */
export function subscribePending(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const isOperation = (value: unknown): value is PendingOperation => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.requestId === "string" &&
    typeof item.fingerprint === "string" &&
    (item.kind === "redeem" ||
      item.kind === "credit" ||
      item.kind === "debit") &&
    Boolean(item.command && typeof item.command === "object")
  );
};

/** The scope's unresolved operations, oldest first. */
export function pendingOperations(scope: LoyaltyScope): PendingOperation[] {
  const raw = read(scopeKey(scope));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is PendingOperation =>
            isOperation(item) && item.command.clientId === scope.clientId,
        )
      : [];
  } catch {
    return [];
  }
}

export const isInFlight = (requestId: string) => inFlight.has(requestId);

type NewOperation =
  | {
      kind: "redeem";
      command: RedeemCommand;
      label: { rewardName: string; pointsRequired: number };
    }
  | { kind: "credit" | "debit"; command: AdjustCommand };

/**
 * The operation for this content: the pending one with the same content
 * (same requestId: a retry, from any screen, tab or after a reload), or a
 * new one, recorded before anything is sent. `asNew`: the professional
 * explicitly asked for a new request (after `idempotency_conflict`).
 */
export function beginOperation(
  scope: LoyaltyScope,
  operation: NewOperation,
  { asNew = false }: { asNew?: boolean } = {},
): PendingOperation {
  const fingerprint = fingerprintOf({
    kind: operation.kind,
    command: operation.command,
  });
  const operations = pendingOperations(scope);
  const existing = operations.find((item) => item.fingerprint === fingerprint);
  if (existing && !asNew) return existing;
  const created = {
    ...operation,
    requestId: crypto.randomUUID(),
    fingerprint,
    createdAt: new Date().toISOString(),
  } as PendingOperation;
  write(scopeKey(scope), [
    ...operations.filter((item) => item !== existing),
    created,
  ]);
  return created;
}

/** Forgets one operation (resolved, or dismissed by the professional). */
export function forgetOperation(scope: LoyaltyScope, requestId: string) {
  const operations = pendingOperations(scope);
  if (!operations.some((item) => item.requestId === requestId)) return;
  write(
    scopeKey(scope),
    operations.filter((item) => item.requestId !== requestId),
  );
}

/**
 * Sends one operation with its own requestId and payload, and settles that
 * operation only. Independent of any component: an answer arriving after
 * its screen was closed or unmounted still settles its own operation.
 */
export async function sendOperation(
  scope: LoyaltyScope,
  operation: PendingOperation,
): Promise<OperationResult> {
  inFlight.add(operation.requestId);
  emit();
  const result: OperationResult =
    operation.kind === "redeem"
      ? await callAction(() =>
          redeemRewardAction({
            ...operation.command,
            requestId: operation.requestId,
          }),
        )
      : await callAction(() =>
          adjustPointsAction({
            ...operation.command,
            requestId: operation.requestId,
          }),
        );
  inFlight.delete(operation.requestId);
  if (result.ok) settled += 1;
  if (result.ok || DEFINITE.has(result.error.code)) {
    forgetOperation(scope, operation.requestId);
  } else {
    emit();
  }
  return result;
}

/** What a pending operation is, in words. */
export function operationLabel(operation: PendingOperation) {
  const points = (value: number) =>
    `${value.toLocaleString("fr-FR")} point${value > 1 ? "s" : ""}`;
  switch (operation.kind) {
    case "redeem":
      return `Attribution : ${operation.label.rewardName.trim()} (−${points(operation.label.pointsRequired)})`;
    case "credit":
      return `Crédit de ${points(operation.command.pointsDelta)} : ${operation.command.reason}`;
    case "debit":
      return `Débit de ${points(-operation.command.pointsDelta)} : ${operation.command.reason}`;
  }
}

type PendingState = {
  operations: PendingOperation[];
  inFlight: string[];
  settled: number;
};

function parseSnapshot(snapshot: string, clientId: string): PendingState {
  const {
    raw,
    inFlight: sending,
    settled: count,
  } = JSON.parse(snapshot) as {
    raw: string | null;
    inFlight: string[];
    settled: number;
  };
  let operations: PendingOperation[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed))
      operations = parsed.filter(
        (item): item is PendingOperation =>
          isOperation(item) && item.command.clientId === clientId,
      );
  } catch {
    operations = [];
  }
  return { operations, inFlight: sending, settled: count };
}

/**
 * The scope's unresolved operations, those being sent, and the number of
 * confirmed writes so far, kept up to date across screens and tabs.
 */
export function usePendingOperations(scope: LoyaltyScope): PendingState {
  const key = scopeKey(scope);
  const snapshot = useSyncExternalStore(
    subscribePending,
    () =>
      JSON.stringify({
        raw: read(key),
        inFlight: [...inFlight],
        settled,
      }),
    () => JSON.stringify({ raw: null, inFlight: [], settled: 0 }),
  );
  return parseSnapshot(snapshot, scope.clientId);
}
