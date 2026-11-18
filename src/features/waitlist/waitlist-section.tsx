"use client";

import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { getBookingSettingsAction } from "@/features/availability/actions/schedule";
import { setWaitlistEnabledAction } from "@/features/booking-policy/actions";

/**
 * Her waitlist, open or closed (docs/WAITLIST_CONTRACT.md). Without an email
 * transport nothing can work (no confirmation, no offer): she cannot open
 * it then, and is told why, instead of collecting requests that would
 * never be answered. Closing it stops every open offer, and says so.
 */
export function WaitlistSection({ emailReady }: { emailReady: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [run, setRun] = useState(0);
  const sending = useRef(false);

  useEffect(() => {
    let alive = true;
    void callAction(() => getBookingSettingsAction()).then((result) => {
      if (!alive) return;
      if (result.ok) setEnabled(result.data.waitlistEnabled);
      else setLoadError(result.error);
    });
    return () => {
      alive = false;
    };
  }, [run]);

  async function toggle(next: boolean) {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    setError(null);
    const result = await callAction(() =>
      setWaitlistEnabledAction({ enabled: next }),
    );
    sending.current = false;
    setSaving(false);
    if (result.ok) setEnabled(result.data.enabled);
    else setError(result.error);
  }

  return (
    <section
      aria-labelledby="waitlist-setting"
      className="flex flex-col gap-4 border-t border-line pt-8"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2
            id="waitlist-setting"
            className="font-display text-[22px] leading-tight text-ink"
          >
            Liste d’attente
          </h2>
          <p className="max-w-prose text-[14.5px] text-ink-soft">
            Quand aucun créneau ne leur convient, tes clientes peuvent demander
            à être prévenues. Si un rendez-vous est annulé ou déplacé, la plus
            ancienne demande reçoit un e-mail pendant 20 minutes. Rien n’est
            bloqué : la première qui réserve obtient le créneau.
          </p>
        </div>
        {enabled !== null ? (
          <Switch
            checked={enabled}
            disabled={saving || (!enabled && !emailReady)}
            aria-label="Liste d’attente ouverte"
            onChange={() => void toggle(!enabled)}
          />
        ) : null}
      </div>

      {loadError ? (
        <Notice
          tone={loadError.code === "network" ? "offline" : "error"}
          title={describeError(loadError).title}
          action={
            <button
              type="button"
              className="w-fit cursor-pointer font-semibold underline underline-offset-4"
              onClick={() => {
                setLoadError(null);
                setRun((value) => value + 1);
              }}
            >
              Réessayer
            </button>
          }
        >
          La liste d’attente n’a pas pu être chargée.
        </Notice>
      ) : null}

      {!emailReady ? (
        <Notice tone="info" title="Pas encore disponible pour ton espace">
          Elle fonctionne par e-mail (confirmation, puis offre), et l’envoi
          d’e-mails n’est pas encore activé. Tu pourras l’ouvrir dès qu’il le
          sera.
        </Notice>
      ) : enabled ? (
        <p className="text-[13.5px] text-ink-muted">
          La fermer arrête aussi les offres en cours.
        </p>
      ) : null}

      {error ? (
        <Notice
          tone={error.code === "network" ? "offline" : "error"}
          title={
            error.code === "forbidden"
              ? "Réservé à la propriétaire ou à une admin"
              : describeError(error).title
          }
        >
          Rien n’a été modifié.
        </Notice>
      ) : null}
    </section>
  );
}
