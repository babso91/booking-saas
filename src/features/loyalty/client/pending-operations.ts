import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { callAction, type UiResult } from "@/features/auth/client/call-action";
import {
  adjustPointsAction,
  redeemRewardAction,
} from "@/features/loyalty/actions/loyalty";

import type { RedemptionDto } from "../types";
import {
  hideOperation,
  listOperations,
  recordOperation,
  resolveOperation,
  subscribeOperations,
  type LoyaltyScope,
  type NewOperation,
  type PendingOperation,
} from "./operation-store";

// Loyalty writes identified by a `requestId` (issue a reward, credit or
// debit points). Each is its own operation in the durable store
// (operation-store.ts), recorded *before* anything is sent:
//
// - nothing is sent unless the record was committed (`beginOperation`
//   rejects with OperationStoreError otherwise, and the screen says so);
// - the same content reuses the requestId of its unresolved operation, from
//   any screen or tab, after a reload or a new sign-in of the same account;
// - an answer settles only its own operation, by its own key: success, or
//   a refusal proving nothing was written (the SQL function raised, its
//   transaction rolled back). Without an answer it stays unresolved until
//   it is resent; the professional can hide its alert, never delete it.
//
// Cancelling a reward and reversing an adjustment carry no requestId in the
// contract: they act once on one existing row (a retry answers the same
// correction or `invalid_redemption_transition`), so they are not kept here.

export type { LoyaltyScope, PendingOperation } from "./operation-store";
export { OperationStoreError } from "./operation-store";

export type OperationResult =
  UiResult<RedemptionDto> | UiResult<{ entryId: string }>;

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

// In this tab only: requests on the wire, and confirmed writes so far.
const inFlight = new Set<string>();
let settled = 0;
const local = new Set<() => void>();
const emitLocal = () => local.forEach((listener) => listener());
const subscribeLocal = (listener: () => void) => {
  local.add(listener);
  return () => {
    local.delete(listener);
  };
};

/** The committed operation for this content (see operation-store.ts). */
export function beginOperation(scope: LoyaltyScope, operation: NewOperation) {
  return recordOperation(scope, operation);
}

/**
 * Sends one recorded operation with its own requestId and payload, and
 * settles that operation only. Independent of any component: an answer
 * arriving after its screen was closed or unmounted still settles it.
 */
export async function sendOperation(
  operation: PendingOperation,
): Promise<OperationResult> {
  inFlight.add(operation.requestId);
  emitLocal();
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
    try {
      await resolveOperation(operation.requestId);
    } catch {
      // Still recorded: a resend answers the same result (idempotent).
    }
  }
  emitLocal();
  return result;
}

/** Hides the alert; the operation and its requestId are kept. */
export const hidePendingOperation = hideOperation;

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

export type PendingState = {
  /** `unavailable`: the store cannot be used; no protected write is possible. */
  status: "loading" | "ready" | "unavailable";
  operations: PendingOperation[];
  inFlight: string[];
  settled: number;
};

/**
 * The scope's unresolved operations (read from the durable store, again on
 * every change here or in another tab), those being sent from this tab,
 * and the number of writes confirmed in this tab.
 */
export function usePendingOperations(scope: LoyaltyScope): PendingState {
  const { userId, businessId, clientId } = scope;
  const [stored, setStored] = useState<{
    status: PendingState["status"];
    operations: PendingOperation[];
  }>({ status: "loading", operations: [] });
  const reads = useRef(0);
  const live = useSyncExternalStore(
    subscribeLocal,
    () => `${[...inFlight].join(",")}|${settled}`,
    () => "|0",
  );

  useEffect(() => {
    const target = { userId, businessId, clientId };
    const read = () => {
      const token = (reads.current += 1);
      listOperations(target).then(
        (operations) => {
          if (token === reads.current)
            setStored({ status: "ready", operations });
        },
        () => {
          if (token === reads.current)
            setStored({ status: "unavailable", operations: [] });
        },
      );
    };
    read();
    const stop = subscribeOperations(read);
    return () => {
      reads.current += 1;
      stop();
    };
  }, [userId, businessId, clientId]);

  const [sending = "", count = "0"] = live.split("|");
  return {
    ...stored,
    inFlight: sending ? sending.split(",") : [],
    settled: Number(count),
  };
}
