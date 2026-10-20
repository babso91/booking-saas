"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  createRewardAction,
  listRewardsAction,
  updateRewardAction,
} from "@/features/loyalty/actions/loyalty";
import type { ServiceView } from "@/features/services/client/service-form";

import { rewardValueLabel } from "../client/format";
import {
  EMPTY_REWARD,
  REWARD_DESCRIPTION_MAX,
  REWARD_NAME_MAX,
  checkReward,
  createCommand,
  rewardDirty,
  rewardDraft,
  rewardTypeLabels,
  updateCommand,
  type RewardDraft,
  type RewardField,
} from "../client/reward-form";
import type { RewardDto, RewardType } from "../types";
import { WriteError, fieldErrorsOf, linkAction } from "./loyalty-parts";

const rewardFields: Record<string, RewardField> = {
  name: "name",
  description: "description",
  pointsRequired: "points",
  rewardValue: "value",
  serviceId: "serviceId",
};

const SERVICE_FIELD = "reward-service";

export type RewardSheetTarget =
  { mode: "create" } | { mode: "edit"; reward: RewardDto };

type Write =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "error"; error: UiError }
  | { status: "idempotency" }
  /** Refused as stale: the reward as it is now, or null when it is gone. */
  | {
      status: "conflict";
      current: RewardDto | null | "reading";
      error?: UiError;
    };

/**
 * Create or edit one reward. Creation is idempotent by `requestId`: one key
 * per content (kept by the parent across closes), the same key for every
 * retry of that content, a new one only when the content changes or when
 * the professional explicitly sends it as a new reward after
 * `idempotency_conflict`. An edit is based on the reward as read
 * (`expectedVersion`) and sends untouched values exactly as stored.
 */
