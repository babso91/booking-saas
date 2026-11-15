"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/cn";

import type { FormFieldDto } from "../contract";
import {
  reviewErrors,
  type ProFormAssignmentDto,
  type VisitFormsActions,
  type VisitFormsDto,
} from "./contract";

// The forms of one visit, from her side: what is asked of her client and
// where it stands, a form to send, a request to withdraw while unanswered,
// and the answers exactly as sent (an attestation with the text the client
// saw) before she marks them read.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

const day = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Paris",
  })
    .format(new Date(iso))
    .replace(/^1 /, "1er ");

function statusText(item: ProFormAssignmentDto, client: string) {
  switch (item.status) {
    case "assigned":
      return `En attente de ${client}${item.expiresAt ? `, jusqu’au ${day(item.expiresAt)}` : ""}`;
    case "submitted":
    case "under_review":
      return item.review === "professional" ? "Reçu, à relire" : "Reçu";
    case "completed":
      return item.reviewedAt ? `Relu le ${day(item.reviewedAt)}` : "Complet";
    case "expired":
      return "Expiré sans réponse";
    case "revoked":
      return "Demande annulée";
  }
}

function answerText(field: FormFieldDto, value: string | boolean) {
  if (field.type === "boolean") return value === true ? "Oui" : "Non";
  if (field.type === "single_choice")
    return (
      field.options?.find((option) => option.id === value)?.label ??
      String(value)
    );
  return String(value);
}

