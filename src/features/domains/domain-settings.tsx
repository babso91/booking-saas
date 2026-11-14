"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  domainErrors,
  normalizeHostname,
  type SiteDomainActions,
  type SiteDomainDto,
} from "./contract";

// Her own address for her site. The steps are said as they are: records to
// add at her registrar, a check, a certificate, then active. Nothing is
// promised before the proof (no "in a few minutes"); her usual address is
// shown at every step and keeps serving.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const steps = [
  ["awaiting_dns", "DNS"],
  ["verified", "Vérification"],
  ["provisioning_tls", "Certificat"],
  ["active", "Actif"],
] as const;

const rank = (domain: SiteDomainDto) =>
  domain.state === "active"
    ? 3
    : domain.state === "provisioning_tls"
      ? 2
      : domain.state === "verified"
        ? 1
        : domain.reason === "tls_failed"
          ? 2
          : 0;

const reasonText: Record<NonNullable<SiteDomainDto["reason"]>, string> = {
  proof_missing:
    "L’enregistrement TXT n’est pas encore visible. Les changements DNS peuvent prendre du temps chez ton hébergeur : vérifie de nouveau plus tard.",
  proof_mismatch:
    "Un enregistrement TXT existe, mais sa valeur ne correspond pas. Copie exactement la valeur ci-dessous.",
  target_mismatch:
    "Le CNAME ne pointe pas vers la bonne adresse. Corrige-le chez ton hébergeur.",
  tls_failed:
    "Le certificat n’a pas pu être émis. Vérifie que le CNAME est toujours en place, puis réessaie.",
  dns_lost:
    "Les enregistrements DNS ont disparu : ton domaine est suspendu. Ton adresse habituelle continue de fonctionner.",
};

const clock = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

