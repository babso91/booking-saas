"use client";

import { useId } from "react";

import { siteLimits } from "@/features/sites/config";
import {
  siteLinkNetworks,
  type SiteLink,
  type SiteLinkNetwork,
} from "@/features/sites/links";

import { linkHref, networkHint, networkLabel } from "../reach";

const field =
  "w-full rounded-xl border border-black/10 bg-white px-3 text-[16px] outline-none focus:border-black/40";

/**
 * Her links elsewhere (Higani point 3): as many as she wants up to eight,
 * each a network and an address or her @name. Nothing is imposed. A link
 * that does not read as an address is kept as typed, said here, and not
 * shown on her site.
 */
export function LinksFields({
  value,
  onChange,
}: {
  value: SiteLink[];
  onChange: (links: SiteLink[]) => void;
}) {
  const update = (index: number, patch: Partial<SiteLink>) =>
    onChange(
      value.map((link, at) => (at === index ? { ...link, ...patch } : link)),
    );
  const hintBase = useId();
  const used = new Set(value.map((link) => link.network));
  const nextNetwork =
    siteLinkNetworks.find((network) => !used.has(network)) ?? "other";

  return (
    <>
      <p className="mt-2 border-t border-black/10 pt-4 text-[13px] font-semibold">
        Réseaux et liens
      </p>
      <p className="text-[12.5px] leading-snug text-black/55">
        En bas de ton site et dans son menu. Colle l’adresse, ou ton @nom pour
        un réseau. Aucun n’est obligatoire.
      </p>
      {value.length ? (
        <ol className="flex flex-col gap-3">
          {value.map((link, index) => {
            const n = index + 1;
            const broken = link.url.trim() !== "" && !linkHref(link);
            return (
              <li
                key={index}
                className="flex flex-col gap-2 rounded-2xl border border-black/10 bg-white/60 p-3"
              >
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Réseau du lien ${n}`}
                    value={link.network}
                    onChange={(event) =>
                      update(index, {
                        network: event.target.value as SiteLinkNetwork,
                      })
                    }
                    className={`${field} h-11 min-w-0 flex-1`}
                  >
                    {siteLinkNetworks.map((network) => (
                      <option key={network} value={network}>
                        {networkLabel(network)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Retirer le lien ${n}`}
                    onClick={() =>
                      onChange(value.filter((_, at) => at !== index))
                    }
                    className="min-h-11 shrink-0 cursor-pointer rounded-xl px-3 text-[14px] text-black/60 hover:bg-black/5"
                  >
                    Retirer
                  </button>
                </div>
                {link.network === "other" ? (
                  <input
                    aria-label={`Nom du lien ${n}`}
                    placeholder="Nom affiché (ex. Ma boutique)"
                    value={link.label ?? ""}
                    maxLength={siteLimits.linkLabel}
                    onChange={(event) =>
                      update(index, { label: event.target.value })
                    }
                    className={`${field} h-11`}
                  />
                ) : null}
                <input
                  aria-label={`Adresse du lien ${n}`}
                  placeholder={networkHint(link.network)}
                  value={link.url}
                  maxLength={siteLimits.linkUrl}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={broken || undefined}
                  aria-describedby={broken ? `${hintBase}-${n}` : undefined}
                  onChange={(event) =>
                    update(index, { url: event.target.value })
                  }
                  className={`${field} h-11`}
                />
                {broken ? (
                  <span
                    id={`${hintBase}-${n}`}
                    className="text-[12.5px] leading-snug text-[#B3261E]"
                  >
                    Lien non reconnu : il n’apparaîtra pas sur ton site.
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {value.length < siteLimits.links ? (
        <button
          type="button"
          onClick={() =>
            onChange([...value, { network: nextNetwork, url: "" }])
          }
          className="min-h-11 cursor-pointer self-start rounded-xl border border-black/15 px-4 text-[14px] font-medium hover:bg-black/5"
        >
          Ajouter un lien
        </button>
      ) : null}
    </>
  );
}
