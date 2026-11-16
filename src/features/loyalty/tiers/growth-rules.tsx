"use client";

import { useEffect, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { callAction } from "@/features/auth/client/call-action";
import {
  getLoyaltyGrowthRulesAction,
  setLoyaltyGrowthRulesAction,
} from "@/features/loyalty/growth/actions";
import type { GrowthRulesDto } from "@/features/loyalty/growth/data";

/**
 * Her VIP tiers and referral (docs/LOYALTY_TIERS_CONTRACT.md). A tier is
 * earned by completed visits in a sliding window, never by the points
 * balance; changing the rules rewrites nothing (nothing is stored per
 * client). Referral gives points to the client who shared her link, once
 * the referred visit is completed. Saved as one versioned set; a version
 * changed elsewhere is said, and nothing is overwritten.
 */

const MAX_TIERS = 5;
const WINDOWS = [
  { days: 90, label: "3 derniers mois" },
  { days: 180, label: "6 derniers mois" },
  { days: 365, label: "12 derniers mois" },
  { days: 730, label: "24 derniers mois" },
];

type TierDraft = { name: string; threshold: string; perk: string };
type Draft = {
  tiers: TierDraft[];
  windowDays: number;
  referral: boolean;
  referralPoints: string;
};

const draftOf = (rules: GrowthRulesDto): Draft => ({
  tiers: rules.tiers.map((tier) => ({
    name: tier.name,
    threshold: String(tier.threshold),
    perk: tier.perk ?? "",
  })),
  windowDays: rules.windowDays,
  referral: rules.referralPoints !== null,
  referralPoints: String(rules.referralPoints ?? 50),
});

/** The draft as the server takes it, or the reason it cannot be sent. */
function commandOf(draft: Draft, version: number) {
  const tiers = draft.tiers.map((tier) => ({
    name: tier.name.trim(),
    threshold: Number(tier.threshold),
    perk: tier.perk.trim() || null,
  }));
  for (const [index, tier] of tiers.entries()) {
    if (!tier.name) return { error: `Donne un nom au niveau ${index + 1}.` };
    if (
      !Number.isInteger(tier.threshold) ||
      tier.threshold < 1 ||
      tier.threshold > 500
    )
      return {
        error: `Le niveau ${index + 1} demande entre 1 et 500 visites.`,
      };
    if (index > 0 && tier.threshold <= tiers[index - 1]!.threshold)
      return {
        error: "Chaque niveau demande plus de visites que le précédent.",
      };
  }
  const points = Number(draft.referralPoints);
  if (
    draft.referral &&
    (!Number.isInteger(points) || points < 1 || points > 10_000)
  )
    return { error: "Les points de parrainage vont de 1 à 10 000." };
  return {
    command: {
      tiers,
      windowDays: draft.windowDays,
      referralPoints: draft.referral ? points : null,
      expectedVersion: version,
    },
  };
}

export function GrowthRules() {
  const [rules, setRules] = useState<GrowthRulesDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let alive = true;
    void callAction(() => getLoyaltyGrowthRulesAction()).then((result) => {
      if (!alive) return;
      if (!result.ok) return setLoadError(result.error.code);
      setRules(result.data);
      setDraft(draftOf(result.data));
    });
    return () => {
      alive = false;
    };
  }, [run]);

  function change(next: Draft) {
    setDraft(next);
    setError(null);
    if (state === "success") setState("idle");
  }

  async function save() {
    if (!draft || !rules || state !== "idle") return;
    const built = commandOf(draft, rules.version);
    if ("error" in built) return setError(built.error ?? null);
    setState("loading");
    setError(null);
    const result = await callAction(() =>
      setLoyaltyGrowthRulesAction(built.command),
    );
    if (result.ok) {
      setRules(result.data);
      setDraft(draftOf(result.data));
      setState("success");
      window.setTimeout(() => setState("idle"), 1_600);
      return;
    }
    setState("idle");
    setError(
      result.error.code === "version_conflict"
        ? "Ces règles ont été modifiées ailleurs. Rien n’a été enregistré : recharge-les pour voir la dernière version."
        : result.error.code === "forbidden"
          ? "Seules la propriétaire et les admins peuvent changer ces règles."
          : result.error.code === "network"
            ? "Pas de réponse : rien n’a peut-être été enregistré. Réessaie."
            : "Les règles n’ont pas pu être enregistrées. Réessaie dans un instant.",
    );
  }

  return (
    <section
      aria-labelledby="growth-rules"
      className="flex min-w-0 flex-col gap-4 border-t border-line pt-6"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="growth-rules"
          className="font-display text-[21px] leading-tight text-ink"
        >
          Niveaux et parrainage
        </h2>
        <p className="text-[14px] leading-snug text-ink-muted">
          Un niveau se gagne avec des visites réalisées sur une période, jamais
          avec le solde de points : dépenser ses points ne fait pas baisser son
          niveau.
        </p>
      </div>

      {loadError ? (
        <Notice
          tone={loadError === "network" ? "offline" : "error"}
          title="Les règles n’ont pas pu être chargées"
          action={
            <button
              type="button"
              className="w-fit cursor-pointer font-semibold underline underline-offset-4"
              onClick={() => {
                setLoadError(null);
                setRun((value) => value + 1);
              }}
            >
              Réessayer
            </button>
          }
        >
          Rien n’a été modifié.
        </Notice>
      ) : !draft ? (
        <span className="h-24 animate-pulse rounded-xl bg-sand/60" />
      ) : (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[15px] font-semibold text-ink">
              Niveaux
            </legend>
            {draft.tiers.length === 0 ? (
              <p className="text-[14px] text-ink-muted">
                Aucun niveau pour l’instant.
              </p>
            ) : (
              <ol className="flex flex-col divide-y divide-line border-y border-line">
                {draft.tiers.map((tier, index) => (
                  <li
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-start gap-2 py-3"
                  >
                    <div className="flex min-w-0 flex-col gap-2">
                      <input
                        aria-label={`Nom du niveau ${index + 1}`}
                        value={tier.name}
                        maxLength={40}
                        placeholder="Argent, Or…"
                        onChange={(event) =>
                          change({
                            ...draft,
                            tiers: draft.tiers.map((item, at) =>
                              at === index
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          })
                        }
                        className="h-11 w-full rounded-xl border border-line bg-paper-raised px-3 text-[15px] text-ink focus-visible:border-ink focus-visible:outline-none"
                      />
                      <input
                        aria-label={`Avantage du niveau ${index + 1}`}
                        value={tier.perk}
                        maxLength={120}
                        placeholder="Avantage (facultatif)"
                        onChange={(event) =>
                          change({
                            ...draft,
                            tiers: draft.tiers.map((item, at) =>
                              at === index
                                ? { ...item, perk: event.target.value }
                                : item,
                            ),
                          })
                        }
                        className="h-10 w-full rounded-xl border border-line bg-paper-raised px-3 text-[14px] text-ink focus-visible:border-ink focus-visible:outline-none"
                      />
                    </div>
                    <label className="flex flex-col gap-1">
                      <input
                        aria-label={`Visites pour le niveau ${index + 1}`}
                        inputMode="numeric"
                        value={tier.threshold}
                        onChange={(event) =>
                          change({
                            ...draft,
                            tiers: draft.tiers.map((item, at) =>
                              at === index
                                ? {
                                    ...item,
                                    threshold: event.target.value.replace(
                                      /\D/g,
                                      "",
                                    ),
                                  }
                                : item,
                            ),
                          })
                        }
                        className="h-11 w-full rounded-xl border border-line bg-paper-raised px-3 text-[15px] text-ink tabular-nums focus-visible:border-ink focus-visible:outline-none"
                      />
                      <span className="text-[12.5px] text-ink-muted">
                        visites
                      </span>
                    </label>
                    <button
                      type="button"
                      aria-label={`Retirer le niveau ${index + 1}`}
                      onClick={() =>
                        change({
                          ...draft,
                          tiers: draft.tiers.filter((_, at) => at !== index),
                        })
                      }
                      className="flex size-11 cursor-pointer items-center justify-center rounded-xl text-ink-muted hover:bg-sand hover:text-ink"
                    >
                      <CloseIcon size={18} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {draft.tiers.length < MAX_TIERS ? (
              <button
                type="button"
                onClick={() => {
                  const last = Number(draft.tiers.at(-1)?.threshold ?? 0);
                  change({
                    ...draft,
                    tiers: [
                      ...draft.tiers,
                      {
                        name: "",
                        threshold: String(Math.min(500, (last || 0) + 3)),
                        perk: "",
                      },
                    ],
                  });
                }}
                className="flex h-10 w-fit cursor-pointer items-center gap-1.5 rounded-xl px-2 text-[13.5px] font-medium text-ink-soft hover:bg-sand hover:text-ink"
              >
                <PlusIcon size={16} />
                Ajouter un niveau
              </button>
            ) : null}
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-[15px] font-semibold text-ink">
              Visites comptées sur
            </span>
            <select
              value={draft.windowDays}
              onChange={(event) =>
                change({ ...draft, windowDays: Number(event.target.value) })
              }
              className="h-11 w-full max-w-xs cursor-pointer rounded-xl border border-line bg-paper-raised px-3 text-[15px] text-ink focus-visible:border-ink focus-visible:outline-none"
            >
              {WINDOWS.some((item) => item.days === draft.windowDays) ? null : (
                <option value={draft.windowDays}>
                  {draft.windowDays} derniers jours
                </option>
              )}
              {WINDOWS.map((item) => (
                <option key={item.days} value={item.days}>
                  les {item.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <label className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-[15px] font-semibold text-ink">
                  Parrainage
                </span>
                <span className="text-[13.5px] text-ink-muted">
                  Tes clientes partagent leur lien depuis leur espace ; elles
                  gagnent des points quand la nouvelle cliente vient vraiment.
                </span>
              </span>
              <Switch
                checked={draft.referral}
                aria-label="Parrainage proposé"
                onChange={() => change({ ...draft, referral: !draft.referral })}
              />
            </label>
            {draft.referral ? (
              <label className="flex items-center gap-2 text-[14.5px] text-ink">
                <input
                  aria-label="Points de parrainage"
                  inputMode="numeric"
                  value={draft.referralPoints}
                  onChange={(event) =>
                    change({
                      ...draft,
                      referralPoints: event.target.value.replace(/\D/g, ""),
                    })
                  }
                  className="h-11 w-24 rounded-xl border border-line bg-paper-raised px-3 text-[15px] text-ink tabular-nums focus-visible:border-ink focus-visible:outline-none"
                />
                points par nouvelle cliente venue
              </label>
            ) : null}
          </div>

          {error ? <Notice tone="error">{error}</Notice> : null}

          <Button
            type="submit"
            size="md"
            className="w-fit"
            state={state}
            loadingLabel="Enregistrement…"
            successLabel="Enregistré"
          >
            Enregistrer
          </Button>
        </form>
      )}
    </section>
  );
}
