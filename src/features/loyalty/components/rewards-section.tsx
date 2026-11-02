"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import type { RequestKey } from "@/features/agenda/client/request-id";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  listRewardsAction,
  updateRewardAction,
} from "@/features/loyalty/actions/loyalty";
import type { ServiceView } from "@/features/services/client/service-form";

import { points, rewardValueLabel } from "../client/format";
import { toggleCommand } from "../client/reward-form";
import type { RewardDto } from "../types";
import {
  Badge,
  Card,
  WriteError,
  linkAction,
  smallButton,
} from "./loyalty-parts";
import { RewardSheet, type RewardSheetTarget } from "./reward-sheet";

/** A row action in progress, refused, or explained. */
type RowState =
  | { id: string; status: "saving" }
  | { id: string; status: "error"; error: UiError }
  | { id: string; status: "stale" }
  | { id: string; status: "needs_service" };

/**
 * The business's rewards: list, create, edit, activate or deactivate. A
 * reward is never deleted (the backend has no deletion); an inactive one is
 * kept, marked as such, and cannot be issued. Each change is shown once the
 * backend confirmed it.
 */
export function RewardsSection({
  rewards,
  services,
  currency,
  programActive,
  onRewards,
}: {
  rewards: RewardDto[];
  services: ServiceView[];
  currency: string;
  programActive: boolean;
  onRewards: (update: (rewards: RewardDto[]) => RewardDto[]) => void;
}) {
  const [sheet, setSheet] = useState<RewardSheetTarget | null>(null);
  const [sheetRun, setSheetRun] = useState(0);
  const [row, setRow] = useState<RowState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const creationKeyRef = useRef<RequestKey | null>(null);
  const sending = useRef(false);
  const serviceName = (id: string | null) =>
    services.find((service) => service.id === id)?.name ?? null;

  function open(target: RewardSheetTarget) {
    setAnnouncement("");
    setSheetRun((value) => value + 1);
    setSheet(target);
  }

  function replace(reward: RewardDto) {
    onRewards((list) =>
      list.some((item) => item.id === reward.id)
        ? list.map((item) => (item.id === reward.id ? reward : item))
        : [...list, reward].sort(
            (a, b) =>
              a.pointsRequired - b.pointsRequired ||
              a.name.localeCompare(b.name, "fr"),
          ),
    );
  }

  async function toggle(reward: RewardDto) {
    if (sending.current) return;
    const command = toggleCommand(reward);
    if (!command) {
      setRow({ id: reward.id, status: "needs_service" });
      return;
    }
    sending.current = true;
    setAnnouncement("");
    setRow({ id: reward.id, status: "saving" });
    const result = await callAction(() => updateRewardAction(command));
    sending.current = false;
    if (result.ok) {
      replace(result.data);
      setRow(null);
      setAnnouncement(
        result.data.active
          ? `« ${result.data.name} » est disponible.`
          : `« ${result.data.name} » est désactivée.`,
      );
      return;
    }
    if (result.error.code === "stale_reward") {
      // The list as it is now; nothing was changed.
      const fresh = await callAction(() => listRewardsAction());
      if (fresh.ok) onRewards(() => fresh.data);
      setRow({ id: reward.id, status: "stale" });
      return;
    }
    setRow({ id: reward.id, status: "error", error: result.error });
  }

  return (
    <Card
      title="Récompenses"
      description="Ce que tes clientes obtiennent avec leurs points. Tu les attribues depuis la fiche cliente."
      action={
        <Button
          size="md"
          icon={<PlusIcon size={17} />}
          onClick={() => open({ mode: "create" })}
        >
          Nouvelle récompense
        </Button>
      }
    >
      {announcement ? <Notice tone="success">{announcement}</Notice> : null}
      {!programActive && rewards.length > 0 ? (
        <Notice tone="info">
          Programme en pause : les récompenses ne peuvent pas être attribuées
          pour l’instant.
        </Notice>
      ) : null}

      {rewards.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-line-strong px-4 py-5">
          <p className="text-[15px] font-medium text-ink">
            Aucune récompense pour l’instant
          </p>
          <p className="text-[14px] text-ink-muted">
            Par exemple : 5 € de remise pour 50 points, ou un remplissage offert
            pour 100 points.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {rewards.map((reward) => {
            const state = row?.id === reward.id ? row : null;
            const missingService =
              reward.rewardType === "free_service" &&
              (reward.serviceId === null || !serviceName(reward.serviceId));
            return (
              <li
                key={reward.id}
                className="flex flex-col gap-3 rounded-2xl border border-line bg-paper px-4 py-4"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[15.5px] font-semibold wrap-anywhere text-ink">
                        {reward.name}
                      </span>
                      {reward.active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="muted">Désactivée</Badge>
                      )}
                    </span>
                    <span className="text-[14px] text-ink-soft">
                      {points(reward.pointsRequired)} ·{" "}
                      {rewardValueLabel({
                        ...reward,
                        currency: reward.currency ?? currency,
                        serviceName: serviceName(reward.serviceId),
                      })}
                    </span>
                    {reward.description ? (
                      <span className="text-[13.5px] whitespace-pre-line wrap-anywhere text-ink-muted">
                        {reward.description}
                      </span>
                    ) : null}
                    {missingService ? (
                      <span className="text-[13.5px] font-medium text-warning-strong">
                        Indisponible : la prestation offerte n’existe plus.
                        Choisis-en une autre pour la rendre disponible.
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={smallButton}
                      onClick={() => open({ mode: "edit", reward })}
                      aria-label={`Modifier ${reward.name}`}
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      className={smallButton}
                      disabled={state?.status === "saving"}
                      aria-busy={state?.status === "saving" || undefined}
                      onClick={() => void toggle(reward)}
                      aria-label={`${reward.active ? "Désactiver" : "Activer"} ${reward.name}`}
                    >
                      {state?.status === "saving"
                        ? "Un instant…"
                        : reward.active
                          ? "Désactiver"
                          : "Activer"}
                    </button>
                  </div>
                </div>
                {state?.status === "error" ? (
                  <WriteError error={state.error}>
                    Rien n’a été changé.
                  </WriteError>
                ) : state?.status === "stale" ? (
                  <Notice tone="warning" title="Modifiée entre-temps">
                    Rien n’a été changé : la liste est à jour, vérifie la
                    récompense puis réessaie.
                  </Notice>
                ) : state?.status === "needs_service" ? (
                  <Notice
                    tone="warning"
                    action={
                      <button
                        type="button"
                        className={linkAction}
                        onClick={() => {
                          setRow(null);
                          open({ mode: "edit", reward });
                        }}
                      >
                        Choisir la prestation
                      </button>
                    }
                  >
                    Cette récompense n’a plus de prestation offerte : choisis-en
                    une avant de changer sa disponibilité.
                  </Notice>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <RewardSheet
        key={sheetRun}
        target={sheet}
        services={services}
        currency={currency}
        creationKeyRef={creationKeyRef}
        onClose={() => setSheet(null)}
        onSaved={(reward, created) => {
          replace(reward);
          setSheet(null);
          setAnnouncement(
            created
              ? `Récompense « ${reward.name} » créée.`
              : `Récompense « ${reward.name} » modifiée.`,
          );
        }}
      />
    </Card>
  );
}
