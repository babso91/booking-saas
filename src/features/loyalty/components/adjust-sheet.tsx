"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import type { UiError } from "@/features/auth/client/call-action";
import { cn } from "@/lib/cn";

import { points } from "../client/format";
import {
  beginOperation,
  sendOperation,
  type LoyaltyScope,
} from "../client/pending-operations";
import { WriteError, fieldErrorsOf, linkAction } from "./loyalty-parts";

export const ADJUST_MAX = 100_000;
export const REASON_MAX = 500;

type Field = "points" | "reason";

/**
 * A manual credit or debit, with a mandatory reason, reviewed before it is
 * sent (balance before and after). A debit can never take the balance
 * below zero (refused here from the balance shown, and by the backend).
 * Each confirmation is a pending operation of its own
 * (client/pending-operations.ts): the same content reuses the requestId of
 * its unresolved operation, from any screen, tab or after a reload. An
 * answer only changes this screen if it belongs to the operation shown.
 */
export function AdjustSheet({
  open,
  scope,
  balance,
  pendingCount,
  onClose,
  onDone,
}: {
  open: boolean;
  scope: LoyaltyScope;
  balance: number;
  /** Unresolved operations of this customer (shown in her file). */
  pendingCount: number;
  onClose: () => void;
  onDone: (delta: number) => void;
}) {
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [step, setStep] = useState<"form" | "review">("form");
  const [state, setState] = useState<
    "idle" | "sending" | "idempotency" | "storage" | UiError
  >("idle");
  const sending = useRef(false);
  /** The operation this screen shows (its answer alone may change it). */
  const currentRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const amountRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const typed = /^\d{1,6}$/.test(amount.trim()) ? Number(amount.trim()) : null;
  const delta = typed === null ? 0 : direction === "credit" ? typed : -typed;
  const after = balance + delta;
  const busy = state === "sending";

  function review() {
    const next: Partial<Record<Field, string>> = {};
    if (typed === null || typed < 1 || typed > ADJUST_MAX)
      next.points = `Indique un nombre entier de 1 à ${ADJUST_MAX.toLocaleString("fr-FR")}.`;
    else if (direction === "debit" && after < 0)
      next.points =
        balance <= 0
          ? "Le solde est à zéro ou négatif : aucun débit n’est possible."
          : `Au plus ${points(balance)} : le solde ne peut pas passer sous zéro.`;
    if (!reason.trim())
      next.reason = "Indique le motif : il reste dans l’historique.";
    else if (reason.trim().length > REASON_MAX)
      next.reason = `${REASON_MAX} caractères au plus.`;
    setErrors(next);
    if (next.points) amountRef.current?.focus();
    else if (next.reason) reasonRef.current?.focus();
    else {
      setState("idle");
      setStep("review");
    }
  }

  async function confirm() {
    if (sending.current || delta === 0) return;
    sending.current = true;
    setState("sending");
    let operation;
    try {
      operation = await beginOperation(scope, {
        kind: delta > 0 ? "credit" : "debit",
        command: {
          clientId: scope.clientId,
          pointsDelta: delta,
          reason: reason.trim(),
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
      onDone(delta);
      return;
    }
    if (result.error.code === "idempotency_conflict") {
      setState("idempotency");
      return;
    }
    if (result.error.code === "validation_error") {
      setErrors(
        fieldErrorsOf(result.error, {
          pointsDelta: "points",
          reason: "reason",
        }),
      );
      setStep("form");
    }
    setState(result.error);
  }

  const error = typeof state === "string" ? null : state;

  return (
    <Sheet
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={step === "form" ? "Ajuster les points" : "Confirmer l’ajustement"}
      description={`Solde actuel : ${points(balance)}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="md"
            disabled={busy}
            onClick={() => {
              if (step === "form") return onClose();
              setState("idle");
              setStep("form");
            }}
          >
            {step === "form" ? "Annuler" : "Modifier"}
          </Button>
          {step === "form" ? (
            <Button size="md" type="submit" form="adjust-form">
              Vérifier
            </Button>
          ) : (
            <Button
              size="md"
              state={busy ? "loading" : "idle"}
              loadingLabel="Enregistrement…"
              disabled={state === "idempotency"}
              onClick={() => void confirm()}
            >
              {delta > 0
                ? `Créditer ${points(delta)}`
                : `Débiter ${points(-delta)}`}
            </Button>
          )}
        </div>
      }
    >
      {step === "form" ? (
        <form
          id="adjust-form"
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          {pendingCount > 0 ? (
            <Notice tone="warning">
              Une opération précédente n’est pas confirmée : vérifie-la dans la
              fiche avant d’en lancer une autre.
            </Notice>
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[15px] font-medium text-ink">
              Opération
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["credit", "Créditer", "Ajouter des points"],
                  ["debit", "Débiter", "Retirer des points"],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer flex-col rounded-2xl border px-4 py-3",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                    direction === value
                      ? "border-ink bg-paper"
                      : "border-line hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="direction"
                    value={value}
                    checked={direction === value}
                    onChange={() => {
                      setDirection(value);
                      setErrors({});
                    }}
                    className="sr-only"
                  />
                  <span className="text-[15px] font-semibold text-ink">
                    {label}
                  </span>
                  <span className="text-[13px] text-ink-muted">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <TextField
            ref={amountRef}
            label="Nombre de points"
            inputMode="numeric"
            value={amount}
            data-autofocus=""
            onChange={(event) => {
              setAmount(event.target.value);
              setErrors((value) => ({ ...value, points: undefined }));
            }}
            error={errors.points}
          />
          <TextAreaField
            ref={reasonRef}
            label="Motif"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setErrors((value) => ({ ...value, reason: undefined }));
            }}
            error={errors.reason}
            counterMax={REASON_MAX}
            placeholder="Ex. Geste commercial, points d’une visite avant le programme…"
          />
          {error ? (
            <WriteError
              error={error}
              uncertain="Elle reste dans la fiche, marquée non confirmée. Réessaie ou renvoie-la depuis la fiche : c’est la même demande, le serveur ne l’applique qu’une fois."
            >
              Aucun point n’a été modifié.
            </WriteError>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-col gap-4 text-[14.5px] text-ink-soft">
          <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-ink-muted">Opération</dt>
            <dd className="text-ink">
              {delta > 0
                ? `Crédit de ${points(delta)}`
                : `Débit de ${points(-delta)}`}
            </dd>
            <dt className="text-ink-muted">Motif</dt>
            <dd className="whitespace-pre-line wrap-anywhere text-ink">
              {reason.trim()}
            </dd>
            <dt className="text-ink-muted">Solde</dt>
            <dd className="font-semibold text-ink">
              {points(balance)} → {points(after)}
            </dd>
          </dl>
          <p className="text-[13.5px] text-ink-muted">
            L’ajustement reste dans l’historique. Tu pourras l’annuler ensuite
            par une correction, sans l’effacer.
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
              Cette demande a déjà servi pour une autre opération. Vérifie
              l’historique des points avant d’en envoyer une nouvelle.
            </Notice>
          ) : null}
          {error ? (
            <WriteError
              error={error}
              uncertain="Elle reste dans la fiche, marquée non confirmée. Réessaie ou renvoie-la depuis la fiche : c’est la même demande, le serveur ne l’applique qu’une fois."
            >
              Aucun point n’a été modifié.
            </WriteError>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
