"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChevronRightIcon, PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";

import type { FormDraft, FormTemplateDto } from "./editor/contract";
import { newField } from "./editor/draft";
import { createTemplate, listTemplates } from "./real-pro-actions";

/**
 * Her form templates (docs/CLIENT_FORMS_CONTRACT.md): what each one is,
 * whether it can be sent (a published version), and a new one. Opening
 * one leads to its editor. Owner and admin only, like every form action.
 */

type Load =
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; templates: FormTemplateDto[] };

function blankDraft(): FormDraft {
  return {
    title: "Nouveau formulaire",
    intro: "",
    review: "none",
    frequency: { kind: "every_appointment" },
    fields: [{ ...newField("short_text"), label: "Votre question" }],
  };
}

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
});

function stateOf(template: FormTemplateDto) {
  const last = template.published[0];
  if (!last) return "Brouillon, jamais publié";
  return `Version ${last.number}, publiée le ${dateFormat
    .format(new Date(last.publishedAt))
    .replace(/^1 /, "1er ")}`;
}

export function FormsList() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listTemplates().then((result) => {
      if (!alive) return;
      setLoad(
        result.ok
          ? { status: "ready", templates: result.data }
          : { status: "error", code: result.error.code },
      );
    });
    return () => {
      alive = false;
    };
  }, [run]);

  async function create() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    const result = await createTemplate(blankDraft());
    if (result.ok) {
      router.push(`/app/forms/${result.data.templateId}`);
      return;
    }
    setCreating(false);
    setCreateError(
      result.error.code === "form_limit_reached"
        ? "Tu as atteint 100 formulaires : modifie un formulaire existant."
        : result.error.code === "permission_denied"
          ? "Seules la propriétaire et les admins peuvent créer un formulaire."
          : result.error.code === "network"
            ? "Pas de réponse. Réessaie."
            : "Le formulaire n’a pas pu être créé. Réessaie dans un instant.",
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex max-w-xl flex-col gap-1.5">
            <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
              Formulaires
            </h1>
            <p className="text-[14.5px] text-ink-soft">
              Les questions que tes clientes remplissent avant une visite. Tu
              les envoies depuis le rendez-vous, dans l’agenda ; elles y
              répondent dans leur espace.
            </p>
          </div>
          <Button
            size="md"
            icon={<PlusIcon size={17} />}
            state={creating ? "loading" : "idle"}
            loadingLabel="Création…"
            onClick={() => void create()}
          >
            Nouveau formulaire
          </Button>
        </header>

        {createError ? <Notice tone="error">{createError}</Notice> : null}

        {load.status === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only" role="status">
              Chargement des formulaires…
            </span>
            <span className="h-16 animate-pulse rounded-xl bg-sand/60" />
            <span className="h-16 animate-pulse rounded-xl bg-sand/50" />
          </div>
        ) : load.status === "error" ? (
          <Notice
            tone={load.code === "network" ? "offline" : "error"}
            title={
              load.code === "permission_denied"
                ? "Réservé à la propriétaire et aux admins"
                : "Les formulaires n’ont pas pu être chargés"
            }
            action={
              load.code === "permission_denied" ? undefined : (
                <button
                  type="button"
                  className="w-fit cursor-pointer font-semibold underline underline-offset-4"
                  onClick={() => {
                    setLoad({ status: "loading" });
                    setRun((value) => value + 1);
                  }}
                >
                  Réessayer
                </button>
              )
            }
          >
            {load.code === "permission_denied"
              ? "Ton rôle ne permet pas de gérer les formulaires."
              : "Rien n’a été perdu."}
          </Notice>
        ) : load.templates.length === 0 ? (
          <div className="flex flex-col items-start gap-2 border-t border-line pt-8">
            <p className="font-display text-[24px] leading-tight text-ink">
              Aucun formulaire pour l’instant
            </p>
            <p className="max-w-prose text-[14.5px] text-ink-soft">
              Par exemple : « Portez-vous des lentilles ? », un consentement à
              confirmer, ou la courbure souhaitée. Publie-le, puis envoie-le
              depuis un rendez-vous.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {load.templates.map((template) => (
              <li key={template.templateId}>
                <Link
                  href={`/app/forms/${template.templateId}`}
                  className="group -mx-2 flex items-center gap-4 rounded-xl px-2 py-4 transition-colors duration-150 hover:bg-sand/50"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[16px] font-semibold wrap-anywhere text-ink">
                      {template.draft.title || "Sans titre"}
                    </span>
                    <span className="text-[13.5px] text-ink-muted">
                      {stateOf(template)} · {template.draft.fields.length}{" "}
                      question{template.draft.fields.length > 1 ? "s" : ""}
                    </span>
                  </span>
                  <ChevronRightIcon
                    size={18}
                    className="shrink-0 text-ink-muted transition-transform duration-150 group-hover:translate-x-0.5"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
