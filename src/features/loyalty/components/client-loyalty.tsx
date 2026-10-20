"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField } from "@/components/ui/field";
import { GiftIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { CrmError } from "@/features/crm/components/crm-error";
import {
  cancelRedemptionAction,
  fulfilRedemptionAction,
  getClientLoyaltyAction,
  listClientRedemptionsAction,
  listRewardsAction,
} from "@/features/loyalty/actions/loyalty";
import { cn } from "@/lib/cn";

import {
  instantLabel,
  points,
  redemptionStatusLabels,
  rewardValueLabel,
} from "../client/format";
import {
  forgetOperation,
  operationLabel,
  sendOperation,
  usePendingOperations,
  type LoyaltyScope,
  type PendingOperation,
} from "../client/pending-operations";
import type {
  ClientLoyaltySummaryDto,
  RedemptionDto,
  RewardDto,
} from "../types";
import { AdjustSheet } from "./adjust-sheet";
import { LedgerSheet } from "./ledger-sheet";
import { Badge, WriteError, linkAction, smallButton } from "./loyalty-parts";
import { RedeemSheet } from "./redeem-sheet";

/** A visit of this customer a reward can be attached to. */
export type LoyaltyVisit = { id: string; label: string };

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | {
      status: "ready";
      summary: ClientLoyaltySummaryDto;
      rewards: RewardDto[];
      redemptions: RedemptionDto[];
    };

type RedemptionAction = {
  kind: "fulfil" | "cancel";
  redemption: RedemptionDto;
};

const SHOWN_PAST = 3;

/**
 * Loyalty in a customer's file: balance, rewards issued and their state,
 * and the professional's actions (issue a reward, adjust points, mark a
 * reward as used, cancel it, read and correct the history). Every number
 * comes from the backend; after each confirmed write everything is read
 * again (and the profile's history, through `onChanged`). Nothing is shown
 * as done before the backend confirmed it.
 */
export function ClientLoyalty({
  scope,
  timezone,
  visits,
  onChanged,
}: {
  /** Signed-in user, business and this customer (pending operations). */
  scope: LoyaltyScope;
  /** Business time zone (dates of the history). */
  timezone: string;
  visits: LoyaltyVisit[];
  /** A confirmed loyalty write (the profile re-reads its history). */
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<"redeem" | "adjust" | "ledger" | null>(
    null,
  );
  const [sheetRun, setSheetRun] = useState(0);
  const [action, setAction] = useState<RedemptionAction | null>(null);
  const [message, setMessage] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [forgetting, setForgetting] = useState<PendingOperation | null>(null);
  const [resent, setResent] = useState<{
    label: string;
    error: UiError;
  } | null>(null);
  const reads = useRef(0);
  const alive = useRef(true);
  const { clientId } = scope;
  const pending = usePendingOperations(scope);
  // Confirmed writes so far: each new one re-reads the file and the
  // profile's history, whichever screen sent it (and even if this card was
  // unmounted meanwhile, when it mounts again it reads everything anyway).
  const seenSettled = useRef(pending.settled);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const read = (reads.current += 1);
    void Promise.all([
      callAction(() => getClientLoyaltyAction({ clientId })),
      callAction(() => listRewardsAction()),
      callAction(() => listClientRedemptionsAction({ clientId })),
    ]).then(([summary, rewards, redemptions]) => {
      if (!alive.current || read !== reads.current) return;
      setRefreshing(false);
      if (!summary.ok)
        return setLoad({ status: "error", error: summary.error });
      if (!rewards.ok)
        return setLoad({ status: "error", error: rewards.error });
      if (!redemptions.ok)
        return setLoad({ status: "error", error: redemptions.error });
      setLoad({
        status: "ready",
        summary: summary.data,
        rewards: rewards.data,
        redemptions: redemptions.data,
      });
    });
    return () => {
      reads.current += 1;
    };
  }, [clientId, run]);

  useEffect(() => {
    if (pending.settled === seenSettled.current) return;
    seenSettled.current = pending.settled;
    setRefreshing(true);
    setRun((value) => value + 1);
    onChanged();
  }, [pending.settled, onChanged]);

  /** Sends a pending operation again: same requestId, same payload. */
  async function resend(operation: PendingOperation) {
    setMessage("");
    setResent(null);
    const result = await sendOperation(scope, operation);
    if (!alive.current) return;
    if (result.ok)
      setMessage(`Opération confirmée : ${operationLabel(operation)}.`);
    else setResent({ label: operationLabel(operation), error: result.error });
  }

  /** Everything again; what is shown stays meanwhile. */
  function reload() {
    setRefreshing(true);
    setRun((value) => value + 1);
  }

  function changed(text: string) {
    setMessage(text);
    reload();
    onChanged();
  }

  function open(target: "redeem" | "adjust" | "ledger") {
    setMessage("");
    setSheetRun((value) => value + 1);
    setSheet(target);
  }

  if (load.status === "loading") {
    return (
      <Frame>
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only" role="status">
            Chargement de la fidélité…
          </span>
          <span className="h-9 w-32 animate-pulse rounded-xl bg-sand" />
          <span className="h-4 w-48 animate-pulse rounded-full bg-sand/70" />
        </div>
      </Frame>
    );
  }

  if (load.status === "error") {
    return (
      <Frame>
        <CrmError
          error={load.error}
          onRetry={() => {
            setLoad({ status: "loading" });
            setRun((value) => value + 1);
          }}
        >
          {load.error.code === "unauthenticated"
            ? undefined
            : "La fidélité de cette cliente n’a pas pu être chargée."}
        </CrmError>
      </Frame>
    );
  }

  const { summary, rewards, redemptions } = load;
  const issued = redemptions.filter((item) => item.status === "issued");
  const past = redemptions.filter((item) => item.status !== "issued");
  const shownPast = showAll ? past : past.slice(0, SHOWN_PAST);
  const eligible = summary.rewards.filter((reward) => reward.eligible).length;
  const negative = summary.balance < 0;
  const nothingYet =
    summary.pointsCredited === 0 &&
    summary.pointsDebited === 0 &&
    redemptions.length === 0;

  return (
    <Frame busy={refreshing}>
      <div className="flex flex-col gap-1">
        <p
          className={cn(
            "font-display text-[34px] leading-none tabular-nums",
            negative ? "text-danger" : "text-ink",
          )}
        >
          {points(summary.balance)}
        </p>
        <p className="text-[13.5px] text-ink-muted">
          {nothingYet
            ? "Aucun mouvement de points pour l’instant."
            : `${points(summary.pointsCredited)} gagnés · ${points(summary.pointsDebited)} dépensés`}
        </p>
      </div>

      {!summary.programActive ? (
        <Notice tone="info">
          Programme en pause ou pas encore activé : aucune récompense ne peut
          être attribuée. Le solde reste consultable.{" "}
          <Link href="/app/loyalty" className="font-semibold underline">
            Réglages de fidélité
          </Link>
        </Notice>
      ) : null}
      {negative ? (
        <Notice tone="warning" title="Solde négatif">
          Des points déjà dépensés ont été retirés par une correction (un
          rendez-vous rouvert, par exemple). Aucune récompense ne peut être
          attribuée tant que le solde n’est pas repassé au-dessus du coût.
        </Notice>
      ) : null}
      {pending.operations.length > 0 ? (
        <PendingOperations
          operations={pending.operations}
          inFlight={pending.inFlight}
          onResend={(operation) => void resend(operation)}
          onForget={setForgetting}
        />
      ) : null}
      {resent ? (
        <WriteError error={resent.error}>
          {resent.label} : non appliquée.
        </WriteError>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="md"
          icon={<GiftIcon size={17} />}
          onClick={() => open("redeem")}
          disabled={!summary.programActive || rewards.length === 0}
        >
          Attribuer une récompense
        </Button>
        <Button size="md" variant="secondary" onClick={() => open("adjust")}>
          Ajuster les points
        </Button>
        <Button size="md" variant="ghost" onClick={() => open("ledger")}>
          Historique des points
        </Button>
      </div>
      {summary.programActive && rewards.length === 0 ? (
        <p className="text-[13.5px] text-ink-muted">
          Aucune récompense créée.{" "}
          <Link href="/app/loyalty" className="font-medium underline">
            En créer une
          </Link>
        </p>
      ) : summary.programActive && eligible > 0 ? (
        <p className="text-[13.5px] text-ink-muted">
          {eligible === 1
            ? "1 récompense accessible avec ce solde."
            : `${eligible} récompenses accessibles avec ce solde.`}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-[14px] font-semibold text-ink">
          Récompenses attribuées
        </h3>
        {redemptions.length === 0 ? (
          <p className="text-[14px] text-ink-muted">Aucune pour l’instant.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {[...issued, ...shownPast].map((redemption) => (
              <RedemptionItem
                key={redemption.id}
                redemption={redemption}
                timezone={timezone}
                onFulfil={() => setAction({ kind: "fulfil", redemption })}
                onCancel={() => setAction({ kind: "cancel", redemption })}
              />
            ))}
          </ul>
        )}
        {past.length > SHOWN_PAST ? (
          <button
            type="button"
            className={cn(linkAction, "w-fit text-[13.5px]")}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? "Afficher moins"
              : `Afficher les ${past.length - SHOWN_PAST} plus anciennes`}
          </button>
        ) : null}
      </div>

      <RedeemSheet
        key={`redeem-${sheetRun}`}
        open={sheet === "redeem"}
        scope={scope}
        summary={summary}
        rewards={rewards}
        pendingCount={pending.operations.length}
        onClose={() => setSheet(null)}
        onRefresh={reload}
        onDone={(redemption) => {
          // The file is read again through the confirmed-writes counter.
          setSheet(null);
          setMessage(
            `Récompense attribuée : ${redemption.reward.name} (−${points(redemption.pointsSpent)}). À appliquer lors de la visite.`,
          );
        }}
      />
      <AdjustSheet
        key={`adjust-${sheetRun}`}
        open={sheet === "adjust"}
        scope={scope}
        balance={summary.balance}
        pendingCount={pending.operations.length}
        onClose={() => setSheet(null)}
        onDone={(delta) => {
          setSheet(null);
          setMessage(
            delta > 0
              ? `${points(delta)} crédités.`
              : `${points(-delta)} débités.`,
          );
        }}
      />
      <LedgerSheet
        key={`ledger-${sheetRun}`}
        open={sheet === "ledger"}
        clientId={clientId}
        timezone={timezone}
        balance={summary.balance}
        onClose={() => setSheet(null)}
        onChanged={() => changed("Ajustement annulé.")}
      />
      <ConfirmDialog
        open={forgetting !== null}
        title="Ne plus suivre cette opération ?"
        description={forgetting ? operationLabel(forgetting) : undefined}
        confirmLabel="Ne plus la suivre"
        onCancel={() => setForgetting(null)}
        onConfirm={() => {
          if (forgetting) forgetOperation(scope, forgetting.requestId);
          setForgetting(null);
        }}
      >
        <p className="text-[14.5px] text-ink-soft">
          Sa réponse n’est jamais arrivée. Si elle figure dans l’historique des
          points, elle a été appliquée ; sinon, elle ne l’a pas été. Une fois
          retirée d’ici, un nouvel envoi identique sera une nouvelle demande.
        </p>
      </ConfirmDialog>
      <RedemptionDialog
        key={action ? `${action.kind}-${action.redemption.id}` : "none"}
        action={action}
        balance={summary.balance}
        visits={visits}
        onClose={() => setAction(null)}
        onDone={(text) => {
          setAction(null);
          changed(text);
        }}
        onStale={() => {
          setAction(null);
          reload();
        }}
      />
    </Frame>
  );
}

function PendingOperations({
  operations,
  inFlight,
  onResend,
  onForget,
}: {
  operations: PendingOperation[];
  inFlight: string[];
  onResend: (operation: PendingOperation) => void;
  onForget: (operation: PendingOperation) => void;
}) {
  return (
    <Notice tone="warning" title="Opérations non confirmées">
      <p>
        Leur réponse n’est pas arrivée : elles ont peut-être été appliquées.
        Renvoie la même demande : le serveur ne l’appliquera qu’une fois.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {operations.map((operation) => {
          const sending = inFlight.includes(operation.requestId);
          return (
            <li key={operation.requestId} className="flex flex-col gap-1">
              <span className="font-medium wrap-anywhere">
                {operationLabel(operation)}
              </span>
              {sending ? (
                <span role="status">Envoi en cours…</span>
              ) : (
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <button
                    type="button"
                    className={linkAction}
                    onClick={() => onResend(operation)}
                  >
                    Renvoyer la même demande
                  </button>
                  <button
                    type="button"
                    className={linkAction}
                    onClick={() => onForget(operation)}
                  >
                    Ne plus la suivre
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}

function Frame({
  busy = false,
  children,
}: {
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="client-loyalty"
      aria-busy={busy || undefined}
      className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="client-loyalty"
          className="font-display text-[22px] leading-tight text-ink"
        >
          Fidélité
        </h2>
        {busy ? (
          <span className="text-[12.5px] text-ink-muted">Mise à jour…</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function RedemptionItem({
  redemption,
  timezone,
  onFulfil,
  onCancel,
}: {
  redemption: RedemptionDto;
  timezone: string;
  onFulfil: () => void;
  onCancel: () => void;
}) {
  const { reward } = redemption;
  const dated =
    redemption.status === "fulfilled" && redemption.fulfilledAt
      ? `utilisée le ${instantLabel(redemption.fulfilledAt, timezone)}`
      : redemption.status === "cancelled" && redemption.cancelledAt
        ? `annulée le ${instantLabel(redemption.cancelledAt, timezone)}, points rendus`
        : `attribuée le ${instantLabel(redemption.redeemedAt, timezone)}`;
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-2xl border px-4 py-3",
        redemption.status === "issued"
          ? "border-accent/25 bg-accent-soft/50"
          : "border-line bg-paper",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14.5px] font-semibold wrap-anywhere text-ink">
            {reward.name}
          </span>
          <span className="text-[13px] text-ink-soft">
            {rewardValueLabel({
              rewardType: reward.type,
              rewardValue: reward.value,
              currency: reward.currency,
              serviceName: reward.serviceName,
            })}{" "}
            · {points(redemption.pointsSpent)}
          </span>
          <span className="text-[12.5px] text-ink-muted">{dated}</span>
          {redemption.cancellationReason ? (
            <span className="text-[12.5px] wrap-anywhere text-ink-muted">
              Motif : {redemption.cancellationReason}
            </span>
          ) : null}
        </div>
        <Badge
          tone={
            redemption.status === "issued"
              ? "neutral"
              : redemption.status === "fulfilled"
                ? "success"
                : "muted"
          }
        >
          {redemptionStatusLabels[redemption.status]}
        </Badge>
      </div>
      {redemption.status === "issued" ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={smallButton}
            onClick={onFulfil}
            aria-label={`Marquer « ${reward.name} » comme utilisée`}
          >
            Marquer comme utilisée
          </button>
          <button
            type="button"
            className={smallButton}
            onClick={onCancel}
            aria-label={`Annuler « ${reward.name} »`}
          >
            Annuler
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** Confirmation of "mark as used" or "cancel" for one issued reward. */
function RedemptionDialog({
  action,
  balance,
  visits,
  onClose,
  onDone,
  onStale,
}: {
  action: RedemptionAction | null;
  balance: number;
  visits: LoyaltyVisit[];
  onClose: () => void;
  onDone: (message: string) => void;
  /** Already used or cancelled elsewhere: the file is read again. */
  onStale: () => void;
}) {
  const [visit, setVisit] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | UiError>("idle");
  const sending = useRef(false);

  async function confirm() {
    if (!action || sending.current) return;
    sending.current = true;
    setState("sending");
    const { redemption } = action;
    const result = await callAction(() =>
      action.kind === "fulfil"
        ? fulfilRedemptionAction({
            redemptionId: redemption.id,
            appointmentId: visit || null,
          })
        : cancelRedemptionAction({
            redemptionId: redemption.id,
            reason: reason.trim() || null,
          }),
    );
    sending.current = false;
    if (result.ok) {
      setState("idle");
      onDone(
        action.kind === "fulfil"
          ? `« ${redemption.reward.name} » marquée comme utilisée.`
          : `« ${redemption.reward.name} » annulée : ${points(redemption.pointsSpent)} rendus.`,
      );
      return;
    }
    setState(result.error);
  }

  const redemption = action?.redemption;
  const error = typeof state === "string" ? null : state;
  const stale =
    error?.code === "invalid_redemption_transition" ||
    error?.code === "redemption_not_found";

  return (
    <ConfirmDialog
      open={action !== null}
      title={
        action?.kind === "fulfil"
          ? "Marquer comme utilisée ?"
          : "Annuler cette récompense ?"
      }
      description={redemption?.reward.name}
      confirmLabel={
        stale
          ? "Relire la fiche"
          : action?.kind === "fulfil"
            ? "Marquer comme utilisée"
            : "Annuler la récompense"
      }
      cancelLabel="Retour"
      tone={action?.kind === "cancel" && !stale ? "danger" : "default"}
      state={state === "sending" ? "loading" : "idle"}
      onCancel={onClose}
      onConfirm={() => (stale ? onStale() : void confirm())}
    >
      {action && redemption ? (
        <div className="flex flex-col gap-4 text-[14.5px] text-ink-soft">
          {action.kind === "fulfil" ? (
            <>
              <p>
                Tu confirmes avoir appliqué cette récompense à ta cliente. C’est
                définitif : une récompense utilisée ne peut plus être annulée.
                Aucun paiement n’est enregistré.
              </p>
              {visits.length > 0 ? (
                <SelectField
                  label="Lors de quel rendez-vous ?"
                  value={visit}
                  onChange={(event) => setVisit(event.target.value)}
                  disabled={state === "sending"}
                >
                  <option value="">Ne pas préciser</option>
                  {visits.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </SelectField>
              ) : null}
            </>
          ) : (
            <>
              <p>
                Les {points(redemption.pointsSpent)} sont rendus à ta cliente :
                son solde passe de {points(balance)} à{" "}
                {points(balance + redemption.pointsSpent)}.
              </p>
              <TextAreaField
                label="Motif"
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
              <Notice tone="warning" title="Déjà traitée">
                Cette récompense a déjà été utilisée ou annulée entre-temps.
                Rien n’a été changé ici.
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
