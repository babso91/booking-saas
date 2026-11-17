"use client";

import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { CrmError } from "@/features/crm/components/crm-error";
import { setCancellationPolicyAction } from "../actions";

const choices = [
  ["none", "Désactivée : la cliente me contacte"],
  ["0", "Jusqu’au début du rendez-vous"],
  ["1440", "Jusqu’à 24 h avant"],
  ["2880", "Jusqu’à 48 h avant"],
] as const;

export function CancellationPolicyEditor({
  businessId,
  leadMinutes,
}: {
  businessId: string;
  leadMinutes: number | null;
}) {
  const id = useId();
  const [value, setValue] = useState(String(leadMinutes ?? "none"));
  const [saved, setSaved] = useState(value);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);
  const custom = !choices.some(([option]) => option === saved);

  async function save() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const result = await callAction(() =>
        setCancellationPolicyAction({
          businessId,
          cancellationLeadMinutes: value === "none" ? null : Number(value),
        }),
      );
      if (!result.ok) setError(result.error);
      else {
        const next = String(result.data.cancellationLeadMinutes ?? "none");
        setSaved(next);
        setValue(next);
        setDone(true);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-line bg-paper-raised p-5">
      <h2 className="font-display text-[26px] text-ink">Annulation en ligne</h2>
      <p className="text-[14px] leading-relaxed text-ink-soft">
        Les clientes auxquelles tu as ouvert l’espace client peuvent annuler
        elles-mêmes selon le délai que tu choisis.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex flex-col items-start gap-3"
      >
        <label htmlFor={id} className="text-[14px] font-medium text-ink">
          Autoriser l’annulation
        </label>
        <select
          id={id}
          value={value}
          disabled={pending}
          onChange={(event) => {
            setValue(event.target.value);
            setDone(false);
          }}
          className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-[14px] text-ink"
        >
          {custom ? <option value={saved}>{saved} minutes avant</option> : null}
          {choices.map(([option, label]) => (
            <option key={option} value={option}>
              {label}
            </option>
          ))}
        </select>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Ce réglage s’applique aux nouveaux rendez-vous. Ceux déjà réservés
          conservent leurs conditions d’annulation.
        </p>
        <Button
          type="submit"
          state={pending ? "loading" : "idle"}
          disabled={value === saved}
        >
          Enregistrer la règle d’annulation
        </Button>
      </form>
      {error ? (
        <CrmError error={error}>
          La règle n’a pas pu être enregistrée. Vérifie la connexion puis
          réessaie.
        </CrmError>
      ) : null}
      {done ? (
        <Notice tone="success">
          Règle enregistrée pour les nouveaux rendez-vous.
        </Notice>
      ) : null}
    </section>
  );
}
