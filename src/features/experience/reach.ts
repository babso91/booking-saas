import type { SiteLink, SiteLinkNetwork } from "@/features/sites/links";

import type { Practical } from "./engine/config";
import { telHref, whatsappHref } from "./practical";

// How to reach her from her site (Higani points 3 and 4): her contact
// channels and her links elsewhere, from what she typed in her studio.
// Only what reads as a real address is linked; the rest is not shown.

const NETWORKS: Record<
  SiteLinkNetwork,
  { label: string; handle?: string; hint: string }
> = {
  instagram: {
    label: "Instagram",
    handle: "https://www.instagram.com/",
    hint: "@nom ou adresse",
  },
  tiktok: {
    label: "TikTok",
    handle: "https://www.tiktok.com/@",
    hint: "@nom ou adresse",
  },
  facebook: {
    label: "Facebook",
    handle: "https://www.facebook.com/",
    hint: "nom de la page ou adresse",
  },
  linkedin: { label: "LinkedIn", hint: "adresse du profil" },
  youtube: {
    label: "YouTube",
    handle: "https://www.youtube.com/@",
    hint: "@nom ou adresse",
  },
  pinterest: {
    label: "Pinterest",
    handle: "https://www.pinterest.com/",
    hint: "@nom ou adresse",
  },
  website: { label: "Site web", hint: "adresse de ton site" },
  other: { label: "Autre lien", hint: "adresse" },
};

export const networkLabel = (network: SiteLinkNetwork) =>
  NETWORKS[network].label;
export const networkHint = (network: SiteLinkNetwork) => NETWORKS[network].hint;

/**
 * Where a link leads, or null when what she typed is not an address: her
 * @name on a network that has one, an address with or without https://.
 * Only http(s) to a real host name, never another scheme.
 */
export function linkHref(link: Pick<SiteLink, "network" | "url">) {
  const raw = link.url.trim();
  if (!raw) return null;
  const handle = /^@?([\p{L}\p{N}._-]{1,60})$/u.exec(raw);
  const base = NETWORKS[link.network].handle;
  const candidate =
    handle && base
      ? base + handle[1]
      : /^[a-z][a-z0-9+.-]*:/i.test(raw)
        ? raw
        : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!/^[^.\s]+(\.[^.\s]+)+$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Its name on her page: the network, her own name for « other », else its site. */
export function linkLabel(link: SiteLink, href: string) {
  if (link.network !== "other") return networkLabel(link.network);
  return link.label?.trim() || new URL(href).hostname.replace(/^www\./, "");
}

/** Her links that lead somewhere, in her order. */
export function shownLinks(links: readonly SiteLink[] | undefined) {
  return (links ?? []).flatMap((link) => {
    const href = linkHref(link);
    return href ? [{ href, label: linkLabel(link, href) }] : [];
  });
}

export type ContactChannel = {
  kind: "phone" | "whatsapp" | "email";
  /** What the link says. */
  label: string;
  /** Her number or address, for assistive technologies. */
  text: string;
  href: string;
};

/** Her channels, those she filled in: call, WhatsApp, write. */
export function contactChannels(practical: Practical | undefined) {
  const channels: ContactChannel[] = [];
  const phone = practical?.phone.trim();
  if (phone)
    channels.push({
      kind: "phone",
      label: "Appeler",
      text: phone,
      href: telHref(phone),
    });
  const whatsapp = practical?.whatsapp?.trim();
  const chat = whatsappHref(whatsapp);
  if (whatsapp && chat)
    channels.push({
      kind: "whatsapp",
      label: "WhatsApp",
      text: whatsapp,
      href: chat,
    });
  const email = practical?.email.trim();
  if (email)
    channels.push({
      kind: "email",
      label: "Écrire",
      text: email,
      href: `mailto:${email}`,
    });
  return channels;
}
