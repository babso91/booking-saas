"use client";

import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { SyncStatus } from "@/features/preferences/client/preference-driver";
import type { AppearancePreferences } from "@/features/preferences/model";

import { ambiances, styles, type AmbianceId, type StyleId } from "../palettes";

// What she must know wherever she is: an old look this device could keep on
// her account (nothing is imported without her answer), and choices that are
// not on her account yet. The Apparence page says the latter itself. Above the
// dock on a phone, below the sheets, never taking the focus.

const SETTINGS = "/app/settings/appearance";
const card =
  "fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+6rem)] left-4 z-40 flex flex-col gap-3 rounded-2xl border border-line bg-paper-raised p-4 shadow-lg sm:left-auto sm:w-80 lg:bottom-6";

const modeNames = {
  light: "clair",
  dark: "sombre",
  system: "comme l’appareil",
};

/** "Écrin, sombre" or "Classique, Lin, clair": in words, never a code. */
function describe(look: AppearancePreferences) {
  const style = styles[look.style as StyleId]?.name ?? styles.classique.name;
  const ambiance =
    look.style === "classique"
      ? ambiances[look.ambiance as AmbianceId].name
      : null;
  return [style, ambiance, modeNames[look.mode]].filter(Boolean).join(", ");
}

export function AccountNotice({
  status,
  offer,
  importing,
  onKeep,
  onDecline,
  onRetry,
}: {
  status: SyncStatus;
  offer: AppearancePreferences | null;
  importing: "idle" | "sending" | "failed";
  onKeep: () => void;
  onDecline: () => void;
  onRetry: () => void;
}) {
  const pathname = usePathname();

  if (offer && status !== "unavailable") {
    return (
      <section aria-labelledby="device-look" className={card}>
        <div className="flex flex-col gap-1">
          <h2 id="device-look" className="text-[15px] font-semibold text-ink">
            Garder cette apparence sur votre compte ?
          </h2>
          <p className="text-[13.5px] leading-snug text-ink-soft">
            Cet appareil gardait {describe(offer)}. Sans réponse, rien ne
            change.
          </p>
          {importing === "failed" ? (
            <p role="alert" className="text-[13.5px] text-danger-strong">
              Ça n’a pas pu être enregistré. Rien n’est perdu : tu peux
              réessayer.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="md" onClick={onKeep} disabled={importing === "sending"}>
            {importing === "sending" ? "Un instant…" : "Garder"}
          </Button>
          <Button
            size="md"
            variant="ghost"
            onClick={onDecline}
            disabled={importing === "sending"}
          >
            Non merci
          </Button>
        </div>
      </section>
    );
  }

  if ((status === "retrying" || status === "paused") && pathname !== SETTINGS) {
    return (
      <section role="status" className={card}>
        <p className="text-[13.5px] leading-snug text-ink-soft">
          {status === "retrying"
            ? "Ton apparence n’est pas encore enregistrée sur ton compte. Nouvel essai automatique."
            : "L’enregistrement de ton apparence est en pause : ta session a peut-être changé."}
        </p>
        <div>
          <Button size="md" variant="secondary" onClick={onRetry}>
            Réessayer
          </Button>
        </div>
      </section>
    );
  }
  return null;
}
