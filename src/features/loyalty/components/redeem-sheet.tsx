"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import type { UiError } from "@/features/auth/client/call-action";
import { cn } from "@/lib/cn";

import { points, rewardValueLabel, unavailableCopy } from "../client/format";
import {
  beginOperation,
  sendOperation,
  type LoyaltyScope,
} from "../client/pending-operations";
import type {
  ClientLoyaltySummaryDto,
  RedemptionDto,
  RewardDto,
  RewardEligibilityDto,
} from "../types";
import { WriteError, linkAction } from "./loyalty-parts";

/** Refusals after which the eligibility shown is out of date. */
const REFRESHING = new Set([
  "insufficient_points",
  "reward_unavailable",
  "reward_not_found",
  "loyalty_program_inactive",
]);

type Option = { reward: RewardDto; eligibility: RewardEligibilityDto };

/**
 * Issue a reward to the customer: choose among the rewards (eligibility
 * from the backend), then review the cost and the balance after, then
 * confirm. Each confirmation is a pending operation of its own
 * (client/pending-operations.ts): the same content reuses the requestId of
 * its unresolved operation, from any screen, tab or after a reload; after
 * `idempotency_conflict` a new one is used only on the professional's
 * explicit choice. An answer only changes this screen if it belongs to the
 * operation this screen is showing.
 */
