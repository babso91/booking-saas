"use client";

import { useState } from "react";

import { CampaignPlanner, CampaignStatus } from "./campaign-planner";
import { memoryCampaigns } from "./memory-actions";

/**
 * Campaigns on fictional clients, kept in this page's memory only: to
 * review the screens before the backend exists. Nothing is sent, ever.
 * Never part of a real page.
 */
export function CampaignPreview() {
  const [server] = useState(() =>
    memoryCampaigns({ delayMs: 400, now: Date.now }),
  );
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : clientes fictives, gardées en mémoire. Aucun message n’est
        envoyé.
      </p>
      {campaignId ? (
        <>
          <CampaignStatus
            campaignId={campaignId}
            actions={server.actions}
            refreshKey={tick}
          />
          <button
            type="button"
            className="w-fit cursor-pointer rounded-full border border-dashed border-line-strong px-4 py-2 text-[13px] text-ink-muted"
            onClick={() => {
              server.advance(campaignId);
              setTick((n) => n + 1);
            }}
          >
            Outil d’aperçu : faire avancer l’envoi simulé
          </button>
        </>
      ) : (
        <CampaignPlanner
          services={[
            { id: "s-gel", name: "Remplissage gel" },
            { id: "s-lift", name: "Rehaussement de cils" },
          ]}
          actions={server.actions}
          onScheduled={(campaign) => setCampaignId(campaign.campaignId)}
        />
      )}
    </main>
  );
}
