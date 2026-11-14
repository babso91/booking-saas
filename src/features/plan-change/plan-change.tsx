"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  billingErrors,
  cadenceNames,
  planNames,
  type BillingQuoteDto,
  type Cadence,
  type PlanChangeActions,
  type PlanChangeDto,
  type PlanId,
} from "./contract";

// Changing her plan: the server's quote says what is due now, at the next
// charge and every period after, and when the change takes effect. Her
// current rights stay as they are until the payment is verified; a change
// at the end of the period can be cancelled. While no payment provider is
// connected, every step says it is simulated: nothing is charged.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency })
    .format(minor / 100)
    .replace(/[,.]00(?=\s)/, "");

const day = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

const clock = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(new Date(iso));

type Current = {
  plan: PlanId;
  cadence: Cadence;
  revision: number;
  pending: PlanChangeDto | null;
};

function PendingCard({
  pending,
  current,
  onCancel,
  busy,
}: {
  pending: PlanChangeDto;
  current: Current;
  onCancel: () => void;
  busy: boolean;
}) {
  const target = `${planNames[pending.target.plan]} ${cadenceNames[pending.target.cadence]}`;
  return (
    <section
      aria-label="Changement en cours"
      className="flex flex-col gap-2 rounded-3xl border border-ink px-5 py-4"
    >
      <p className="text-[15px] font-semibold text-ink">
        {pending.status === "scheduled"
          ? `Passage à ${target} prévu le ${day(pending.effectiveAt!)}`
          : pending.status === "requires_action"
            ? `Passage à ${target} : une validation de paiement est demandée`
            : pending.status === "failed"
              ? `Le passage à ${target} n’a pas abouti`
              : `Passage à ${target} demandé`}
      </p>
      <p className="text-[14px] text-ink-soft">
        {pending.status === "requested" || pending.status === "requires_action"
          ? `Tant que le paiement n’est pas vérifié, tu restes en ${planNames[current.plan]} avec ses fonctions actuelles.`
          : pending.status === "scheduled"
            ? `Jusque-là, tu gardes ${planNames[current.plan]}. Rien n’est débité maintenant.`
            : "Tu restes sur ta formule actuelle. Tu peux refaire une demande."}
      </p>
      {pending.status === "scheduled" ? (
        <button
          type="button"
          className={linkAction + " w-fit"}
          disabled={busy}
          onClick={onCancel}
        >
          Annuler ce changement
        </button>
      ) : null}
    </section>
  );
}

