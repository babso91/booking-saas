import type { Route } from "next";

import type { ShowcaseGroup } from "../catalog/model";
import type { SiteConfig } from "../engine/config";

// Higani point 124: what would make her page more useful, said in her
// studio, never required. Only what is really missing, most useful first;
// each leads to where it is filled in. Nothing blocks publishing.

export type SuggestionTab = "catalog" | "photos" | "texts" | "infos";

export type Suggestion = {
  id: string;
  title: string;
  why: string;
  /** Where it is filled in: a tab of her studio, or a page of her area. */
  to: { tab: SuggestionTab } | { href: Route; label: string };
};

export function suggestionsFor({
  config,
  catalog,
  hasHours,
}: {
  config: SiteConfig;
  catalog: readonly ShowcaseGroup[];
  /** Her usual hours are set (null: not known here, nothing said). */
  hasHours: boolean | null;
}): Suggestion[] {
  const list: Suggestion[] = [];
  const hidden = new Set(config.hidden ?? []);
  const services = catalog.flatMap((group) => group.services);
  const { content, brand } = config;
  const practical = config.practical;

  if (!services.length)
    list.push({
      id: "services",
      title: "Ajoute tes prestations",
      why: "Sans elles, tes clientes ne peuvent pas réserver.",
      to: { tab: "catalog" },
    });
  if (!content.cover)
    list.push({
      id: "cover",
      title: "Choisis une photo de couverture",
      why: "C’est la première image que voient tes clientes.",
      to: { tab: "photos" },
    });
  if (!hidden.has("intro") && !brand.intro.trim())
    list.push({
      id: "intro",
      title: "Présente-toi en quelques mots",
      why: "Ton approche, ce qui te distingue.",
      to: { tab: "texts" },
    });
  if (!hidden.has("work") && !content.works.some((work) => work.photo))
    list.push({
      id: "works",
      title: "Montre quelques réalisations",
      why: "Tes photos parlent de ton travail mieux qu’un texte.",
      to: { tab: "photos" },
    });
  if (
    !hidden.has("portrait") &&
    (!content.portrait.photo || !content.portrait.text.trim())
  )
    list.push({
      id: "portrait",
      title: "Complète ton portrait",
      why: "Tes clientes aiment savoir qui les reçoit.",
      to: { tab: content.portrait.photo ? "texts" : "photos" },
    });
  const undescribed = services.filter(
    (service) => !service.description?.trim(),
  ).length;
  if (services.length && undescribed)
    list.push({
      id: "descriptions",
      title:
        undescribed > 1
          ? `Décris ${undescribed} prestations`
          : "Décris 1 prestation",
      why: "Une ligne suffit : ce qui est inclus, pour qui.",
      to: { tab: "catalog" },
    });
  if (!practical?.address.trim() && !practical?.area.trim())
    list.push({
      id: "place",
      title: "Dis où tu reçois",
      why: "Ton adresse, ou la zone où tu te déplaces.",
      to: { tab: "infos" },
    });
  if (
    !practical?.phone.trim() &&
    !practical?.email.trim() &&
    !practical?.whatsapp?.trim()
  )
    list.push({
      id: "contact",
      title: "Indique comment te joindre",
      why: "Téléphone, WhatsApp ou e-mail : celui que tu préfères.",
      to: { tab: "infos" },
    });
  if (hasHours === false)
    list.push({
      id: "hours",
      title: "Renseigne tes horaires",
      why: "Ils font apparaître tes créneaux en ligne.",
      to: { href: "/app/settings/hours", label: "Mes horaires" },
    });
  if (!config.links?.length)
    list.push({
      id: "links",
      title: "Ajoute tes réseaux",
      why: "Instagram, TikTok, ton site… si tu en as.",
      to: { tab: "infos" },
    });
  return list;
}
