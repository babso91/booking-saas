"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

import type { WaitlistRequestDto } from "./contract";
import {
  confirmWaitlistRequest,
  httpWaitlistActions,
  tokenFromFragment,
} from "./http-actions";
import { WaitlistOffer } from "./waitlist-offer";

// The two pages her emails link to (docs/WAITLIST_CONTRACT.md, « Liens et
// jetons »). The token is in the fragment: read here, in the browser, and
// sent to the API only. Before it is read (server render, first paint),
// nothing is asked and nothing is said about it.

const noSubscription = () => () => {};

/** The fragment's token once in the browser; undefined on the server. */
function useFragmentToken(): string | null | undefined {
  return useSyncExternalStore(
    noSubscription,
    () => tokenFromFragment(window.location.hash),
    () => undefined,
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-14">
      <p className="text-[14px] font-medium text-ink-muted">Liste d’attente</p>
      {children}
    </main>
  );
}

function Incomplete() {
  return (
    <Notice tone="warning" title="Ce lien est incomplet">
      Ouvrez-le directement depuis l’e-mail reçu, sans le recopier : sa fin
      contient ce qui permet de vous reconnaître.
    </Notice>
  );
}

type Confirm =
  | { status: "sending" }
  | { status: "done"; request: WaitlistRequestDto }
  | { status: "gone" }
  | { status: "error"; offline: boolean };

const untilFormat = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** `/liste-attente/confirmer#t=…`: the double opt-in. */
export function WaitlistConfirmPage() {
  const token = useFragmentToken();
  const [state, setState] = useState<Confirm>({ status: "sending" });
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!token) return;
    let current = true;
    void confirmWaitlistRequest(token).then((result) => {
      if (!current) return;
      if (result.ok) setState({ status: "done", request: result.data });
      else if (result.error.code === "waitlist_request_not_found")
        setState({ status: "gone" });
      else
        setState({
          status: "error",
          offline: result.error.code === "network",
        });
    });
    return () => {
      current = false;
    };
  }, [token, run]);

  return (
    <Shell>
      {token === undefined ? null : token === null ? (
        <Incomplete />
      ) : state.status === "sending" ? (
        <p role="status" className="text-[16px] text-ink-soft">
          Confirmation en cours…
        </p>
      ) : state.status === "done" ? (
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[30px] leading-tight text-ink">
            Vous êtes sur la liste d’attente
          </h1>
          <p className="text-[16px] leading-relaxed text-ink-soft">
            Si un créneau se libère dans les moments choisis, vous recevrez un
            e-mail pour le réserver. Le premier qui réserve l’obtient : rien
            n’est mis de côté. Votre demande vaut jusqu’au{" "}
            {untilFormat
              .format(new Date(state.request.activeUntil))
              .replace(/ 1 /, " 1er ")}
            .
          </p>
        </div>
      ) : state.status === "gone" ? (
        <Notice tone="info" title="Ce lien n’est plus valable">
          Il a expiré ou a déjà servi. Si besoin, inscrivez-vous de nouveau
          depuis la page de réservation.
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <Notice
            tone={state.offline ? "offline" : "error"}
            title={
              state.offline ? "Pas de réponse" : "La confirmation a échoué"
            }
          >
            Rien n’a été perdu : vous pouvez réessayer.
          </Notice>
          <Button
            variant="secondary"
            size="md"
            className="w-fit"
            onClick={() => {
              setState({ status: "sending" });
              setRun((value) => value + 1);
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
    </Shell>
  );
}

/** `/liste-attente/offre/[offerId]#t=…`: the offer, and booking it. */
export function WaitlistOfferLinkPage({ offerId }: { offerId: string }) {
  const token = useFragmentToken();
  // Stable for the offer screen (its reads depend on the actions).
  const actions = useMemo(
    () => (token ? httpWaitlistActions(token) : null),
    [token],
  );
  return (
    <Shell>
      {token === undefined ? null : actions ? (
        <WaitlistOffer offerId={offerId} actions={actions} />
      ) : (
        <Incomplete />
      )}
    </Shell>
  );
}