export function RewardSheet({
  target,
  services,
  currency,
  creationKeyRef,
  onClose,
  onSaved,
}: {
  target: RewardSheetTarget | null;
  services: ServiceView[];
  currency: string;
  /** The parent's key holder: survives closing and reopening the form. */
  creationKeyRef: RefObject<RequestKey | null>;
  onClose: () => void;
  onSaved: (reward: RewardDto, created: boolean) => void;
}) {
  const [base, setBase] = useState<RewardDto | null>(
    target?.mode === "edit" ? target.reward : null,
  );
  const [draft, setDraft] = useState<RewardDraft>(() =>
    target?.mode === "edit" ? rewardDraft(target.reward) : EMPTY_REWARD,
  );
  const [errors, setErrors] = useState<Partial<Record<RewardField, string>>>(
    {},
  );
  const [write, setWrite] = useState<Write>({ status: "idle" });
  const sending = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // A refusal is shown below a long form: bring it into view (phones).
  useEffect(() => {
    if (write.status === "idle" || write.status === "saving") return;
    // Again once the current version is read (the notice grows).
    feedbackRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [write]);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const pointsRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const editing = target?.mode === "edit";
  const saving = write.status === "saving";
  const dirty = rewardDirty(draft, base);

  function change(patch: Partial<RewardDraft>) {
    setDraft((value) => ({ ...value, ...patch }));
    setErrors({});
    if (write.status === "error" || write.status === "idempotency")
      setWrite({ status: "idle" });
  }

  function showErrors(fieldErrors: Partial<Record<RewardField, string>>) {
    setErrors(fieldErrors);
    const order: RewardField[] = [
      "name",
      "description",
      "points",
      "value",
      "serviceId",
    ];
    const first = order.find((field) => fieldErrors[field]);
    if (first === "serviceId") document.getElementById(SERVICE_FIELD)?.focus();
    else if (first)
      ({
        name: nameRef,
        description: descriptionRef,
        points: pointsRef,
        value: valueRef,
      })[first].current?.focus();
  }

  async function readCurrent(rewardId: string) {
    setWrite({ status: "conflict", current: "reading" });
    const result = await callAction(() => listRewardsAction());
    if (!result.ok) {
      setWrite({ status: "conflict", current: null, error: result.error });
      return;
    }
    setWrite({
      status: "conflict",
      current: result.data.find((reward) => reward.id === rewardId) ?? null,
    });
  }

  async function submit({ asNew = false }: { asNew?: boolean } = {}) {
    if (sending.current) return;
    const checked = checkReward(draft, base);
    if (!checked.ok) {
      showErrors(checked.errors);
      return;
    }
    let command;
    if (base) {
      // Activation is changed from the list only: as stored.
      command = updateCommand(base, checked.values, base.active);
    } else {
      const content = createCommand(draft, checked.values, "");
      const fingerprint = fingerprintOf({ ...content, requestId: undefined });
      creationKeyRef.current = asNew
        ? { fingerprint, id: crypto.randomUUID() }
        : requestKeyFor(creationKeyRef.current, fingerprint);
      command = createCommand(draft, checked.values, creationKeyRef.current.id);
    }

    sending.current = true;
    setWrite({ status: "saving" });
    const result = await callAction(() =>
      base ? updateRewardAction(command) : createRewardAction(command),
    );
    sending.current = false;

    if (result.ok) {
      if (!base) creationKeyRef.current = null;
      setWrite({ status: "idle" });
      onSaved(result.data, !base);
      return;
    }
    const { error } = result;
    if (error.code === "idempotency_conflict") {
      setWrite({ status: "idempotency" });
      return;
    }
    if (error.code === "stale_reward" && base) {
      void readCurrent(base.id);
      return;
    }
    if (error.code === "validation_error" || error.code === "service_not_found")
      showErrors(
        error.code === "service_not_found"
          ? {
              serviceId:
                "Cette prestation n’existe plus. Choisis-en une autre.",
            }
          : fieldErrorsOf(error, rewardFields),
      );
    setWrite({ status: "error", error });
  }

  // The free service may be inactive or deleted since: keep it listed.
  const selectable = services.filter(
    (service) => service.active || service.id === draft.serviceId,
  );
  const serviceGone =
    draft.rewardType === "free_service" &&
    base?.serviceId !== null &&
    base?.serviceId !== undefined &&
    draft.serviceId === base.serviceId &&
    !services.some((service) => service.id === draft.serviceId);

  return (
    <Sheet
      open={target !== null}
      onClose={() => (saving ? undefined : onClose())}
      title={editing ? "Modifier la récompense" : "Nouvelle récompense"}
      description={
        editing
          ? "Les récompenses déjà attribuées gardent leurs conditions d’origine."
          : "Ce que ta cliente peut obtenir avec ses points."
      }
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="md" onClick={onClose} disabled={saving}>
            {dirty ? "Annuler" : "Fermer"}
          </Button>
          <Button
            size="md"
            type="submit"
            form="reward-form"
            state={saving ? "loading" : "idle"}
            loadingLabel="Enregistrement…"
            disabled={
              (editing && !dirty) ||
              write.status === "conflict" ||
              write.status === "idempotency"
            }
          >
            {editing ? "Enregistrer" : "Créer la récompense"}
          </Button>
        </div>
      }
    >
      <form
        id="reward-form"
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={saving} className="flex min-w-0 flex-col gap-5">
          <TextField
            ref={nameRef}
            label="Nom"
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
            error={errors.name}
            counterMax={REWARD_NAME_MAX}
            placeholder="Ex. Remplissage offert"
            data-autofocus=""
          />
          <TextAreaField
            ref={descriptionRef}
            label="Conditions"
            optional
            value={draft.description}
            onChange={(event) => change({ description: event.target.value })}
            error={errors.description}
            counterMax={REWARD_DESCRIPTION_MAX}
            placeholder="Ex. Valable sur une prestation d’une heure maximum."
          />
          <TextField
            ref={pointsRef}
            label="Coût en points"
            inputMode="numeric"
            value={draft.points}
            onChange={(event) => change({ points: event.target.value })}
            error={errors.points}
            hint="Les points débités du solde de ta cliente quand tu lui attribues cette récompense."
          />

          {editing ? (
            <p className="flex flex-col gap-1 text-[14.5px]">
              <span className="font-medium text-ink">Type</span>
              <span className="text-ink-soft">
                {rewardTypeLabels[draft.rewardType]} (ne change pas après la
                création)
              </span>
            </p>
          ) : (
            <SelectField
              label="Type"
              value={draft.rewardType}
              onChange={(event) =>
                change({
                  rewardType: event.target.value as RewardType,
                  value: "",
                  serviceId: "",
                })
              }
            >
              {(Object.keys(rewardTypeLabels) as RewardType[]).map((type) => (
                <option key={type} value={type}>
                  {rewardTypeLabels[type]}
                </option>
              ))}
            </SelectField>
          )}

          {draft.rewardType === "fixed_discount" ? (
            <TextField
              ref={valueRef}
              label="Montant de la remise"
              inputMode="decimal"
              prefix={currency === "EUR" ? "€" : currency}
              value={draft.value}
              onChange={(event) => change({ value: event.target.value })}
              error={errors.value}
            />
          ) : draft.rewardType === "percentage_discount" ? (
            <TextField
              ref={valueRef}
              label="Pourcentage de remise"
              inputMode="numeric"
              prefix="%"
              value={draft.value}
              onChange={(event) => change({ value: event.target.value })}
              error={errors.value}
              hint="De 1 à 100."
            />
          ) : (
            <SelectField
              id={SERVICE_FIELD}
              label="Prestation offerte"
              value={draft.serviceId}
              onChange={(event) => change({ serviceId: event.target.value })}
              error={
                errors.serviceId ??
                (serviceGone
                  ? "Cette prestation a été supprimée : choisis-en une autre pour rendre la récompense disponible."
                  : undefined)
              }
            >
              <option value="">Choisir une prestation</option>
              {serviceGone ? (
                <option value={draft.serviceId}>Prestation supprimée</option>
              ) : null}
              {selectable.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                  {service.active ? "" : " (désactivée)"}
                </option>
              ))}
            </SelectField>
          )}

          {editing ? null : (
            <label className="flex items-center justify-between gap-4">
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-medium text-ink">
                  Disponible tout de suite
                </span>
                <span className="text-[13.5px] text-ink-muted">
                  Désactivée, elle reste enregistrée mais ne peut pas être
                  attribuée.
                </span>
              </span>
              <Switch
                checked={draft.active}
                onChange={(event) => change({ active: event.target.checked })}
              />
            </label>
          )}
        </fieldset>

        <p className="text-[13.5px] text-ink-muted">
          Une récompense attribuée s’applique à la main lors de la visite : rien
          n’est déduit automatiquement d’une réservation ni encaissé.
        </p>

        <div ref={feedbackRef} className="flex flex-col gap-3 empty:hidden">
          {write.status === "error" ? (
            <WriteError error={write.error}>
              {editing
                ? "La récompense n’a pas été modifiée."
                : "La récompense n’a pas été créée."}
            </WriteError>
          ) : null}
          {write.status === "idempotency" ? (
            <Notice
              tone="warning"
              title="Demande déjà utilisée"
              action={
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => void submit({ asNew: true })}
                >
                  Créer comme nouvelle récompense
                </button>
              }
            >
              Cette demande a déjà servi à créer une autre récompense. Vérifie
              ta liste avant d’en créer une nouvelle.
            </Notice>
          ) : null}
          {write.status === "conflict" ? (
            <RewardConflict
              write={write}
              currency={currency}
              services={services}
              onRetryRead={() => base && void readCurrent(base.id)}
              onTakeCurrent={(current) => {
                setBase(current);
                setDraft(rewardDraft(current));
                setErrors({});
                setWrite({ status: "idle" });
              }}
              onKeepMine={(current) => {
                setBase(current);
                setWrite({ status: "idle" });
              }}
              onClose={onClose}
            />
          ) : null}
        </div>
      </form>
    </Sheet>
  );
}

