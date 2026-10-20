"use client";

import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { appendUnique } from "@/features/crm/client/directory-state";
import { CrmError } from "@/features/crm/components/crm-error";
import {
  listClientLoyaltyLedgerAction,
  reverseAdjustmentAction,
} from "@/features/loyalty/actions/loyalty";
import { cn } from "@/lib/cn";

import {
  entryTitle,
  instantLabel,
  isReversible,
  points,
  pointsDelta,
} from "../client/format";
import type { LoyaltyLedgerEntryDto } from "../types";
import { Badge, WriteError, linkAction, smallButton } from "./loyalty-parts";

export const LEDGER_PAGE = 25;

type Ledger = {
  status: "loading" | "ready" | "error";
  entries: LoyaltyLedgerEntryDto[];
  nextCursor: string | null;
  error: UiError | null;
  more: "idle" | "loading" | UiError;
};

const isCursorError = (error: UiError) =>
  error.code === "validation_error" && Boolean(error.fieldErrors?.cursor);

/**
 * The customer's whole points history, newest first, read page by page
 * with the backend's cursor (never cut after a page): earnings, rewards,
 * manual adjustments and corrections, with the balance after each entry.
 * A manual adjustment not compensated yet can be cancelled from here.
 */
export function LedgerSheet({
  open,
  clientId,
  timezone,
  balance,
  onClose,
  onChanged,
}: {
  open: boolean;
  clientId: string;
  timezone: string;
  /** Current balance (preview of a cancellation). */
  balance: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [ledger, setLedger] = useState<Ledger>({
    status: "loading",
    entries: [],
    nextCursor: null,
    error: null,
    more: "idle",
  });
  const [run, setRun] = useState(0);
  const [reversing, setReversing] = useState<LoyaltyLedgerEntryDto | null>(
    null,
  );
  const token = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const read = (token.current += 1);
    void callAction(() =>
      listClientLoyaltyLedgerAction({ clientId, limit: LEDGER_PAGE }),
    ).then((result) => {
      if (!alive.current || read !== token.current) return;
      setLedger((value) =>
        result.ok
          ? {
              status: "ready",
              entries: result.data.entries,
              nextCursor: result.data.nextCursor,
              error: null,
              more: "idle",
            }
          : { ...value, status: "error", error: result.error, more: "idle" },
      );
    });
    return () => {
      token.current += 1;
    };
  }, [open, clientId, run]);

  function reload() {
    setLedger((value) => ({
      ...value,
      status: "loading",
      error: null,
      more: "idle",
    }));
    setRun((value) => value + 1);
  }

  async function loadOlder() {
    if (ledger.status !== "ready" || !ledger.nextCursor) return;
    if (ledger.more === "loading") return;
    const read = token.current;
    const cursor = ledger.nextCursor;
    setLedger((value) => ({ ...value, more: "loading" }));
    const result = await callAction(() =>
      listClientLoyaltyLedgerAction({ clientId, limit: LEDGER_PAGE, cursor }),
    );
    if (!alive.current || read !== token.current) return;
    if (!result.ok) {
      if (isCursorError(result.error)) return reload();
      setLedger((value) => ({ ...value, more: result.error }));
      return;
    }
    setLedger((value) => ({
      ...value,
      entries: appendUnique(value.entries, result.data.entries),
      nextCursor: result.data.nextCursor,
      more: "idle",
    }));
  }

  const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Historique des points"
      description={`Solde actuel : ${points(balance)} · le plus récent d’abord`}
    >
      <div
        className="flex flex-col gap-3"
        aria-busy={ledger.status === "loading" || undefined}
      >
        {ledger.status === "error" && ledger.error ? (
          <CrmError error={ledger.error} onRetry={reload}>
            {ledger.error.code === "unauthenticated"
              ? undefined
              : "L’historique n’a pas pu être chargé."}
          </CrmError>
        ) : null}
        {ledger.status === "loading" && ledger.entries.length === 0 ? (
          <p className="text-[14px] text-ink-muted" role="status">
            Chargement de l’historique…
          </p>
        ) : null}
        {ledger.status === "ready" && ledger.entries.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucun mouvement de points pour cette cliente. Les points arrivent
            quand un de ses rendez-vous est marqué terminé.
          </p>
        ) : null}

        {ledger.entries.length > 0 ? (
          <ol className="flex flex-col divide-y divide-line">
            {ledger.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                timezone={timezone}
                compensated={
                  entry.reversesEntryId
                    ? (byId.get(entry.reversesEntryId) ?? null)
                    : null
                }
                onReverse={() => setReversing(entry)}
              />
            ))}
          </ol>
        ) : null}

        {ledger.status === "ready" && ledger.nextCursor ? (
          <div className="flex flex-col items-start gap-2">
            {typeof ledger.more !== "string" ? (
              <CrmError error={ledger.more} onRetry={() => void loadOlder()}>
                {ledger.more.code === "unauthenticated"
                  ? undefined
                  : "Les opérations plus anciennes n’ont pas pu être chargées."}
              </CrmError>
            ) : (
              <button
                type="button"
                className={smallButton}
                disabled={ledger.more === "loading"}
                aria-busy={ledger.more === "loading" || undefined}
                onClick={() => void loadOlder()}
              >
                {ledger.more === "loading"
                  ? "Chargement…"
                  : "Afficher les opérations plus anciennes"}
              </button>
            )}
          </div>
        ) : ledger.status === "ready" && ledger.entries.length > 0 ? (
          <p className="text-[13px] text-ink-muted">
            Début de l’historique ({ledger.entries.length} opération
            {ledger.entries.length > 1 ? "s" : ""}).
          </p>
        ) : null}
      </div>

      <ReverseDialog
        key={reversing?.id ?? "none"}
        entry={reversing}
        balance={balance}
        onClose={() => setReversing(null)}
        onDone={() => {
          setReversing(null);
          reload();
          onChanged();
        }}
        onStale={() => {
          setReversing(null);
          reload();
        }}
      />
    </Sheet>
  );
}