export function PlanChange({ actions }: { actions: PlanChangeActions }) {
  const [current, setCurrent] = useState<Current | "error" | null>(null);
  const [run, setRun] = useState(0);
  const [target, setTarget] = useState<{
    plan: PlanId;
    cadence: Cadence;
  } | null>(null);
  const [quote, setQuote] = useState<BillingQuoteDto | null>(null);
  const [busy, setBusy] = useState<"quote" | "confirm" | "cancel" | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "info";
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
    void actions.current().then((result) => {
      if (live) setCurrent(result.ok ? result.data : "error");
    });
    return () => {
      live = false;
    };
  }, [actions, run]);

  const reload = () => setRun((n) => n + 1);

  if (current === null)
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (current === "error")
    return (
      <Notice
        tone="error"
        title="Ta formule n’a pas pu être chargée"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      />
    );

  const options: { plan: PlanId; cadence: Cadence }[] = (
    ["core", "signature"] as const
  )
    .flatMap((plan) =>
      (["monthly", "yearly"] as const).map((cadence) => ({ plan, cadence })),
    )
    .filter((o) => !(o.plan === current.plan && o.cadence === current.cadence));

  async function ask(next: { plan: PlanId; cadence: Cadence }, base: Current) {
    setTarget(next);
    setQuote(null);
    setBusy("quote");
    setNotice(null);
    const result = await actions.quote({
      targetPlan: next.plan,
      targetCadence: next.cadence,
      expectedSubscriptionRevision: base.revision,
    });
    setBusy(null);
    if (result.ok) return setQuote(result.data);
    failed(result.error.code);
  }

  function failed(code: string) {
    if (code === billingErrors.stateChanged) {
      setQuote(null);
      setTarget(null);
      reload();
      return setNotice({
        tone: "info",
        text: "Ton abonnement a changé entre-temps (dans un autre onglet ?) : voici son état à jour. Rien n’a été demandé.",
      });
    }
    if (code === billingErrors.quoteExpired) {
      setQuote(null);
      return setNotice({
        tone: "info",
        text: "Ce devis a expiré. Redemande-le pour voir les montants à jour.",
      });
    }
    setNotice({
      tone: "error",
      text:
        code === billingErrors.unavailable
          ? "Le paiement est indisponible pour le moment. Rien n’a été demandé."
          : code === billingErrors.permissionDenied
            ? "Seule la propriétaire peut changer de formule."
            : code === "network"
              ? "Pas de réponse. Réessaie : une même demande n’est jamais faite deux fois."
              : "Ça n’a pas abouti. Rien n’a été demandé.",
    });
  }

  async function confirm(q: BillingQuoteDto, base: Current) {
    setBusy("confirm");
    setNotice(null);
    const result = await actions.confirm({
      quoteId: q.quoteId,
      expectedRevision: base.revision,
      operationId: opFor(q.quoteId),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    setQuote(null);
    setTarget(null);
    reload();
  }

  async function cancel(pending: PlanChangeDto) {
    setBusy("cancel");
    const result = await actions.cancelScheduled({
      commandId: pending.commandId,
      operationId: opFor(`cancel:${pending.commandId}`),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    reload();
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] leading-tight text-ink">
          Changer de formule
        </h1>
        <p className="text-[15px] text-ink-soft">
          Tu es en{" "}
          <strong className="font-semibold text-ink">
            {planNames[current.plan]}
          </strong>
          , {cadenceNames[current.cadence]}.
        </p>
      </header>

      <p className="rounded-2xl border border-dashed border-line-strong bg-sand/50 px-4 py-3 text-[13.5px] text-ink-soft">
        <strong className="font-semibold text-ink">Simulé.</strong> Aucun moyen
        de paiement n’est relié : rien ne peut être débité, et aucune formule
        n’est activée sans paiement vérifié.
      </p>

      {notice ? (
        <Notice
          tone={notice.tone}
          title={notice.tone === "error" ? "À revoir" : "À savoir"}
        >
          {notice.text}
        </Notice>
      ) : null}

      {current.pending ? (
        <PendingCard
          pending={current.pending}
          current={current}
          busy={busy !== null}
          onCancel={() => void cancel(current.pending!)}
        />
      ) : (
        <>
          <section aria-label="Formules" className="flex flex-col gap-2">
            {options.map((option) => {
              const selected =
                target?.plan === option.plan &&
                target.cadence === option.cadence;
              return (
                <button
                  key={`${option.plan}-${option.cadence}`}
                  type="button"
                  aria-pressed={selected}
                  disabled={busy !== null}
                  onClick={() => void ask(option, current)}
                  className={cn(
                    "flex cursor-pointer justify-between gap-3 rounded-3xl border bg-paper-raised px-5 py-4 text-left text-[15px] text-ink transition-colors disabled:cursor-not-allowed",
                    selected
                      ? "border-ink"
                      : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="font-semibold">
                    {planNames[option.plan]}
                  </span>
                  <span className="text-ink-soft">
                    {cadenceNames[option.cadence]}
                  </span>
                </button>
              );
            })}
          </section>

          {busy === "quote" ? (
            <div role="status" aria-label="Calcul du devis…">
              <div className="h-40 animate-pulse rounded-3xl bg-sand/70" />
            </div>
          ) : quote ? (
            <section
              aria-label="Devis"
              className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-4"
            >
              <dl className="flex flex-col gap-2 text-[15px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">À payer maintenant</dt>
                  <dd className="font-semibold tabular-nums text-ink">
                    {money(quote.dueNowMinor, quote.currency)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">
                    Prochain débit, le {day(quote.nextCharge.at)}
                  </dt>
                  <dd className="tabular-nums text-ink">
                    {money(quote.nextCharge.amountMinor, quote.currency)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">Ensuite</dt>
                  <dd className="tabular-nums text-ink">
                    {money(quote.recurring.amountMinor, quote.currency)}{" "}
                    {cadenceNames[quote.recurring.cadence]}
                  </dd>
                </div>
              </dl>
              <p className="text-[13.5px] text-ink-soft">
                {quote.effective.mode === "after_verified_payment"
                  ? `${planNames[quote.target.plan]} s’active une fois le paiement vérifié, pas avant.`
                  : `Le changement prendra effet le ${day(quote.effective.at)} ; d’ici là tu gardes ta formule actuelle.`}
              </p>
              <p className="text-[12.5px] text-ink-muted">
                Devis valable jusqu’à {clock(quote.expiresAt)}.
              </p>
              <Button
                size="md"
                state={busy === "confirm" ? "loading" : "idle"}
                loadingLabel="Envoi…"
                onClick={() => void confirm(quote, current)}
              >
                {quote.dueNowMinor > 0
                  ? `Passer à ${planNames[quote.target.plan]} · ${money(quote.dueNowMinor, quote.currency)} maintenant`
                  : `Programmer le passage à ${planNames[quote.target.plan]}`}
              </Button>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
