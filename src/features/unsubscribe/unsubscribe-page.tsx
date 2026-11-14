"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

import {
  unsubscribeErrors,
  type UnsubscribeActions,
  type UnsubscribeView,
} from "./contract";

// The page behind "se désinscrire": opening it changes nothing; her click
// does. It says exactly what stops (this business's offers on this channel)
// and what does not (appointment reminders), and lets her undo a mistake.

const channelText = { email: "par e-mail", sms: "par SMS" } as const;

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

export function UnsubscribePage({
  token,
  actions,
}: {
  token: string;
  actions: UnsubscribeActions;
}) {
  const [view, setView] = useState<
    UnsubscribeView | "invalid" | "error" | null
  >(null);
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [justWithdrew, setJustWithdrew] = useState(false);

  useEffect(() => {
    let live = true;
    void actions.read(token).then((result) => {
      if (!live) return;
      setView(
        result.ok
          ? result.data
          : result.error.code === unsubscribeErrors.invalid
            ? "invalid"
            : "error",
      );
    });
    return () => {
      live = false;
    };
  }, [actions, token, run]);

  if (view === null)
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-40 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (view === "invalid")
    return (
      <Notice tone="info" title="Ce lien n’est plus valable">
        Pour ne plus recevoir d’offres, utilisez le lien du message le plus
        récent, ou répondez STOP à un SMS.
      </Notice>
    );
  if (view === "error")
    return (
      <Notice
        tone="error"
        title="La page n’a pas pu être chargée"
        action={
          <button
            type="button"
            className={linkAction}
            onClick={() => setRun((n) => n + 1)}
          >
            Réessayer
          </button>
        }
      >
        Rien n’a été modifié.
      </Notice>
    );

  const current = view;
  const what = `les offres envoyées ${channelText[current.channel]} par ${current.businessName}`;

  async function change(withdraw: boolean) {
    setBusy(true);
    setFailed(false);
    const result = withdraw
      ? await actions.withdraw(token)
      : await actions.resubscribe(token);
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === unsubscribeErrors.invalid)
        return setView("invalid");
      return setFailed(true);
    }
    setView(result.data);
    setJustWithdrew(withdraw);
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-[30px] leading-tight text-ink">
        {current.alreadyWithdrawn ? "C’est fait" : "Ne plus recevoir d’offres"}
      </h1>

      {current.alreadyWithdrawn ? (
        <>
          <p className="text-[15.5px] leading-relaxed text-ink">
            Vous ne recevrez plus {what}.
          </p>
          <p className="text-[14px] text-ink-soft">
            Les rappels de vos rendez-vous continuent : ce ne sont pas des
            offres.
          </p>
          {justWithdrew ? (
            <button
              type="button"
              className={linkAction + " w-fit"}
              disabled={busy}
              onClick={() => void change(false)}
            >
              Annuler : continuer à recevoir les offres
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[15.5px] leading-relaxed text-ink">
            Vous ne recevrez plus {what}. Les rappels de vos rendez-vous
            continuent.
          </p>
          <Button
            size="lg"
            state={busy ? "loading" : "idle"}
            loadingLabel="…"
            onClick={() => void change(true)}
          >
            Ne plus recevoir ces offres
          </Button>
        </>
      )}

      {failed ? (
        <Notice tone="error" title="Ça n’a pas abouti">
          Rien n’a été modifié. Réessayez dans un instant.
        </Notice>
      ) : null}
    </div>
  );
}
