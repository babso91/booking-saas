"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";

import {
  money,
  offerErrors,
  type OfferQuote,
  type OfferQuoteActions,
  type QuoteInput,
} from "./contract";

// The exact price of the slot she chose, from the server: base, options,
// discount, total and deposit kept apart, with the time it holds until.
// A code refused leaves her slot chosen. A price that changed before
// booking (offer used up, quote expired) is never applied silently: the
// new total waits for her explicit confirmation, her details kept.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const clock = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(new Date(iso));

type Changed = { before: number; after: OfferQuote; reason: string };

export function QuoteSummary({
  input,
  serviceName,
  slotLabel,
  actions,
  onChooseAnotherSlot,
}: {
  input: Omit<QuoteInput, "coupon">;
  serviceName: string;
  slotLabel: string;
  actions: OfferQuoteActions;
  onChooseAnotherSlot: () => void;
}) {
  const [quote, setQuote] = useState<OfferQuote | "error" | null>(null);
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponText, setCouponText] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [changed, setChanged] = useState<Changed | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState<"quote" | "confirm" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [booked, setBooked] = useState<number | null>(null);
  const [run, setRun] = useState(0);
  const requestIds = useRef(new Map<string, string>());

  const inputKey = JSON.stringify(input);
  useEffect(() => {
    let current = true;
    const asked = JSON.parse(inputKey) as Omit<QuoteInput, "coupon">;
    void actions.quote(asked).then((result) => {
      if (!current) return;
      if (result.ok) return setQuote(result.data);
      if (result.error.code === offerErrors.slotUnavailable) setGone(true);
      setQuote("error");
    });
    return () => {
      current = false;
    };
  }, [actions, inputKey, run]);

  if (gone)
    return (
      <Notice
        tone="warning"
        title="Ce créneau vient d’être pris"
        action={
          <button
            type="button"
            className={linkAction}
            onClick={onChooseAnotherSlot}
          >
            Choisir un autre créneau
          </button>
        }
      >
        Rien n’a été réservé. Votre prestation et vos coordonnées sont
        conservées.
      </Notice>
    );
  if (quote === null)
    return (
      <div role="status" aria-label="Calcul du prix…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (quote === "error")
    return (
      <Notice
        tone="error"
        title="Le prix n’a pas pu être calculé"
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
        Rien n’a été réservé.
      </Notice>
    );

  if (booked !== null)
    return (
      <Notice tone="success" title="C’est réservé">
        {serviceName}, {slotLabel}, pour {money(booked, quote.currency)}.
      </Notice>
    );

  async function requote(nextCoupon: string | null) {
    setBusy("quote");
    const result = await actions.quote({
      ...input,
      ...(nextCoupon ? { coupon: nextCoupon } : {}),
    });
    setBusy(null);
    return result;
  }

  async function applyCoupon() {
    const code = couponText.trim();
    if (!code) return setCouponError("Saisissez un code.");
    setCouponError(null);
    const result = await requote(code);
    if (result.ok) {
      setCoupon(code);
      setQuote(result.data);
      setCouponOpen(false);
      return;
    }
    if (result.error.code === offerErrors.slotUnavailable) return setGone(true);
    // One generic reason: never which rule refused it.
    setCouponError(
      result.error.code === offerErrors.couponRefused
        ? "Ce code ne peut pas être utilisé pour ce créneau. Votre créneau reste choisi."
        : "Le code n’a pas pu être vérifié. Réessayez.",
    );
  }

  async function removeCoupon() {
    const result = await requote(null);
    if (!result.ok)
      return setNotice("Le prix n’a pas pu être recalculé. Réessayez.");
    setCoupon(null);
    setCouponText("");
    setQuote(result.data);
  }

  async function book(target: OfferQuote) {
    if (busy) return;
    if (!requestIds.current.has(target.quoteRef))
      requestIds.current.set(target.quoteRef, crypto.randomUUID());
    setBusy("confirm");
    setNotice(null);
    const result = await actions.confirm({
      quoteRef: target.quoteRef,
      requestId: requestIds.current.get(target.quoteRef)!,
    });
    setBusy(null);
    if (result.ok) return setBooked(result.data.totalCents);
    const code = result.error.code;
    if (code === offerErrors.slotUnavailable) return setGone(true);
    if (
      code === offerErrors.quoteChanged ||
      code === offerErrors.offerUnavailable
    ) {
      const fresh = await requote(coupon);
      if (!fresh.ok) {
        if (fresh.error.code === offerErrors.slotUnavailable)
          return setGone(true);
        return setNotice(
          "Le prix a changé et n’a pas pu être recalculé. Rien n’a été réservé.",
        );
      }
      return setChanged({
        before: target.totalCents,
        after: fresh.data,
        reason:
          code === offerErrors.offerUnavailable
            ? "L’offre vient d’être épuisée."
            : "Le prix a été mis à jour.",
      });
    }
    setNotice(
      code === "network"
        ? "Pas de réponse. Réessayez : une même réservation n’est jamais faite deux fois."
        : "La réservation n’a pas abouti. Rien n’a été réservé.",
    );
  }

  const shown = changed?.after ?? quote;
  const rows: [string, string][] = [
    [serviceName, money(shown.baseCents, shown.currency)],
  ];
  if (shown.optionsCents)
    rows.push(["Options", money(shown.optionsCents, shown.currency)]);
  if (shown.discountCents)
    rows.push([
      shown.discountLabel ?? "Remise",
      `−${money(shown.discountCents, shown.currency)}`,
    ]);

  return (
    <section aria-label="Récapitulatif du prix" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[24px] leading-tight text-ink">
          Votre rendez-vous
        </h2>
        <p className="text-[14.5px] text-ink-soft first-letter:uppercase">
          {slotLabel}
        </p>
      </div>

      <dl className="flex flex-col gap-2 rounded-3xl border border-line bg-paper-raised px-5 py-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 text-[15px]">
            <dt className="text-ink-soft">{label}</dt>
            <dd className="tabular-nums text-ink">{value}</dd>
          </div>
        ))}
        <div className="mt-1 flex justify-between gap-4 border-t border-line pt-3 text-[17px] font-semibold">
          <dt className="text-ink">Total</dt>
          <dd className="tabular-nums text-ink">
            {money(shown.totalCents, shown.currency)}
          </dd>
        </div>
        {shown.depositCents ? (
          <div className="flex justify-between gap-4 text-[13.5px]">
            <dt className="text-ink-muted">Acompte demandé (à part)</dt>
            <dd className="tabular-nums text-ink-muted">
              {money(shown.depositCents, shown.currency)}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="-mt-2 text-[13px] text-ink-muted">
        Prix garanti jusqu’à {clock(shown.validUntil)}. Aucun paiement sur cette
        page.
      </p>

      {!changed ? (
        coupon ? (
          <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink-soft">
            Code {coupon.toUpperCase()} appliqué.
            <button
              type="button"
              className={linkAction}
              disabled={busy !== null}
              onClick={() => void removeCoupon()}
            >
              Retirer le code
            </button>
          </p>
        ) : couponOpen ? (
          <div className="flex flex-col gap-2">
            <TextField
              label="Code"
              name="coupon"
              autoComplete="off"
              autoCapitalize="characters"
              value={couponText}
              error={couponError ?? undefined}
              onChange={(event) => {
                setCouponText(event.target.value);
                setCouponError(null);
              }}
            />
            <Button
              size="md"
              variant="secondary"
              state={busy === "quote" ? "loading" : "idle"}
              loadingLabel="Vérification…"
              onClick={() => void applyCoupon()}
            >
              Appliquer
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className={linkAction + " w-fit"}
            onClick={() => setCouponOpen(true)}
          >
            J’ai un code
          </button>
        )
      ) : null}

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      {changed ? (
        <div
          className="flex flex-col gap-3 rounded-3xl border border-ink px-5 py-4"
          role="alert"
        >
          <p className="text-[15px] text-ink">
            {changed.reason} Le total passe de{" "}
            <strong className="tabular-nums">
              {money(changed.before, shown.currency)}
            </strong>{" "}
            à{" "}
            <strong className="tabular-nums">
              {money(changed.after.totalCents, shown.currency)}
            </strong>
            . Rien n’a été réservé ; vos coordonnées sont conservées.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="md"
              state={busy === "confirm" ? "loading" : "idle"}
              loadingLabel="Réservation…"
              onClick={() => {
                const target = changed.after;
                setChanged(null);
                setQuote(target);
                void book(target);
              }}
            >
              Réserver pour {money(changed.after.totalCents, shown.currency)}
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={busy !== null}
              onClick={onChooseAnotherSlot}
            >
              Choisir un autre créneau
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="lg"
          state={busy === "confirm" ? "loading" : "idle"}
          loadingLabel="Réservation…"
          disabled={busy === "quote"}
          onClick={() => void book(quote)}
        >
          Réserver pour {money(quote.totalCents, quote.currency)}
        </Button>
      )}
    </section>
  );
}
