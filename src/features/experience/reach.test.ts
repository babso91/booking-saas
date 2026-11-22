import { describe, expect, it } from "vitest";

import { emptyPractical } from "./practical";
import { contactChannels, linkHref, shownLinks } from "./reach";

describe("linkHref: only what reads as an address is linked (point 3)", () => {
  it.each([
    ["instagram", "@studio.mila", "https://www.instagram.com/studio.mila"],
    ["instagram", "studio.mila", "https://www.instagram.com/studio.mila"],
    ["tiktok", "@mila", "https://www.tiktok.com/@mila"],
    ["youtube", "mila", "https://www.youtube.com/@mila"],
    ["facebook", "studiomila", "https://www.facebook.com/studiomila"],
    [
      "instagram",
      "https://instagram.com/studio.mila",
      "https://instagram.com/studio.mila",
    ],
    ["website", "www.studio-mila.fr", "https://www.studio-mila.fr/"],
    ["website", "studio-mila.fr/tarifs", "https://studio-mila.fr/tarifs"],
    ["linkedin", "http://linkedin.com/in/mila", "http://linkedin.com/in/mila"],
  ] as const)("%s « %s »", (network, url, href) => {
    expect(linkHref({ network, url })).toBe(href);
  });

  it.each([
    ["website", ""],
    ["website", "   "],
    ["website", "monsite"],
    ["linkedin", "mila"],
    ["other", "javascript:alert(1)"],
    ["other", "data:text/html,bonjour"],
    ["website", "mailto:contact@mila.fr"],
    ["instagram", "mon compte insta"],
  ] as const)("%s « %s » is not linked", (network, url) => {
    expect(linkHref({ network, url })).toBeNull();
  });

  it("her links on her page: in her order, named, the unreadable ones left out", () => {
    expect(
      shownLinks([
        { network: "tiktok", url: "@mila" },
        { network: "website", url: "pas un lien" },
        { network: "other", url: "https://boutique.mila.fr", label: "" },
        { network: "other", url: "https://exemple.fr/x", label: "Ma boutique" },
      ]),
    ).toEqual([
      { href: "https://www.tiktok.com/@mila", label: "TikTok" },
      { href: "https://boutique.mila.fr/", label: "boutique.mila.fr" },
      { href: "https://exemple.fr/x", label: "Ma boutique" },
    ]);
    expect(shownLinks(undefined)).toEqual([]);
  });
});

describe("contactChannels: the ways she chose to be reached (point 4)", () => {
  it("call, WhatsApp, write: only those she filled in", () => {
    expect(
      contactChannels({
        ...emptyPractical,
        phone: "04 78 00 00 00",
        whatsapp: "+33 6 12 34 56 78",
        email: "contact@mila.fr",
      }).map(({ kind, label, href }) => [kind, label, href]),
    ).toEqual([
      ["phone", "Appeler", "tel:0478000000"],
      ["whatsapp", "WhatsApp", "https://wa.me/33612345678"],
      ["email", "Écrire", "mailto:contact@mila.fr"],
    ]);
    expect(
      contactChannels({ ...emptyPractical, email: "contact@mila.fr" }).map(
        (channel) => channel.kind,
      ),
    ).toEqual(["email"]);
    expect(contactChannels(undefined)).toEqual([]);
  });

  it("a WhatsApp number without its country code is not linked", () => {
    expect(
      contactChannels({ ...emptyPractical, whatsapp: "06 12 34 56 78" }),
    ).toEqual([]);
  });
});