export function RedeemSheet({
  open,
  scope,
  summary,
  rewards,
  pendingCount,
  onClose,
  onRefresh,
  onDone,
}: {
  open: boolean;
  scope: LoyaltyScope;
  summary: ClientLoyaltySummaryDto;
  rewards: RewardDto[];
  /** Unresolved operations of this customer (shown in her file). */
  pendingCount: number;
  onClose: () => void;
  /** The eligibility is out of date: read the file again. */
  onRefresh: () => void;
  onDone: (redemption: RedemptionDto) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [step, setStep] = useState<"choose" | "review">("choose");
  const [state, setState] = useState<
    "idle" | "sending" | "idempotency" | "storage" | UiError
  >("idle");
  const sending = useRef(false);
  /** The operation this screen shows (its answer alone may change it). */
  const currentRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const byId = new Map(rewards.map((reward) => [reward.id, reward]));
  const options: Option[] = summary.rewards.flatMap((eligibility) => {
    const reward = byId.get(eligibility.rewardId);
    return reward ? [{ reward, eligibility }] : [];
  });
  // What can be issued now first, the backend's order otherwise.
  options.sort(
    (a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible),
  );
  const choice = options.find((option) => option.reward.id === selected);
  const busy = state === "sending";

  async function confirm() {
    if (!choice || sending.current) return;
    sending.current = true;
    setState("sending");
    let operation;
    try {
      operation = await beginOperation(scope, {
        kind: "redeem",
        command: { clientId: scope.clientId, rewardId: choice.reward.id },
        label: {
          rewardName: choice.reward.name,
          pointsRequired: choice.reward.pointsRequired,
        },
      });
    } catch {
      // Not recorded: nothing is sent (no protection against duplicates).
      sending.current = false;
      if (aliveRef.current) setState("storage");
      return;
    }
    currentRef.current = operation.requestId;
    const result = await sendOperation(operation);
    sending.current = false;
    // Another operation since, or this screen is gone: the answer settled
    // its own operation in the store, nothing here changes.
    if (!aliveRef.current || currentRef.current !== operation.requestId) return;
    if (result.ok) {
      setState("idle");
      onDone(result.data as RedemptionDto);
      return;
    }
    if (result.error.code === "idempotency_conflict") {
      setState("idempotency");
      return;
    }
    setState(result.error);
    if (REFRESHING.has(result.error.code)) onRefresh();
  }

  const error = typeof state === "string" ? null : state;
  const after = choice ? summary.balance - choice.reward.pointsRequired : 0;

  return (
    <Sheet
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={
        step === "choose"
          ? "Attribuer une récompense"
          : "Confirmer l’attribution"
      }
      description={`Solde actuel : ${points(summary.balance)}`}
      footer={
        step === "choose" ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" size="md" onClick={onClose}>
              Fermer
            </Button>
            <Button
              size="md"
              disabled={!choice?.eligibility.eligible}
              onClick={() => {
                setState("idle");
                setStep("review");
              }}
            >
              Continuer
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              size="md"
              disabled={busy}
              onClick={() => {
                setState("idle");
                setStep("choose");
              }}
            >
              Retour
            </Button>
            <Button
              size="md"
              state={busy ? "loading" : "idle"}
              loadingLabel="Attribution…"
              disabled={
                state === "idempotency" ||
                (error !== null && REFRESHING.has(error.code))
              }
              onClick={() => void confirm()}
            >
              {choice
                ? `Attribuer (−${points(choice.reward.pointsRequired)})`
                : "Attribuer"}
            </Button>
          </div>
        )
      }
    >
      {pendingCount > 0 && step === "choose" ? (
        <Notice tone="warning" className="mb-4">
          Une opération précédente n’est pas confirmée : vérifie-la dans la
          fiche avant d’en lancer une autre.
        </Notice>
      ) : null}
      {step === "choose" ? (
        options.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucune récompense à proposer.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Récompense</legend>
            {options.map(({ reward, eligibility }) => (
              <label
                key={reward.id}
                className={cn(
                  "flex gap-3 rounded-2xl border px-4 py-3.5",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                  eligibility.eligible
                    ? "cursor-pointer hover:border-line-strong"
                    : "cursor-not-allowed opacity-70",
                  selected === reward.id
                    ? "border-ink bg-paper"
                    : "border-line",
                )}
              >
                <input
                  type="radio"
                  name="reward"
                  value={reward.id}
                  checked={selected === reward.id}
                  disabled={!eligibility.eligible}
                  onChange={() => setSelected(reward.id)}
                  className="mt-1 size-4 shrink-0 accent-ink"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold wrap-anywhere text-ink">
                    {reward.name}
                  </span>
                  <span className="text-[13.5px] text-ink-soft">
                    {points(reward.pointsRequired)} ·{" "}
                    {rewardValueLabel({ ...reward, serviceName: null })}
                  </span>
                  {eligibility.eligible ? null : (
                    <span className="text-[13px] font-medium text-[#6b4613]">
                      {eligibility.unavailableReason
                        ? unavailableCopy[eligibility.unavailableReason]
                        : `Il manque ${points(eligibility.missingPoints)}`}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : choice ? (
        <div className="flex flex-col gap-4 text-[14.5px] text-ink-soft">
          <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-ink-muted">Récompense</dt>
            <dd className="wrap-anywhere text-ink">{choice.reward.name}</dd>
            <dt className="text-ink-muted">Ce qu’elle donne</dt>
            <dd className="text-ink">
              {rewardValueLabel({ ...choice.reward, serviceName: null })}
            </dd>
            <dt className="text-ink-muted">Coût</dt>
            <dd className="text-ink">{points(choice.reward.pointsRequired)}</dd>
            <dt className="text-ink-muted">Solde après</dt>
            <dd className="font-semibold text-ink">{points(after)}</dd>
          </dl>
          {choice.reward.description ? (
            <p className="text-[13.5px] whitespace-pre-line wrap-anywhere">
              Conditions : {choice.reward.description}
            </p>
          ) : null}
          <p className="text-[13.5px] text-ink-muted">
            Les points sont débités tout de suite. La récompense devient « à
            utiliser » : tu l’appliques toi-même lors d’une visite, rien n’est
            déduit automatiquement. Tant qu’elle n’est pas utilisée, tu peux
            l’annuler et rendre les points.
          </p>
          {state === "storage" ? (
            <Notice tone="error" title="Opération non envoyée">
              Ce navigateur n’a pas pu l’enregistrer avant l’envoi (stockage
              plein, bloqué ou navigation privée). Rien n’a été envoyé : aucun
              point n’a bougé. Sans cet enregistrement, une réponse perdue
              pourrait mener à un doublon : libère de l’espace ou utilise un
              autre navigateur, puis réessaie.
            </Notice>
          ) : null}
          {state === "idempotency" ? (
            <Notice
              tone="warning"
              title="Demande déjà utilisée"
              action={
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => void confirm()}
                >
                  Envoyer comme nouvelle demande
                </button>
              }
            >
              Cette demande a déjà servi pour une autre opération. Vérifie les
              récompenses attribuées avant d’en envoyer une nouvelle.
            </Notice>
          ) : null}
          {error ? (
            <WriteError
              error={error}
              uncertain="Elle reste dans la fiche, marquée non confirmée. Réessaie ou renvoie-la depuis la fiche : c’est la même demande, le serveur ne l’applique qu’une fois."
              action={
                REFRESHING.has(error.code) ? (
                  <button
                    type="button"
                    className={linkAction}
                    onClick={() => {
                      setState("idle");
                      setSelected(null);
                      setStep("choose");
                    }}
                  >
                    Choisir à nouveau
                  </button>
                ) : undefined
              }
            >
              Aucun point n’a été débité.
            </WriteError>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
