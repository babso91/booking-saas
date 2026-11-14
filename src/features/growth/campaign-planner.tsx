"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/cn";

import {
  growthErrors,
  reasonLabels,
  smsUnits,
  type AudienceCriteria,
  type AudienceEstimate,
  type CampaignActions,
  type CampaignDto,
  type Channel,
  type SuppressionReason,
} from "./contract";

// A rebooking or reactivation campaign: closed criteria, an estimate that
// says who is left out and why (in numbers, never names), a ceiling she
// sets, a confirmation, then a follow-up where a pause tells apart what
// is still waiting from what has already left. While the transport is
// simulated, every screen says so: nothing really leaves.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));

const plural = (n: number, one: string, many: string) =>
  `${n} ${n > 1 ? many : one}`;

function Simulated() {
  return (
    <p className="rounded-2xl border border-dashed border-line-strong bg-sand/50 px-4 py-3 text-[13.5px] leading-relaxed text-ink-soft">
      <strong className="font-semibold text-ink">Simulé.</strong> Aucun message
      ne part réellement tant que les envois ne sont pas activés (consentements,
      désinscription, expéditeur et budget validés).
    </p>
  );
}

function Reasons({
  reasons,
}: {
  reasons: Partial<Record<SuppressionReason, number>>;
}) {
  const entries = (Object.entries(reasons) as [SuppressionReason, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-[13.5px] text-ink-soft">
      {entries.map(([reason, n]) => (
        <li key={reason} className="flex justify-between gap-3">
          <span>{reasonLabels[reason]}</span>
          <span className="tabular-nums font-medium text-ink">{n}</span>
        </li>
      ))}
    </ul>
  );
}

export function CampaignPlanner({
  services,
  actions,
  onScheduled,
}: {
  services: { id: string; name: string }[];
  actions: CampaignActions;
  onScheduled: (campaign: CampaignDto) => void;
}) {
  const [kind, setKind] = useState<AudienceCriteria["kind"]>("rebooking");
  const [serviceIds, setServiceIds] = useState<string[]>(
    services.slice(0, 1).map((s) => s.id),
  );
  const [days, setDays] = useState(60);
  const [channel, setChannel] = useState<Channel>("sms");
  const [message, setMessage] = useState(
    "Bonjour, cela fait un moment ! Un créneau vous attend : réservez en un clic.",
  );
  const [estimate, setEstimate] = useState<AudienceEstimate | null>(null);
  const [ceiling, setCeiling] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"estimate" | "schedule" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});
  const requestIds = useRef(new Map<string, string>());

  const units = channel === "sms" ? smsUnits(message) : 1;

  function edited() {
    setEstimate(null);
    setConfirming(false);
    setNotice(null);
  }

  const criteria = (): AudienceCriteria =>
    kind === "rebooking"
      ? { kind, serviceIds, afterDays: days }
      : { kind, inactiveDays: days };

  async function runEstimate(message_: string | null = null) {
    const problems: Record<string, string> = {};
    if (kind === "rebooking" && !serviceIds.length)
      problems.services = "Choisis au moins une prestation.";
    if (!message.trim()) problems.message = "Écris le message.";
    setError(problems);
    if (Object.keys(problems).length) return;
    setBusy("estimate");
    const result = await actions.estimate({
      criteria: criteria(),
      channel,
      message,
    });
    setBusy(null);
    if (!result.ok)
      return setNotice(
        "L’estimation n’a pas abouti. Réessaie dans un instant.",
      );
    setEstimate(result.data);
    setCeiling(String(result.data.estimatedUnits));
    setNotice(message_);
  }

  async function schedule() {
    if (!estimate || busy) return;
    const maxUnits = Number(ceiling);
    if (!Number.isInteger(maxUnits) || maxUnits < 1)
      return setError({ ceiling: "Un nombre entier, au moins 1." });
    setError({});
    const key = `${estimate.estimateId}:${maxUnits}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy("schedule");
    setNotice(null);
    const result = await actions.schedule({
      estimateId: estimate.estimateId,
      maxUnits,
      requestId: requestIds.current.get(key)!,
    });
    setBusy(null);
    if (result.ok) return onScheduled(result.data);
    setConfirming(false);
    const code = result.error.code;
    if (code === growthErrors.estimateStale)
      return runEstimate(
        "L’audience a changé depuis l’estimation : rien n’a été planifié. Voici les chiffres à jour.",
      );
    setNotice(
      code === growthErrors.quotaExceeded
        ? "Ce plafond dépasse ton budget d’envois restant : baisse-le."
        : code === "network"
          ? "Pas de réponse. Réessaie : la même campagne n’est jamais planifiée deux fois."
          : "La campagne n’a pas pu être planifiée. Rien n’a été enregistré.",
    );
  }

  const ceilingNumber = Number(ceiling);
  const unitName = channel === "sms" ? "SMS" : "e-mail";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] leading-tight text-ink">
          Nouvelle relance
        </h1>
        <p className="max-w-prose text-[15px] text-ink-soft">
          Qui recontacter, et combien au plus. Les clientes qui ont déjà un
          rendez-vous, n’ont pas accepté ce type de message ou ont été
          contactées récemment sont toujours écartées.
        </p>
      </header>

      <Simulated />

      <section
        aria-label="Audience"
        className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[15px] font-medium text-ink">Qui</legend>
          {(
            [
              ["rebooking", "Relancer après une prestation"],
              ["reactivation", "Recontacter les clientes inactives"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink"
            >
              <input
                type="radio"
                name="kind"
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                  edited();
                }}
                className="size-4 accent-[var(--ink)]"
              />
              {label}
            </label>
          ))}
        </fieldset>

        {kind === "rebooking" ? (
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={error.services ? "services-error" : undefined}
          >
            <legend className="mb-1 text-[14px] font-medium text-ink">
              Dernière prestation
            </legend>
            {services.map((service) => (
              <label
                key={service.id}
                className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink"
              >
                <input
                  type="checkbox"
                  checked={serviceIds.includes(service.id)}
                  onChange={(event) => {
                    setServiceIds((current) =>
                      event.target.checked
                        ? [...current, service.id]
                        : current.filter((id) => id !== service.id),
                    );
                    edited();
                  }}
                  className="size-4 accent-[var(--ink)]"
                />
                {service.name}
              </label>
            ))}
            {error.services ? (
              <p
                id="services-error"
                className="text-[13.5px] font-medium text-danger"
              >
                {error.services}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <SelectField
          label={
            kind === "rebooking"
              ? "Faite il y a au moins"
              : "Sans visite depuis au moins"
          }
          value={String(days)}
          onChange={(event) => {
            setDays(Number(event.target.value));
            edited();
          }}
        >
          {[21, 30, 45, 60, 90, 120, 180].map((value) => (
            <option key={value} value={value}>
              {value} jours
            </option>
          ))}
        </SelectField>

        <div
          role="group"
          aria-label="Canal"
          className="flex w-fit rounded-full bg-sand p-1"
        >
          {(
            [
              ["sms", "SMS"],
              ["email", "E-mail"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={channel === value}
              onClick={() => {
                setChannel(value);
                edited();
              }}
              className={cn(
                "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium",
                channel === value
                  ? "bg-paper-raised text-ink shadow-sm"
                  : "text-ink-soft",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <TextAreaField
          label="Message"
          name="campaign-message"
          rows={3}
          maxLength={channel === "sms" ? 459 : 1000}
          value={message}
          error={error.message}
          hint={
            channel === "sms"
              ? `${message.length} caractères · ${plural(units, "SMS", "SMS")} par cliente. Le lien de réservation et la désinscription sont ajoutés.`
              : "Le lien de réservation et la désinscription sont ajoutés."
          }
          onChange={(event) => {
            setMessage(event.target.value);
            edited();
          }}
        />

        {!estimate ? (
          <Button
            size="md"
            variant="secondary"
            state={busy === "estimate" ? "loading" : "idle"}
            loadingLabel="Estimation…"
            onClick={() => void runEstimate()}
          >
            Estimer l’audience
          </Button>
        ) : null}
      </section>

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      {estimate ? (
        <section
          aria-label="Estimation"
          className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-display text-[40px] leading-none text-ink tabular-nums">
              {estimate.eligible}
            </p>
            <p className="text-right text-[13px] text-ink-muted">
              Estimation valable jusqu’à{" "}
              {clock(estimate.estimateExpiresAt, estimate.timeZone)}
            </p>
          </div>
          <p className="-mt-2 text-[14.5px] text-ink-soft">
            {estimate.eligible > 1
              ? "clientes recevraient ce message"
              : "cliente recevrait ce message"}
            , sur{" "}
            {plural(estimate.matched, "qui correspond", "qui correspondent")}{" "}
            aux critères.
          </p>
          {estimate.matched > estimate.eligible ? (
            <div className="flex flex-col gap-2">
              <p className="text-[14px] font-medium text-ink">
                Écartées ({estimate.matched - estimate.eligible})
              </p>
              <Reasons reasons={estimate.suppressedByReason} />
            </div>
          ) : null}

          {estimate.eligible === 0 ? (
            <p className="text-[14px] text-ink-soft">
              Personne à contacter avec ces critères : élargis la période ou les
              prestations.
            </p>
          ) : (
            <>
              <TextField
                label={`Plafond d’envois (${unitName})`}
                name="campaign-ceiling"
                type="number"
                inputMode="numeric"
                min={1}
                value={ceiling}
                error={error.ceiling}
                hint={`Estimé : ${estimate.estimatedUnits}. Au-delà du plafond, plus rien ne part.`}
                onChange={(event) => {
                  setCeiling(event.target.value);
                  setConfirming(false);
                }}
              />
              {confirming ? (
                <div className="flex flex-col gap-3 rounded-2xl bg-sand/60 px-4 py-3">
                  <p className="text-[14.5px] text-ink">
                    Planifier la relance ? Au plus{" "}
                    {plural(
                      ceilingNumber,
                      unitName,
                      unitName === "SMS" ? "SMS" : "e-mails",
                    )}
                    , pour {plural(estimate.eligible, "cliente", "clientes")}.
                    Chaque cliente est revérifiée juste avant l’envoi.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="md"
                      state={busy === "schedule" ? "loading" : "idle"}
                      loadingLabel="Planification…"
                      onClick={() => void schedule()}
                    >
                      Planifier
                    </Button>
                    <Button
                      size="md"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setConfirming(false)}
                    >
                      Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="md" onClick={() => setConfirming(true)}>
                  Planifier…
                </Button>
              )}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** Where a scheduled campaign stands; a pause keeps what is still waiting. */
export function CampaignStatus({
  campaignId,
  actions,
  refreshKey = 0,
}: {
  campaignId: string;
  actions: CampaignActions;
  /** Bumped by the caller to read again. */
  refreshKey?: number;
}) {
  const [campaign, setCampaign] = useState<CampaignDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [run, setRun] = useState(0);
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    let current = true;
    void actions.read(campaignId).then((result) => {
      if (!current) return;
      if (result.ok) {
        setCampaign(result.data);
        setFailed(false);
      } else setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [actions, campaignId, refreshKey, run]);

  if (failed)
    return (
      <Notice
        tone="error"
        title="Le suivi n’a pas pu être chargé"
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
  if (!campaign)
    return (
      <div role="status" aria-label="Chargement du suivi…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );

  const { counts } = campaign;
  const unitName = campaign.channel === "sms" ? "SMS" : "e-mails";

  async function act(action: "pause" | "resume" | "cancel") {
    if (busy || !campaign) return;
    const key = `${action}:${campaign.version}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy(true);
    setNotice(null);
    const result = await actions.setState({
      campaignId: campaign.campaignId,
      expectedVersion: campaign.version,
      requestId: requestIds.current.get(key)!,
      action,
    });
    setBusy(false);
    setConfirmCancel(false);
    if (result.ok) return setCampaign(result.data);
    if (result.error.code === growthErrors.versionConflict) {
      setNotice(
        "La campagne a avancé entre-temps : voici où elle en est. Refais ton choix si besoin.",
      );
      return setRun((n) => n + 1);
    }
    setNotice(
      result.error.code === "network"
        ? "Pas de réponse. Réessaie."
        : "Ça n’a pas abouti. Réessaie dans un instant.",
    );
  }

  const stateLabel = {
    scheduled: "Planifiée",
    running: "En cours",
    paused: "En pause",
    completed: "Terminée",
    cancelled: "Annulée",
  }[campaign.state];
  const live = campaign.state === "scheduled" || campaign.state === "running";

  return (
    <section aria-label="Suivi de la relance" className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="font-display text-[26px] leading-tight text-ink">
          Suivi
        </h2>
        <span
          className={cn(
            "rounded-full px-3 py-1 text-[13px] font-medium",
            live ? "bg-ink text-paper-raised" : "bg-sand text-ink-soft",
          )}
        >
          {stateLabel}
        </span>
      </header>

      {campaign.simulated ? <Simulated /> : null}

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-3">
        {(
          [
            ["En attente", counts.pending],
            ["Remis à l’envoi", counts.handedOff],
            ["Acceptés", counts.accepted],
            ["Écartés au dernier moment", counts.suppressed],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-2xl border border-line bg-paper-raised px-4 py-3"
          >
            <dt className="text-[12.5px] text-ink-muted">{label}</dt>
            <dd className="font-display text-[28px] leading-none text-ink tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-[13.5px] text-ink-soft">
        {campaign.unitsUsed} sur {campaign.maxUnits} {unitName} du plafond. «
        Accepté » veut dire pris en charge par le prestataire, pas reçu.
      </p>
      {counts.uncertain ? (
        <p className="text-[13.5px] text-ink-soft">
          {plural(counts.uncertain, "envoi incertain", "envois incertains")}{" "}
          (réponse perdue) : aucun nouvel essai avant vérification, pour ne
          jamais envoyer deux fois.
        </p>
      ) : null}
      {counts.suppressed ? (
        <Reasons reasons={campaign.suppressedByReason} />
      ) : null}

      <div className="rounded-2xl bg-sand/60 px-4 py-3">
        <p className="text-[15px] font-medium text-ink">
          {plural(
            campaign.attributedBookings,
            "réservation attribuée",
            "réservations attribuées",
          )}
        </p>
        <p className="text-[13px] text-ink-muted">
          Réservations faites avec le lien de cette relance dans les{" "}
          {campaign.attributionWindowDays} jours. Cela ne prouve pas que la
          relance les a causées.
        </p>
      </div>

      {live ? (
        <div className="flex flex-col gap-2">
          <Button
            size="md"
            variant="secondary"
            state={busy ? "loading" : "idle"}
            loadingLabel="Mise en pause…"
            onClick={() => void act("pause")}
          >
            Mettre en pause
          </Button>
          <p className="text-[13px] text-ink-muted">
            {plural(
              counts.pending,
              "message en attente ne partira",
              "messages en attente ne partiront",
            )}{" "}
            pas.{" "}
            {counts.handedOff
              ? `${plural(counts.handedOff, "message déjà remis peut", "messages déjà remis peuvent")} encore arriver.`
              : ""}
          </p>
        </div>
      ) : null}
      {campaign.state === "paused" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="md"
            state={busy ? "loading" : "idle"}
            loadingLabel="Reprise…"
            onClick={() => void act("resume")}
          >
            Reprendre
          </Button>
          {confirmCancel ? (
            <Button
              size="md"
              variant="danger"
              disabled={busy}
              onClick={() => void act("cancel")}
            >
              Confirmer l’annulation
            </Button>
          ) : (
            <Button
              size="md"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              Annuler la relance…
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