function RewardConflict({
  write,
  currency,
  services,
  onRetryRead,
  onTakeCurrent,
  onKeepMine,
  onClose,
}: {
  write: Extract<Write, { status: "conflict" }>;
  currency: string;
  services: ServiceView[];
  onRetryRead: () => void;
  onTakeCurrent: (current: RewardDto) => void;
  onKeepMine: (current: RewardDto) => void;
  onClose: () => void;
}) {
  const { current } = write;
  if (current === "reading")
    return <Notice tone="warning">Lecture de la version actuelle…</Notice>;
  if (write.error)
    return (
      <WriteError
        error={write.error}
        action={
          <button type="button" className={linkAction} onClick={onRetryRead}>
            Relire la récompense
          </button>
        }
      >
        La récompense a été modifiée ailleurs, et sa version actuelle n’a pas pu
        être lue.
      </WriteError>
    );
  if (current === null)
    return (
      <Notice
        tone="warning"
        title="Récompense introuvable"
        action={
          <button type="button" className={linkAction} onClick={onClose}>
            Fermer
          </button>
        }
      >
        Elle n’existe plus. Rien n’a été enregistré.
      </Notice>
    );
  const serviceName =
    services.find((service) => service.id === current.serviceId)?.name ?? null;
  return (
    <Notice
      tone="warning"
      title="Récompense modifiée entre-temps"
      action={
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <button
            type="button"
            className={linkAction}
            onClick={() => onTakeCurrent(current)}
          >
            Reprendre la version actuelle
          </button>
          <button
            type="button"
            className={linkAction}
            onClick={() => onKeepMine(current)}
          >
            Garder mes modifications
          </button>
        </div>
      }
    >
      Rien n’a été enregistré. Version actuelle : « {current.name} »,{" "}
      {current.pointsRequired.toLocaleString("fr-FR")} points,{" "}
      {rewardValueLabel({
        ...current,
        currency: current.currency ?? currency,
        serviceName,
      }).toLowerCase()}
      , {current.active ? "active" : "désactivée"}. En gardant tes
      modifications, vérifie-les puis enregistre à nouveau.
    </Notice>
  );
}
