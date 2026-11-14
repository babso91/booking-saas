"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  exportErrors,
  scopeLabels,
  type CrmExportActions,
  type ExportJobDto,
  type ExportScope,
} from "./contract";

// Her client file, taken out on her request only. The file is prepared on
// the server, available for a short time, downloaded through a private
// link asked at the moment she clicks (her role checked again), and can be
// withdrawn at any time.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const when = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

const statusText = (job: ExportJobDto) =>
  job.status === "requested"
    ? "En préparation"
    : job.status === "ready"
      ? `Prêt · ${job.rowCount ?? 0} lignes · disponible jusqu’au ${when(job.expiresAt!)}`
      : job.status === "expired"
        ? "Expiré : demande un nouvel export"
        : job.status === "revoked"
          ? "Retiré"
          : "Échec : demande un nouvel export";

export function ExportPanel({
  actions,
  refreshKey = 0,
  onOpen = (url: string) => window.location.assign(url),
}: {
  actions: CrmExportActions;
  refreshKey?: number;
  /** Where the private link goes (the browser download by default). */
  onOpen?: (url: string) => void;
}) {
  const [jobs, setJobs] = useState<ExportJobDto[] | "error" | null>(null);
  const [run, setRun] = useState(0);
  const [scope, setScope] = useState<ExportScope>("contacts");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const attempts = useRef(0);

  useEffect(() => {
    let current = true;
    void actions.list().then((result) => {
      if (current) setJobs(result.ok ? result.data : "error");
    });
    return () => {
      current = false;
    };
  }, [actions, run, refreshKey]);

  const reload = () => setRun((n) => n + 1);

  async function request() {
    const key = `${scope}:${attempts.current}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy("request");
    setNotice(null);
    const result = await actions.request({
      scope,
      requestId: requestIds.current.get(key)!,
    });
    setBusy(null);
    if (result.ok || result.error.code !== "network") attempts.current += 1;
    if (result.ok) return reload();
    setNotice(
      result.error.code === exportErrors.permissionDenied
        ? "Seule la propriétaire peut exporter le fichier clientes."
        : result.error.code === exportErrors.inProgress
          ? "Un export est déjà en préparation : attends qu’il soit prêt."
          : result.error.code === "network"
            ? "Pas de réponse. Réessaie : un même export n’est jamais demandé deux fois."
            : "La demande n’a pas abouti. Réessaie dans un instant.",
    );
  }

  async function download(job: ExportJobDto) {
    setBusy(job.jobId);
    setNotice(null);
    const result = await actions.download(job.jobId);
    setBusy(null);
    if (result.ok) return onOpen(result.data.url);
    reload();
    setNotice(
      result.error.code === exportErrors.permissionDenied
        ? "Tes droits ont changé : seule la propriétaire peut télécharger cet export."
        : result.error.code === exportErrors.expired
          ? "Cet export n’est plus disponible. Demande-en un nouveau."
          : "Le téléchargement n’a pas pu commencer. Réessaie.",
    );
  }

  async function revoke(job: ExportJobDto) {
    setBusy(job.jobId);
    const result = await actions.revoke(job.jobId);
    setBusy(null);
    if (!result.ok) return setNotice("Le retrait n’a pas abouti. Réessaie.");
    reload();
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] leading-tight text-ink">
          Exporter mes clientes
        </h1>
        <p className="max-w-prose text-[15px] text-ink-soft">
          Un fichier CSV préparé à ta demande, disponible 24 heures. Il contient
          des données personnelles : garde-le en lieu sûr.
        </p>
      </header>

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      <section
        aria-label="Nouvel export"
        className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[15px] font-medium text-ink">
            Contenu
          </legend>
          {(Object.keys(scopeLabels) as ExportScope[]).map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink"
            >
              <input
                type="radio"
                name="scope"
                checked={scope === value}
                onChange={() => setScope(value)}
                className="size-4 accent-[var(--ink)]"
              />
              {scopeLabels[value]}
            </label>
          ))}
        </fieldset>
        <Button
          size="md"
          state={busy === "request" ? "loading" : "idle"}
          loadingLabel="Demande…"
          disabled={busy !== null && busy !== "request"}
          onClick={() => void request()}
        >
          Préparer l’export
        </Button>
      </section>

      <section aria-label="Exports" className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold text-ink">Exports</h2>
        {jobs === null ? (
          <div role="status" aria-label="Chargement…">
            <div className="h-20 animate-pulse rounded-3xl bg-sand/70" />
          </div>
        ) : jobs === "error" ? (
          <Notice
            tone="error"
            title="La liste n’a pas pu être chargée"
            action={
              <button type="button" className={linkAction} onClick={reload}>
                Réessayer
              </button>
            }
          />
        ) : jobs.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucun export pour le moment.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => (
              <li
                key={job.jobId}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-raised px-4 py-3"
              >
                <span className="text-[14.5px] font-medium text-ink">
                  {scopeLabels[job.scope]}
                </span>
                <span className="text-[13px] text-ink-muted">
                  Demandé le {when(job.requestedAt)} · {statusText(job)}
                </span>
                {job.status === "ready" ? (
                  <span className="flex flex-wrap items-center gap-3">
                    <Button
                      size="md"
                      variant="secondary"
                      state={busy === job.jobId ? "loading" : "idle"}
                      loadingLabel="…"
                      onClick={() => void download(job)}
                    >
                      Télécharger
                    </Button>
                    <button
                      type="button"
                      className={cn(linkAction, "text-danger")}
                      disabled={busy !== null}
                      onClick={() => void revoke(job)}
                    >
                      Retirer
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