export function DomainSettings({ actions }: { actions: SiteDomainActions }) {
  const [domain, setDomain] = useState<
    SiteDomainDto | null | "loading" | "error"
  >("loading");
  const [run, setRun] = useState(0);
  const [hostname, setHostname] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"request" | "retry" | "detach" | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "info";
    text: string;
  } | null>(null);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  // Each answered check moves on; a lost answer reuses the same id.
  const checks = useRef(0);
  const idFor = (key: string) => {
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    return requestIds.current.get(key)!;
  };

  useEffect(() => {
    let current = true;
    void actions.read().then((result) => {
      if (current) setDomain(result.ok ? result.data : "error");
    });
    return () => {
      current = false;
    };
  }, [actions, run]);

  const reload = () => setRun((n) => n + 1);

  if (domain === "loading")
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (domain === "error")
    return (
      <Notice
        tone="error"
        title="Ton domaine n’a pas pu être chargé"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      >
        Ton adresse habituelle continue de fonctionner.
      </Notice>
    );

  function failed(code: string) {
    if (code === domainErrors.generationChanged) {
      reload();
      return setNotice({
        tone: "info",
        text: "Une nouvelle vérification a été lancée ailleurs : voici les enregistrements à jour.",
      });
    }
    if (code === domainErrors.proofExpired) {
      reload();
      return setNotice({
        tone: "info",
        text: "La preuve avait expiré : une nouvelle valeur TXT a été générée. Remplace l’ancienne chez ton hébergeur.",
      });
    }
    setNotice({
      tone: "error",
      text:
        code === domainErrors.taken
          ? "Ce domaine est déjà relié à un autre site. S’il est à toi, contacte le support."
          : code === "network"
            ? "Pas de réponse. Réessaie."
            : "Ça n’a pas abouti. Réessaie dans un instant.",
    });
  }

  async function request() {
    const host = normalizeHostname(hostname);
    if (!host)
      return setInputError(
        "Un nom de domaine comme reservation.ton-salon.fr, sans https:// ni chemin.",
      );
    setInputError(null);
    setBusy("request");
    setNotice(null);
    const result = await actions.request({
      hostname: host,
      requestId: idFor(`request:${host}`),
    });
    setBusy(null);
    if (result.ok) return setDomain(result.data);
    failed(result.error.code);
  }

  async function retry(current: SiteDomainDto) {
    setBusy("retry");
    setNotice(null);
    const result = await actions.retry({
      id: current.id,
      expectedGeneration: current.generation,
      requestId: idFor(`retry:${current.generation}:${checks.current}`),
    });
    setBusy(null);
    if (result.ok || result.error.code !== "network") checks.current += 1;
    if (result.ok) return setDomain(result.data);
    failed(result.error.code);
  }

  async function detach(current: SiteDomainDto) {
    setBusy("detach");
    setNotice(null);
    const result = await actions.detach({
      id: current.id,
      expectedGeneration: current.generation,
      requestId: idFor(`detach:${current.generation}`),
    });
    setBusy(null);
    setConfirmDetach(false);
    if (result.ok) {
      setDomain(null);
      return setNotice({
        tone: "info",
        text: `${current.hostname} n’est plus relié à ton site.`,
      });
    }
    failed(result.error.code);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setCopied(null);
    }
  }

  const header = (
    <header className="flex flex-col gap-1.5">
      <h1 className="font-display text-[32px] leading-tight text-ink">
        Mon domaine
      </h1>
      <p className="max-w-prose text-[15px] text-ink-soft">
        Une adresse à toi pour ton site, par exemple reservation.ton-salon.fr.
        Il te faut un nom de domaine déjà acheté chez un hébergeur.
      </p>
    </header>
  );

  const banner = notice ? (
    <Notice
      tone={notice.tone}
      title={notice.tone === "error" ? "À revoir" : "À savoir"}
    >
      {notice.text}
    </Notice>
  ) : null;

  if (domain === null)
    return (
      <div className="flex flex-col gap-5">
        {header}
        {banner}
        <section className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5">
          <TextField
            label="Ton domaine"
            name="hostname"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            placeholder="reservation.ton-salon.fr"
            value={hostname}
            error={inputError ?? undefined}
            onChange={(event) => {
              setHostname(event.target.value);
              setInputError(null);
            }}
          />
          <Button
            size="md"
            state={busy === "request" ? "loading" : "idle"}
            loadingLabel="Préparation…"
            onClick={() => void request()}
          >
            Relier ce domaine
          </Button>
        </section>
      </div>
    );

  const current = domain;
  const at = rank(current);
  const live = current.state === "active";

  return (
    <div className="flex flex-col gap-5">
      {header}
      {banner}

      <section
        aria-label="État du domaine"
        className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
      >
        <p className="text-[19px] font-semibold wrap-anywhere text-ink">
          {current.hostname}
        </p>
        <ol className="grid grid-cols-4 gap-1.5" aria-label="Étapes">
          {steps.map(([key, label], index) => {
            const done = index < at || (live && index === 3);
            const here = index === at && !live;
            return (
              <li
                key={key}
                aria-current={here ? "step" : undefined}
                className="flex flex-col gap-1.5"
              >
                <span
                  className={cn(
                    "h-1.5 rounded-full",
                    done
                      ? "bg-ink"
                      : here
                        ? current.state === "error" ||
                          current.state === "suspended"
                          ? "bg-danger"
                          : "bg-ink/40"
                        : "bg-sand",
                  )}
                />
                <span
                  className={cn(
                    "text-[12px] leading-tight",
                    done || here ? "text-ink" : "text-ink-muted",
                  )}
                >
                  {label}
                  <span className="sr-only">
                    {done ? " (fait)" : here ? " (en cours)" : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>

        {live ? (
          <Notice tone="success" title="Ton domaine est actif">
            Ton site répond sur https://{current.hostname}.
          </Notice>
        ) : current.state === "provisioning_tls" ? (
          <p className="text-[14.5px] text-ink-soft">
            Domaine vérifié. Le certificat de sécurité est en cours d’émission ;
            ton domaine ne sera actif qu’une fois ce certificat confirmé.
          </p>
        ) : current.reason ? (
          <p
            className={cn(
              "text-[14.5px]",
              current.state === "error" || current.state === "suspended"
                ? "text-danger"
                : "text-ink-soft",
            )}
          >
            {reasonText[current.reason]}
          </p>
        ) : (
          <p className="text-[14.5px] text-ink-soft">
            Ajoute ces deux enregistrements chez ton hébergeur de domaine, puis
            lance la vérification.
          </p>
        )}

        {!live && current.state !== "provisioning_tls" ? (
          <dl className="flex flex-col gap-3">
            {current.records.map((record) => (
              <div
                key={record.type}
                className="flex flex-col gap-1.5 rounded-2xl bg-sand/50 px-4 py-3"
              >
                <dt className="text-[13px] font-semibold text-ink">
                  Enregistrement {record.type}
                </dt>
                <dd className="flex flex-col gap-1 text-[13.5px]">
                  <span className="text-ink-muted">
                    Nom :{" "}
                    <code className="wrap-anywhere text-ink">
                      {record.name}
                    </code>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-ink-muted">
                    Valeur :{" "}
                    <code className="wrap-anywhere text-ink">
                      {record.value}
                    </code>
                    <button
                      type="button"
                      className="cursor-pointer text-[13px] font-semibold text-ink underline underline-offset-4"
                      onClick={() => void copy(record.value)}
                      aria-label={`Copier la valeur ${record.type}`}
                    >
                      {copied === record.value ? "Copié" : "Copier"}
                    </button>
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {current.proofExpiresAt && !live ? (
          <p className="text-[13px] text-ink-muted">
            Valeur TXT valable jusqu’au {clock(current.proofExpiresAt)}.
          </p>
        ) : null}
        {current.checkedAt ? (
          <p className="text-[13px] text-ink-muted">
            Dernière vérification : {clock(current.checkedAt)}.
          </p>
        ) : null}

        {!live ? (
          <Button
            size="md"
            variant="secondary"
            state={busy === "retry" ? "loading" : "idle"}
            loadingLabel="Vérification…"
            disabled={busy !== null && busy !== "retry"}
            onClick={() => void retry(current)}
          >
            {current.state === "provisioning_tls"
              ? "Vérifier le certificat"
              : "Vérifier maintenant"}
          </Button>
        ) : null}
      </section>

      <p className="text-[14px] text-ink-soft">
        Ton adresse habituelle reste toujours active :{" "}
        <span className="font-medium wrap-anywhere text-ink">
          {current.fallbackUrl}
        </span>
      </p>

      {confirmDetach ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-danger-soft/50 px-4 py-3">
          <p className="text-[14px] text-ink">
            Délier {current.hostname} ? Ton site ne répondra plus sur ce domaine
            ; ton adresse habituelle continue de fonctionner.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="md"
              variant="danger"
              state={busy === "detach" ? "loading" : "idle"}
              loadingLabel="…"
              onClick={() => void detach(current)}
            >
              Délier le domaine
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmDetach(false)}
            >
              Annuler
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={cn(linkAction, "w-fit text-danger")}
          onClick={() => setConfirmDetach(true)}
        >
          Délier ce domaine
        </button>
      )}
    </div>
  );
}
