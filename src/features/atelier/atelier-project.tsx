"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  atelierErrors,
  type AtelierActions,
  type AtelierOrderStatus,
  type AtelierProposalDto,
  type AtelierView,
} from "./contract";

// Her Atelier order, from her side: where it stands, what the quote
// includes, each proposal with what it changes, a correction (counted once,
// within the quote) or applying it to her draft. Applying never publishes:
// she previews and publishes from the Studio. If her draft moved on since
// the proposal, nothing is overwritten: she chooses.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const statusLabels: Record<AtelierOrderStatus, string> = {
  quoted: "Devis envoyé",
  accepted: "Devis accepté",
  awaiting_assets: "En attente de tes photos et textes",
  in_production: "En création",
  in_review: "À relire",
  revision_requested: "Correction demandée",
  delivered: "Livré",
  cancelled: "Annulé",
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency })
    .format(cents / 100)
    .replace(/[,.]00(?=\s)/, "");

const day = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

export function AtelierProject({
  orderId,
  actions,
  studioHref = "/app/site",
}: {
  orderId: string;
  actions: AtelierActions;
  studioHref?: string;
}) {
  const [view, setView] = useState<AtelierView | "error" | "expired" | null>(
    null,
  );
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success" | "warning";
    text: string;
  } | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [conflict, setConflict] = useState<{
    proposalId: string;
    current: number;
  } | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const idFor = (key: string) => {
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    return requestIds.current.get(key)!;
  };

  useEffect(() => {
    let current = true;
    void actions.read(orderId).then((result) => {
      if (!current) return;
      setView(
        result.ok
          ? result.data
          : result.error.code === atelierErrors.accessExpired
            ? "expired"
            : "error",
      );
    });
    return () => {
      current = false;
    };
  }, [actions, orderId, run]);

  const reload = () => setRun((n) => n + 1);

  if (view === null)
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-56 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (view === "expired")
    return (
      <Notice tone="info" title="Cet accès a expiré">
        Le projet n’est plus consultable avec cet accès. Ton site et ton
        brouillon ne changent pas.
      </Notice>
    );
  if (view === "error")
    return (
      <Notice
        tone="error"
        title="Le projet n’a pas pu être chargé"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      />
    );

  const { order } = view;
  const left = order.quote.includedCorrections - order.correctionsUsed;

  function failed(code: string, current?: number, proposalId?: string) {
    if (
      code === atelierErrors.staleDraft &&
      proposalId &&
      current !== undefined
    ) {
      setConflict({ proposalId, current });
      return setNotice(null);
    }
    if (code === atelierErrors.accessExpired) return setView("expired");
    setNotice({
      tone: "error",
      text:
        code === atelierErrors.limitReached
          ? "Les corrections incluses dans ton devis sont toutes utilisées. Une nouvelle demande passerait par un nouveau devis."
          : code === atelierErrors.outOfScope
            ? "Cette demande dépasse ce qui est prévu au devis : elle fera l’objet d’un devis à part, rien ne t’est facturé sans ton accord."
            : code === atelierErrors.quoteChanged
              ? "Le devis a changé : relis-le avant de continuer."
              : code === "network"
                ? "Pas de réponse. Réessaie : une même demande ne compte jamais deux fois."
                : "Ça n’a pas abouti. Réessaie dans un instant.",
    });
  }

  async function correct(proposal: AtelierProposalDto) {
    if (!scope.trim())
      return setNotice({ tone: "error", text: "Dis ce qu’il faut corriger." });
    setBusy(proposal.proposalId);
    setNotice(null);
    const result = await actions.requestCorrection({
      proposalId: proposal.proposalId,
      scope: scope.trim(),
      requestId: idFor(`correct:${proposal.proposalId}:${scope.trim()}`),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    setView(result.data);
    setCorrecting(null);
    setScope("");
    setNotice({
      tone: "success",
      text: "Correction demandée. L’atelier te renverra une proposition.",
    });
  }

  async function apply(proposal: AtelierProposalDto, current: AtelierView) {
    setBusy(proposal.proposalId);
    setNotice(null);
    const result = await actions.apply({
      proposalId: proposal.proposalId,
      expectedDraftRevision: current.currentDraftRevision,
      requestId: idFor(
        `apply:${proposal.proposalId}:${current.currentDraftRevision}`,
      ),
    });
    setBusy(null);
    if (!result.ok)
      return failed(
        result.error.code,
        result.error.currentRevision,
        proposal.proposalId,
      );
    reload();
    setNotice({
      tone: "success",
      text: "Proposition appliquée à ton brouillon. Rien n’est publié : vérifie l’aperçu dans le Studio, puis publie quand tu veux.",
    });
  }

  async function rebase(proposalId: string) {
    setBusy(proposalId);
    const result = await actions.requestRebase({
      proposalId,
      requestId: idFor(`rebase:${proposalId}`),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    setConflict(null);
    setView(result.data);
    setNotice({
      tone: "success",
      text: "Demande envoyée : l’atelier reprend la proposition sur ton brouillon actuel. Cela ne compte pas comme une correction.",
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <p className="text-[13px] font-medium tracking-[0.08em] text-ink-muted uppercase">
          Atelier · {order.orderId}
        </p>
        <h1 className="font-display text-[32px] leading-tight text-ink">
          {order.title}
        </h1>
        <span className="w-fit rounded-full bg-ink px-3 py-1 text-[13px] font-medium text-paper-raised">
          {statusLabels[order.status]}
        </span>
      </header>

      <section
        aria-label="Devis"
        className="flex flex-col gap-1.5 rounded-3xl border border-line bg-paper-raised px-5 py-4"
      >
        <p className="flex justify-between gap-3 text-[15px]">
          <span className="text-ink-soft">Devis v{order.quote.version}</span>
          <span className="font-semibold tabular-nums text-ink">
            {money(order.quote.amountCents, order.quote.currency)}
          </span>
        </p>
        <p className="text-[14px] text-ink-soft">
          {order.quote.includedCorrections} corrections incluses ·{" "}
          {left > 0
            ? `${left} restante${left > 1 ? "s" : ""}`
            : "toutes utilisées"}
        </p>
        <p className="text-[12.5px] text-ink-muted">
          Ponctuel, à part de ton abonnement. Aucun paiement depuis cette page.
          Tes modifications faites toi-même dans le Studio ne comptent jamais
          comme des corrections.
        </p>
      </section>

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

      <section aria-label="Propositions" className="flex flex-col gap-3">
        <h2 className="text-[17px] font-semibold text-ink">Propositions</h2>
        {view.proposals.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            L’atelier n’a pas encore envoyé de proposition.
          </p>
        ) : null}
        {view.proposals.map((proposal) => {
          const open = proposal.state === "submitted";
          const conflicted = conflict?.proposalId === proposal.proposalId;
          return (
            <article
              key={proposal.proposalId}
              className={cn(
                "flex flex-col gap-3 rounded-3xl border bg-paper-raised px-5 py-4",
                conflicted ? "border-danger" : "border-line",
              )}
            >
              <p className="text-[13px] text-ink-muted">
                {proposal.authorLabel} · le {day(proposal.submittedAt)} · faite
                sur ton brouillon n° {proposal.baseDraftRevision}
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[14.5px] text-ink">
                {proposal.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              {proposal.state === "applied" ? (
                <p className="text-[14px] text-ink-soft">
                  Appliquée à ton brouillon.{" "}
                  <a href={studioHref} className={linkAction}>
                    Ouvrir le Studio
                  </a>
                </p>
              ) : proposal.state === "changes_requested" ? (
                <p className="text-[14px] text-ink-soft">
                  En cours de reprise par l’atelier.
                </p>
              ) : null}

              {conflicted ? (
                <div
                  className="flex flex-col gap-3 rounded-2xl bg-sand/60 px-4 py-3"
                  role="alert"
                >
                  <p className="text-[14px] text-ink">
                    Ton brouillon a changé depuis cette proposition (il est au
                    n° {conflict.current}, elle a été faite sur le n°{" "}
                    {proposal.baseDraftRevision}). Rien n’a été remplacé : tes
                    modifications sont intactes. Compare dans le Studio, puis
                    choisis.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      size="md"
                      variant="secondary"
                      state={busy === proposal.proposalId ? "loading" : "idle"}
                      loadingLabel="Envoi…"
                      onClick={() => void rebase(proposal.proposalId)}
                    >
                      Demander une reprise sur mon brouillon
                    </Button>
                    <Button
                      size="md"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setConflict(null)}
                    >
                      Garder mon brouillon tel quel
                    </Button>
                  </div>
                </div>
              ) : open ? (
                correcting === proposal.proposalId ? (
                  <div className="flex flex-col gap-2">
                    <TextAreaField
                      label="Ce qu’il faut corriger"
                      name="correction"
                      rows={3}
                      value={scope}
                      hint={
                        left > 0
                          ? `Compte pour 1 des ${left} corrections restantes.`
                          : undefined
                      }
                      onChange={(event) => setScope(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="md"
                        state={
                          busy === proposal.proposalId ? "loading" : "idle"
                        }
                        loadingLabel="Envoi…"
                        onClick={() => void correct(proposal)}
                      >
                        Demander la correction
                      </Button>
                      <Button
                        size="md"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setCorrecting(null)}
                      >
                        Annuler
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="md"
                      state={busy === proposal.proposalId ? "loading" : "idle"}
                      loadingLabel="Application…"
                      onClick={() => void apply(proposal, view)}
                    >
                      Appliquer à mon brouillon
                    </Button>
                    <Button
                      size="md"
                      variant="secondary"
                      disabled={busy !== null || left <= 0}
                      onClick={() => setCorrecting(proposal.proposalId)}
                    >
                      Demander une correction
                    </Button>
                  </div>
                )
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}
