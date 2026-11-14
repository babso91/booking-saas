"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  billingErrors,
  type BillingActions,
  type BillingSummaryDto,
  type InvoiceDto,
} from "./contract";

// Her subscription and invoices. A late payment is shown here only, with
// how long her rights are kept; a cancellation says what happens to her
// site and appointments before she confirms, then gives a receipt and can
// be undone until it takes effect. Invoices say whether they are being
// prepared, issued or unavailable; an unknown amount is never a zero.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

const day = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

const month = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(iso));

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency })
    .format(minor / 100)
    .replace(/[,.]00(?=\s)/, "");

const planNames = { core: "Core", signature: "Signature" } as const;

export function BillingSummary({ actions }: { actions: BillingActions }) {
  const [summary, setSummary] = useState<BillingSummaryDto | "error" | null>(
    null,
  );
  const [invoices, setInvoices] = useState<InvoiceDto[] | "error" | null>(null);
  const [run, setRun] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "error" | "success" | "info";
    text: string;
  } | null>(null);
  const operations = useRef(new Map<string, string>());
  const opFor = (key: string) => {
    if (!operations.current.has(key))
      operations.current.set(key, crypto.randomUUID());
    return operations.current.get(key)!;
  };

  useEffect(() => {
    let live = true;
    void actions
      .summary()
      .then((result) => live && setSummary(result.ok ? result.data : "error"));
    void actions
      .invoices()
      .then((result) => live && setInvoices(result.ok ? result.data : "error"));
    return () => {
      live = false;
    };
  }, [actions, run]);

  const reload = () => setRun((n) => n + 1);

  if (summary === null)
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (summary === "error")
    return (
      <Notice
        tone="error"
        title="Ton abonnement n’a pas pu être chargé"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      />
    );

  const current = summary;

  function failed(code: string) {
    if (code === billingErrors.stateChanged) {
      setCancelling(false);
      reload();
      return setNotice({
        tone: "info",
        text: "Ton abonnement a changé entre-temps : voici son état à jour. Rien n’a été modifié.",
      });
    }
    setNotice({
      tone: "error",
      text:
        code === billingErrors.permissionDenied
          ? "Seule la propriétaire peut gérer l’abonnement."
          : code === "network"
            ? "Pas de réponse. Réessaie : une même demande n’est jamais faite deux fois."
            : "Ça n’a pas abouti. Rien n’a été modifié.",
    });
  }

  async function cancel() {
    setBusy(true);
    setNotice(null);
    const result = await actions.requestCancellation({
      expectedRevision: current.revision,
      operationId: opFor(`cancel:${current.revision}`),
    });
    setBusy(false);
    if (!result.ok) return failed(result.error.code);
    setSummary(result.data.summary);
    setCancelling(false);
    setNotice({
      tone: "success",
      text: `Résiliation enregistrée (reçu ${result.data.receiptId}). Ton abonnement reste actif jusqu’au ${day(result.data.summary.cancellation!.effectiveAt)}.`,
    });
  }

  async function undo() {
    setBusy(true);
    setNotice(null);
    const result = await actions.undoCancellation({
      expectedRevision: current.revision,
      operationId: opFor(`undo:${current.revision}`),
    });
    setBusy(false);
    if (!result.ok) return failed(result.error.code);
    setSummary(result.data);
    setNotice({
      tone: "success",
      text: "Résiliation annulée : ton abonnement continue.",
    });
  }

  async function portal() {
    setNotice(null);
    const result = await actions.openPortal();
    if (result.ok) return window.location.assign(result.data.url);
    setNotice({
      tone: "info",
      text:
        result.error.code === billingErrors.unavailable
          ? "Le moyen de paiement ne peut pas encore être géré ici : aucun prestataire de paiement n’est relié."
          : "Le portail n’a pas pu s’ouvrir. Réessaie.",
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] leading-tight text-ink">
          Facturation
        </h1>
        <p className="text-[15px] text-ink-soft">
          Formule{" "}
          <strong className="font-semibold text-ink">
            {planNames[current.plan]}
          </strong>
          {current.state === "trialing"
            ? " · essai"
            : current.state === "ended"
              ? " · terminée"
              : ""}
        </p>
      </header>

      {current.simulated ? (
        <p className="rounded-2xl border border-dashed border-line-strong bg-sand/50 px-4 py-3 text-[13.5px] text-ink-soft">
          <strong className="font-semibold text-ink">Simulé.</strong> Aucun
          prestataire de paiement n’est relié : les documents ci-dessous sont
          des exemples, pas de vraies factures.
        </p>
      ) : null}

      {current.state === "past_due" && current.graceUntil ? (
        <Notice tone="warning" title="Le dernier paiement n’est pas passé">
          Tout continue jusqu’au {day(current.graceUntil)} : ton site, tes
          réservations et tes rappels. Mets à jour ton moyen de paiement avant
          cette date. Tes clientes ne voient rien.
        </Notice>
      ) : null}

      {notice ? (
        <Notice
          tone={notice.tone}
          title={
            notice.tone === "error"
              ? "À revoir"
              : notice.tone === "success"
                ? "C’est fait"
                : "À savoir"
          }
        >
          {notice.text}
        </Notice>
      ) : null}

      <section
        aria-label="Abonnement"
        className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-4"
      >
        {current.cancellation ? (
          <>
            <p className="text-[15px] text-ink">
              Résiliation prévue le{" "}
              <strong className="font-semibold">
                {day(current.cancellation.effectiveAt)}
              </strong>
              . D’ici là, tout fonctionne normalement.
            </p>
            <button
              type="button"
              className={cn(linkAction, "w-fit")}
              disabled={busy}
              onClick={() => void undo()}
            >
              Annuler la résiliation
            </button>
          </>
        ) : current.state === "ended" ? (
          <p className="text-[15px] text-ink">
            Ton abonnement est terminé. Tes factures restent consultables.
          </p>
        ) : (
          <>
            {current.renewsAt && current.state !== "past_due" ? (
              <p className="text-[15px] text-ink">
                Prochain renouvellement le {day(current.renewsAt)}.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <button
                type="button"
                className={linkAction}
                onClick={() => void portal()}
              >
                Gérer le moyen de paiement
              </button>
              {!cancelling ? (
                <button
                  type="button"
                  className={cn(linkAction, "text-danger")}
                  onClick={() => setCancelling(true)}
                >
                  Résilier…
                </button>
              ) : null}
            </div>
          </>
        )}

        {cancelling && !current.cancellation ? (
          <div className="flex flex-col gap-3 rounded-2xl bg-danger-soft/40 px-4 py-3">
            <p className="text-[15px] font-medium text-ink">
              Résilier ton abonnement ?
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] text-ink">
              <li>
                Il reste actif jusqu’au{" "}
                {current.renewsAt
                  ? day(current.renewsAt)
                  : "terme de la période en cours"}{" "}
                ; rien n’est remboursé ni débité en plus.
              </li>
              <li>
                {current.upcomingAppointments
                  ? `Tes ${current.upcomingAppointments} rendez-vous à venir restent dans ton agenda, avec leurs rappels, jusqu’à cette date.`
                  : "Tu n’as pas de rendez-vous à venir."}
              </li>
              <li>
                Ensuite, ton site n’accepte plus de réservations ; tes factures
                restent consultables.
              </li>
              <li>Tu peux annuler la résiliation jusqu’à cette date.</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                size="md"
                variant="danger"
                state={busy ? "loading" : "idle"}
                loadingLabel="…"
                onClick={() => void cancel()}
              >
                Confirmer la résiliation
              </Button>
              <Button
                size="md"
                variant="ghost"
                disabled={busy}
                onClick={() => setCancelling(false)}
              >
                Garder mon abonnement
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label="Factures" className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold text-ink">Factures</h2>
        {invoices === null ? (
          <div role="status" aria-label="Chargement des factures…">
            <div className="h-24 animate-pulse rounded-3xl bg-sand/70" />
          </div>
        ) : invoices === "error" ? (
          <p className="text-[14px] text-ink-soft">
            Les factures n’ont pas pu être chargées.{" "}
            <button type="button" className={linkAction} onClick={reload}>
              Réessayer
            </button>
          </p>
        ) : invoices.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucune facture pour le moment.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {invoices.map((invoice) => (
              <li
                key={invoice.invoiceId}
                className="flex items-center justify-between gap-3 rounded-2xl bg-paper-raised px-4 py-3 text-[14px]"
              >
                <span className="flex flex-col">
                  <span className="text-ink first-letter:uppercase">
                    {month(invoice.periodStart)}
                  </span>
                  <span className="text-[12.5px] text-ink-muted">
                    {invoice.status === "preparing"
                      ? "En préparation"
                      : invoice.status === "issued"
                        ? invoice.simulated
                          ? "Émise · document simulé"
                          : "Émise"
                        : "Indisponible pour le moment"}
                  </span>
                </span>
                <span className="tabular-nums text-ink">
                  {invoice.status === "issued" && invoice.amountMinor !== null
                    ? money(invoice.amountMinor, invoice.currency)
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
