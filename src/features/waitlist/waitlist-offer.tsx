"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import {
  dayLabel,
  wallTime,
} from "@/features/public-booking/client/business-time";

import {
  offerErrors,
  type WaitlistActions,
  type WaitlistOfferDto,
} from "./contract";

// A slot freed up and was offered to her (the client). She books it in one
// tap, or it goes on. Nothing is held: the first booking committed wins, and
// if someone else was faster her request stays active. The countdown is a
// guide; the server's clock decides.

type View =
  | { status: "loading" }
  | { status: "gone" }
  | { status: "error" }
  | { status: "ready"; offer: WaitlistOfferDto };

export function WaitlistOffer({
  offerId,
  actions,
}: {
  offerId: string;
  actions: WaitlistActions;
}) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<{
    tone: "error" | "warning" | "offline";
    title: string;
    message: string;
  } | null>(null);
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    void actions.offer(offerId).then((result) => {
      if (!current) return;
      if (result.ok) setView({ status: "ready", offer: result.data });
      else
        setView({
          status: result.error.code === offerErrors.notFound ? "gone" : "error",
        });
    });
    return () => {
      current = false;
    };
  }, [actions, offerId, run]);

  const reread = () => setRun((value) => value + 1);

  async function claim(offer: WaitlistOfferDto) {
    if (sending) return;
    // One id for this offer at this version: a retry never books twice.
    requestId.current ??= crypto.randomUUID();
    setSending(true);
    setSaid(null);
    const result = await actions.claim({
      offerId: offer.id,
      requestId: requestId.current,
      expectedVersion: offer.version,
      expectedQuoteRevision: offer.quoteRevision,
    });
    setSending(false);
    if (result.ok) return setView({ status: "ready", offer: result.data });
    const code = result.error.code;
    if (code === "network")
      return setSaid({
        tone: "offline",
        title: "Pas de réponse",
        message:
          "Rien ne dit que c’est réservé. Réessayez : la même demande ne réserve jamais deux fois.",
      });
    // Anything else: this request is done; the offer is read again.
    requestId.current = null;
    setSaid(
      code === offerErrors.quoteChanged
        ? {
            tone: "warning",
            title: "Le prix ou la durée a changé",
            message:
              "Rien n’a été réservé. Voici l’offre à jour : confirmez de nouveau si elle vous convient.",
          }
        : code === offerErrors.expired
          ? {
              tone: "warning",
              title: "L’offre a expiré",
              message: "Rien n’a été réservé.",
            }
          : code === offerErrors.unavailable
            ? {
                tone: "warning",
                title: "Ce créneau vient d’être réservé",
                message:
                  "Quelqu’un a été plus rapide. Rien n’a été réservé pour vous.",
              }
            : {
                tone: "error",
                title: "La réservation n’a pas abouti",
                message: "Rien n’a été réservé. Réessayez dans un instant.",
              },
    );
    reread();
  }

  if (view.status === "loading")
    return (
      <div role="status" aria-label="Chargement de l’offre…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (view.status === "gone")
    return (
      <Notice tone="info" title="Offre introuvable">
        Ce lien ne correspond à aucune offre en cours. Il a peut-être expiré.
      </Notice>
    );
  if (view.status === "error")
    return (
      <Notice
        tone="error"
        title="L’offre n’a pas pu être chargée"
        action={
          <button
            type="button"
            onClick={() => {
              setView({ status: "loading" });
              reread();
            }}
            className="cursor-pointer text-[14px] font-semibold text-ink underline underline-offset-4"
          >
            Réessayer
          </button>
        }
      >
        Rien n’a été réservé.
      </Notice>
    );

  const { offer } = view;
  const day = dayLabel(offer.localStartsAt.slice(0, 10));
  const time = wallTime(offer.localStartsAt);

  return (
    <article aria-labelledby="offer-title" className="flex flex-col gap-5">
      {said ? (
        <Notice tone={said.tone} title={said.title}>
          {said.message}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-4 rounded-[28px] border border-line bg-paper-raised p-6">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
          {offer.businessName}
        </p>
        <h1
          id="offer-title"
          className="font-display text-[32px] leading-[1.05] text-ink"
        >
          {offer.state === "booked"
            ? "C’est réservé"
            : offer.state === "expired"
              ? "Cette offre a expiré"
              : offer.state === "unavailable"
                ? "Ce créneau a été réservé"
                : "Un créneau s’est libéré"}
        </h1>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[20px] border border-line bg-line">
          <Fact label="Prestation" wide>
            {offer.serviceName}
          </Fact>
          <Fact label="Quand">
            <span className="inline-block first-letter:uppercase">{day}</span> ·{" "}
            {time}
          </Fact>
          <Fact label="Prix">
            {formatPrice(offer.priceCents, offer.currency)}
          </Fact>
        </dl>

        {offer.state === "offered" ? (
          <>
            <Remaining expiresAt={offer.expiresAt} onExpired={reread} />
            <Button
              size="lg"
              state={sending ? "loading" : "idle"}
              loadingLabel="Réservation…"
              onClick={() => void claim(offer)}
            >
              {said?.tone === "offline" ? "Réessayer" : "Réserver ce créneau"}
            </Button>
            <p className="text-[13px] text-ink-muted">
              Ce créneau n’est pas mis de côté : il revient à la première
              personne qui le réserve.
            </p>
          </>
        ) : offer.state === "booked" ? (
          <p className="text-[15px] text-ink-soft">
            Votre rendez-vous est confirmé {day} à {time}.
          </p>
        ) : (
          <p className="text-[15px] text-ink-soft">
            {offer.state === "expired"
              ? "Cette offre a expiré."
              : "Ce créneau n’est plus disponible."}{" "}
            {offer.requestActive
              ? "Votre demande reste active : vous serez prévenue si un autre créneau se libère."
              : "Votre demande n’est plus active."}
          </p>
        )}
      </div>
    </article>
  );
}

/** A guide only: when it reaches zero, the offer is read from the server. */
function Remaining({
  expiresAt,
  onExpired,
}: {
  expiresAt: string;
  onExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const ended = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (left === 0 && !ended.current) {
      ended.current = true;
      onExpired();
    }
  }, [left, onExpired]);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return (
    <p className="text-[14px] text-ink-soft">
      Offre valable encore{" "}
      <span className="font-semibold text-ink tabular-nums">
        {minutes} min {String(seconds).padStart(2, "0")} s
      </span>
    </p>
  );
}

function Fact({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={
        wide
          ? "col-span-2 bg-paper-raised px-4 py-3"
          : "bg-paper-raised px-4 py-3"
      }
    >
      <dt className="text-[12.5px] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[15.5px] font-semibold text-ink">
        {children}
      </dd>
    </div>
  );
}