export function VisitForms({
  appointmentId,
  actions,
}: {
  appointmentId: string;
  actions: VisitFormsActions;
}) {
  const [data, setData] = useState<VisitFormsDto | "error" | null>(null);
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success" | "info";
    text: string;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [template, setTemplate] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const idFor = (key: string) => {
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    return requestIds.current.get(key)!;
  };

  useEffect(() => {
    let live = true;
    void actions.read(appointmentId).then((result) => {
      if (live) setData(result.ok ? result.data : "error");
    });
    return () => {
      live = false;
    };
  }, [actions, appointmentId, run]);

  const reload = () => setRun((n) => n + 1);

  if (data === null)
    return (
      <div role="status" aria-label="Chargement des formulaires…">
        <div className="h-24 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (data === "error")
    return (
      <Notice
        tone="error"
        title="Les formulaires n’ont pas pu être chargés"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      />
    );

  const current = data;

  function failed(code: string) {
    if (
      code === reviewErrors.versionConflict ||
      code === reviewErrors.alreadySubmitted
    ) {
      reload();
      return setNotice({
        tone: "info",
        text:
          code === reviewErrors.alreadySubmitted
            ? `${current.clientName} vient de répondre : la demande ne peut plus être annulée.`
            : "Ce formulaire a changé entre-temps : voici son état à jour.",
      });
    }
    setNotice({
      tone: "error",
      text:
        code === reviewErrors.alreadyAssigned
          ? `Ce formulaire est déjà demandé à ${current.clientName} pour cette visite.`
          : code === "network"
            ? "Pas de réponse. Réessaie : une même demande ne s’applique jamais deux fois."
            : "Ça n’a pas abouti. Réessaie dans un instant.",
    });
  }

  async function send() {
    if (!template)
      return setNotice({
        tone: "error",
        text: "Choisis le formulaire à envoyer.",
      });
    setBusy("send");
    setNotice(null);
    const result = await actions.assign({
      appointmentId,
      templateVersionId: template,
      requestId: idFor(`assign:${template}`),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    setData(result.data);
    setTemplate("");
    setNotice({
      tone: "success",
      text: `Demande envoyée : ${current.clientName} le trouvera dans son espace.`,
    });
  }

  async function revoke(item: ProFormAssignmentDto) {
    setBusy(item.assignmentId);
    setNotice(null);
    const result = await actions.revoke({
      assignmentId: item.assignmentId,
      expectedVersion: item.version,
      requestId: idFor(`revoke:${item.assignmentId}:${item.version}`),
    });
    setBusy(null);
    setConfirmRevoke(null);
    if (!result.ok) return failed(result.error.code);
    setData(result.data);
  }

  async function markRead(item: ProFormAssignmentDto) {
    setBusy(item.assignmentId);
    setNotice(null);
    const result = await actions.review({
      assignmentId: item.assignmentId,
      expectedVersion: item.version,
      requestId: idFor(`review:${item.assignmentId}:${item.version}`),
    });
    setBusy(null);
    if (!result.ok) return failed(result.error.code);
    setData(result.data);
    setOpen(null);
  }

  return (
    <section
      aria-label="Formulaires de la visite"
      className="flex flex-col gap-4"
    >
      <h2 className="text-[17px] font-semibold text-ink">Formulaires</h2>

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

      {current.assignments.length === 0 ? (
        <p className="text-[14px] text-ink-muted">
          Aucun formulaire demandé pour cette visite.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {current.assignments.map((item) => {
            const reviewable =
              (item.status === "submitted" || item.status === "under_review") &&
              item.review === "professional";
            return (
              <li
                key={item.assignmentId}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-raised px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[14.5px] font-medium text-ink">
                      {item.title}
                    </span>
                    <span className="text-[13px] text-ink-muted">
                      Version {item.versionNumber} · envoyé le{" "}
                      {day(item.sentAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium",
                      reviewable
                        ? "bg-signature text-on-signature"
                        : "bg-sand text-ink-soft",
                    )}
                  >
                    {statusText(item, current.clientName)}
                  </span>
                </div>

                {item.submission ? (
                  open === item.assignmentId ? (
                    <div className="flex flex-col gap-3 rounded-xl bg-sand/50 px-3 py-3">
                      <p className="text-[12.5px] text-ink-muted">
                        Envoyé le {day(item.submission.submittedAt)}, tel quel.
                      </p>
                      <dl className="flex flex-col gap-2.5">
                        {item.submission.fields
                          .map((field) => ({
                            field,
                            answer: item.submission!.answers.find(
                              (a) => a.fieldId === field.id,
                            ),
                          }))
                          .filter(({ answer }) => answer !== undefined)
                          .map(({ field, answer }) => (
                            <div
                              key={field.id}
                              className="flex flex-col gap-0.5"
                            >
                              <dt className="text-[13px] text-ink-soft">
                                {field.label}
                              </dt>
                              <dd className="text-[14.5px] whitespace-pre-line text-ink">
                                {field.type === "attestation"
                                  ? `Confirmé : « ${answer!.attestedText ?? field.attestationText} »`
                                  : answerText(field, answer!.value)}
                              </dd>
                            </div>
                          ))}
                      </dl>
                      <div className="flex flex-wrap gap-2">
                        {reviewable ? (
                          <Button
                            size="md"
                            state={
                              busy === item.assignmentId ? "loading" : "idle"
                            }
                            loadingLabel="…"
                            onClick={() => void markRead(item)}
                          >
                            Marquer comme relu
                          </Button>
                        ) : null}
                        <Button
                          size="md"
                          variant="ghost"
                          onClick={() => setOpen(null)}
                        >
                          Fermer
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={cn(linkAction, "w-fit")}
                      onClick={() => setOpen(item.assignmentId)}
                    >
                      Lire les réponses
                    </button>
                  )
                ) : null}

                {item.status === "assigned" ? (
                  confirmRevoke === item.assignmentId ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] text-ink">
                        Annuler cette demande ?
                      </span>
                      <Button
                        size="md"
                        variant="danger"
                        state={busy === item.assignmentId ? "loading" : "idle"}
                        loadingLabel="…"
                        onClick={() => void revoke(item)}
                      >
                        Annuler la demande
                      </Button>
                      <Button
                        size="md"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setConfirmRevoke(null)}
                      >
                        Garder
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={cn(linkAction, "w-fit text-danger")}
                      onClick={() => setConfirmRevoke(item.assignmentId)}
                    >
                      Annuler la demande
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {current.templates.length ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
          <div className="sm:flex-1">
            <SelectField
              label="Envoyer un formulaire"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              <option value="">Choisir…</option>
              {current.templates.map((t) => (
                <option key={t.templateVersionId} value={t.templateVersionId}>
                  {t.title} (version {t.versionNumber})
                </option>
              ))}
            </SelectField>
          </div>
          <Button
            size="md"
            variant="secondary"
            state={busy === "send" ? "loading" : "idle"}
            loadingLabel="Envoi…"
            onClick={() => void send()}
          >
            Envoyer
          </Button>
        </div>
      ) : null}
    </section>
  );
}
