"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

import type { ReferralActions, ReferralLinkDto } from "./contract";

// In her space, the client's own referral link: she shares it herself.
// There is no form to write to someone else: nothing is sent from here.
// Rewards are credited by the server after the friend's first visit.

type View =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; link: ReferralLinkDto | null };

export function ReferralCard({
  actions,
  businessName,
  timezone,
}: {
  actions: ReferralActions;
  businessName: string;
  timezone: string;
}) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const requestId = useRef<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let current = true;
    void actions.current().then((result) => {
      if (!current) return;
      setView(
        result.ok
          ? { status: "ready", link: result.data }
          : { status: "error" },
      );
    });
    return () => {
      current = false;
    };
  }, [actions, run]);

  async function create() {
    if (creating) return;
    requestId.current ??= crypto.randomUUID();
    setCreating(true);
    setFailed(false);
    const result = await actions.create({ requestId: requestId.current });
    setCreating(false);
    if (result.ok) {
      requestId.current = null;
      setView({ status: "ready", link: result.data });
    } else setFailed(true);
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    window.setTimeout(() => setCopied(null), 2500);
  }

  const until = (iso: string) =>
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: timezone,
      day: "numeric",
      month: "long",
    }).format(new Date(iso));

  return (
    <section
      aria-label="Parrainage"
      className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex flex-col gap-1">
        <p className="text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
          Parrainage
        </p>
        <h2 className="font-display text-[24px] leading-tight text-ink">
          Faites découvrir {businessName}
        </h2>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Partagez votre lien. Quand une personne réserve avec et vient pour la
          première fois, vous êtes récompensée.
        </p>
      </div>

      {view.status === "loading" ? (
        <div
          role="status"
          aria-label="Chargement…"
          className="h-12 animate-pulse rounded-2xl bg-sand/70"
        />
      ) : view.status === "error" ? (
        <Notice
          tone="error"
          title="Le parrainage n’a pas pu être chargé"
          action={
            <button
              type="button"
              onClick={() => {
                setView({ status: "loading" });
                setRun((value) => value + 1);
              }}
              className="cursor-pointer text-[14px] font-semibold text-ink underline underline-offset-4"
            >
              Réessayer
            </button>
          }
        >
          Réessayez dans un instant.
        </Notice>
      ) : view.link && view.link.state === "active" ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-2xl bg-sand/60 px-4 py-3 text-[14px] break-all text-ink select-all">
            {view.link.url}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="md"
              variant="secondary"
              onClick={() => void copy(view.link!.url)}
            >
              Copier le lien
            </Button>
            <span role="status" className="text-[13px] text-ink-muted">
              {copied === "yes"
                ? "Lien copié"
                : copied === "no"
                  ? "Sélectionnez le lien pour le copier"
                  : `Valable jusqu’au ${until(view.link.expiresAt)}`}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {view.link ? (
            <p className="text-[14px] text-ink-soft">
              Votre lien précédent n’est plus valable.
            </p>
          ) : null}
          <Button
            size="md"
            state={creating ? "loading" : "idle"}
            loadingLabel="Création…"
            onClick={() => void create()}
          >
            Obtenir mon lien
          </Button>
          {failed ? (
            <p role="alert" className="text-[13.5px] text-danger">
              Le lien n’a pas pu être créé. Réessayez : un seul lien sera créé.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
