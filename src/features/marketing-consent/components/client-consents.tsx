"use client";

import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { callAction } from "@/features/auth/client/call-action";
import {
  getClientConsentsAction,
  setConsentAction,
} from "@/features/marketing-consent/actions";
import type { ConsentDto } from "@/features/marketing-consent/data";

/**
 * Whether this client may receive offers, per channel
 * (docs/MARKETING_CONSENT_CONTRACT.md). Only an explicit agreement allows
 * marketing; reminders never read this. Here she can note that the client
 * does not want offers any more. Recording an agreement needs the version
 * of the wording the client accepted: it comes with the campaigns, whose
 * wording is still to be validated, so it is not offered here.
 */

const channelLabel = { email: "Par e-mail", sms: "Par SMS" } as const;

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function stateText(consent: ConsentDto) {
  const when = consent.changedAt
    ? ` le ${dateFormat.format(new Date(consent.changedAt)).replace(/^1 /, "1er ")}`
    : "";
  if (consent.state === "granted") return `Accord donné${when}`;
  if (consent.state === "withdrawn")
    return consent.source === "unsubscribe_link"
      ? `Désinscrite depuis un message${when}`
      : `Ne veut plus d’offres${when}`;
  return "Aucun accord : elle ne reçoit pas d’offres";
}

type Load =
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; consents: ConsentDto[] };

export function ClientConsents({ clientId }: { clientId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    let alive = true;
    void callAction(() => getClientConsentsAction({ clientId })).then(
      (result) => {
        if (!alive) return;
        setLoad(
          result.ok
            ? { status: "ready", consents: result.data }
            : { status: "error", code: result.error.code },
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [clientId, run]);

  async function withdraw(consent: ConsentDto) {
    if (busy) return;
    // One id per change: a retry after a lost answer never writes twice.
    const key = `${consent.channel}:${consent.changedAt ?? "none"}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy(consent.channel);
    setError(null);
    const result = await callAction(() =>
      setConsentAction({
        clientId,
        purpose: "marketing",
        channel: consent.channel,
        action: "withdraw",
        requestId: requestIds.current.get(key)!,
      }),
    );
    setBusy(null);
    if (!result.ok) {
      setError(
        result.error.code === "network"
          ? "Pas de réponse : rien n’a peut-être été noté. Réessaie."
          : "Ça n’a pas été noté. Réessaie dans un instant.",
      );
      return;
    }
    setLoad((value) =>
      value.status === "ready"
        ? {
            status: "ready",
            consents: value.consents.map((item) =>
              item.channel === result.data.channel ? result.data : item,
            ),
          }
        : value,
    );
  }

  return (
    <section
      aria-labelledby="client-consents"
      className="flex flex-col gap-3 border-t border-line pt-5"
    >
      <h2
        id="client-consents"
        className="font-display text-[22px] leading-tight text-ink"
      >
        Offres et nouveautés
      </h2>
      {load.status === "loading" ? (
        <span className="h-16 animate-pulse rounded-xl bg-sand/60" />
      ) : load.status === "error" ? (
        <Notice
          tone={load.code === "network" ? "offline" : "error"}
          title="Les accords n’ont pas pu être chargés"
          action={
            <button
              type="button"
              className="w-fit cursor-pointer font-semibold underline underline-offset-4"
              onClick={() => {
                setLoad({ status: "loading" });
                setRun((value) => value + 1);
              }}
            >
              Réessayer
            </button>
          }
        >
          Rien n’a été modifié.
        </Notice>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-line">
            {load.consents.map((consent) => (
              <li
                key={consent.channel}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-[14.5px] font-semibold text-ink">
                    {channelLabel[consent.channel]}
                  </span>
                  <span className="text-[13.5px] text-ink-soft">
                    {stateText(consent)}
                  </span>
                </span>
                {consent.state === "granted" ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void withdraw(consent)}
                    className="cursor-pointer text-[13.5px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy === consent.channel
                      ? "Enregistrement…"
                      : "Elle ne veut plus d’offres"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-ink-muted">
            Les rappels de rendez-vous ne sont pas des offres : ils partent dans
            tous les cas.
          </p>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </>
      )}
    </section>
  );
}