function EntryRow({
  entry,
  timezone,
  compensated,
  onReverse,
}: {
  entry: LoyaltyLedgerEntryDto;
  timezone: string;
  /** For a correction: the entry it cancels, when loaded. */
  compensated: LoyaltyLedgerEntryDto | null;
  onReverse: () => void;
}) {
  const positive = entry.pointsDelta > 0;
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-medium wrap-anywhere text-ink">
            {entryTitle(entry)}
            {entry.reversedByEntryId ? (
              <Badge tone="muted">Annulé</Badge>
            ) : null}
          </span>
          <span className="text-[12.5px] text-ink-muted">
            {instantLabel(entry.createdAt, timezone)} · solde après :{" "}
            {points(entry.balanceAfter)}
          </span>
          {entry.reason && entry.reason !== entryTitle(entry) ? (
            <span className="text-[13px] whitespace-pre-line wrap-anywhere text-ink-soft">
              {entry.reason}
            </span>
          ) : null}
          {entry.type === "correction" && entry.reversesEntryId ? (
            <span className="text-[12.5px] text-ink-muted">
              {compensated
                ? `Annule : ${entryTitle(compensated)} du ${instantLabel(compensated.createdAt, timezone)}`
                : "Annule une opération plus ancienne."}
            </span>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 text-[14.5px] font-semibold tabular-nums",
            positive ? "text-[#2c4f38]" : "text-ink",
          )}
        >
          {pointsDelta(entry.pointsDelta)}
        </span>
      </div>
      {isReversible(entry) ? (
        <button
          type="button"
          className={cn(linkAction, "w-fit text-[13px]")}
          onClick={onReverse}
        >
          Annuler cet ajustement
        </button>
      ) : null}
    </li>
  );
}

function ReverseDialog({
  entry,
  balance,
  onClose,
  onDone,
  onStale,
}: {
  entry: LoyaltyLedgerEntryDto | null;
  balance: number;
  onClose: () => void;
  onDone: () => void;
  onStale: () => void;
}) {
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | UiError>("idle");
  const sending = useRef(false);

  const after = entry ? balance - entry.pointsDelta : balance;
  const impossible = after < 0;
  const error = typeof state === "string" ? null : state;
  const stale =
    error?.code === "loyalty_entry_not_reversible" ||
    error?.code === "loyalty_entry_not_found";

  async function confirm() {
    if (!entry || sending.current) return;
    sending.current = true;
    setState("sending");
    const result = await callAction(() =>
      reverseAdjustmentAction({
        entryId: entry.id,
        reason: reason.trim() || null,
      }),
    );
    sending.current = false;
    if (result.ok) {
      setState("idle");
      onDone();
      return;
    }
    setState(result.error);
  }

  return (
    <ConfirmDialog
      open={entry !== null}
      title="Annuler cet ajustement ?"
      description={
        entry
          ? `${pointsDelta(entry.pointsDelta)} · ${entry.reason}`
          : undefined
      }
      confirmLabel={
        impossible
          ? "Compris"
          : stale
            ? "Relire l’historique"
            : "Annuler l’ajustement"
      }
      cancelLabel="Retour"
      tone={impossible || stale ? "default" : "danger"}
      state={state === "sending" ? "loading" : "idle"}
      onCancel={onClose}
      onConfirm={() =>
        impossible ? onClose() : stale ? onStale() : void confirm()
      }
    >
      {entry ? (
        <div className="flex flex-col gap-4 text-[14.5px] text-ink-soft">
          {impossible ? (
            <Notice tone="warning" title="Solde insuffisant">
              Annuler ce crédit ferait passer le solde de {points(balance)} à{" "}
              {points(after)}. Une partie de ces points a déjà été dépensée :
              annule d’abord la récompense concernée.
            </Notice>
          ) : (
            <>
              <p>
                Une correction compensera cet ajustement : son solde passe de{" "}
                {points(balance)} à {points(after)}. L’ajustement reste visible
                dans l’historique, marqué annulé.
              </p>
              <TextAreaField
                label="Motif de l’annulation"
                optional
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                counterMax={500}
                maxLength={500}
                disabled={state === "sending"}
              />
            </>
          )}
          {error ? (
            stale ? (
              <Notice tone="warning" title="Déjà annulé">
                Cet ajustement a déjà été annulé entre-temps. Rien n’a été
                changé ici.
              </Notice>
            ) : (
              <WriteError error={error}>Rien n’a été changé.</WriteError>
            )
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
