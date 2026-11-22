import { z } from "zod";
import { siteLinkNetworks } from "./links";
import { pageSectionKinds } from "./presentation";

import { bookingFormats } from "@/features/public-booking/formats";

// A mini-site's configuration (schema_version 1): the Experience Engine's
// SiteConfig (proto/experience-engine, engine/config.ts), validated by the
// server before it is stored (docs/SITE_PUBLISHING_CONTRACT.md § 4).
// Presentation only: her services, prices, availability and booking are
// never here (catalogue and booking backends).

export const SITE_SCHEMA_VERSION = 1;

/** The registry: what a configuration may name. Unknown values are refused. */
export const siteRegistry = {
  universes: ["mila", "alma", "nail-lab"],
  types: ["didone", "soft-serif", "condensed", "neutral"],
  grades: ["silver", "warm", "natural", "chrome"],
  motions: ["cut", "settle", "snap"],
  shapes: ["sharp", "soft", "round"],
  variants: {
    opening: ["didone-cut", "bloom", "kinetic"],
    intro: ["statement", "lines"],
    work: ["lookbook", "arches", "filmstrip"],
    portrait: ["editorial", "arch"],
    services: ["index", "shelf", "tiles"],
  },
} as const;

export const siteLimits = {
  name: 80,
  kind: 80,
  location: 80,
  intro: 600,
  workTitle: 80,
  sectionLabel: 48,
  bookingLabel: 32,
  workNote: 300,
  portraitName: 80,
  portraitRole: 80,
  portraitText: 1200,
  works: 24,
  practicalAddress: 160,
  practicalArea: 160,
  practicalAccess: 400,
  practicalInstructions: 600,
  practicalPayment: 160,
  practicalAccessibility: 300,
  practicalPhone: 30,
  practicalEmail: 120,
  practicalLateness: 300,
  practicalNoShow: 300,
  practicalCompanions: 300,
  practicalWhatsapp: 30,
  links: 8,
  linkUrl: 300,
  linkLabel: 40,
} as const;

/**
 * Plain text: trimmed, bounded, no markup and no control character (it is
 * shown as text, never interpreted).
 */
const plainText = (max: number, required = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !required || value.length > 0, "Texte obligatoire.")
    .refine(
      (value) =>
        !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      "Texte brut uniquement.",
    );

const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Couleur #rrggbb.")
  .transform((value) => value.toLowerCase());

/** One of her photos (site_assets of this business, checked by the database). */
const photo = z.object({ asset: z.uuid() }).strict();

const percent = z.number().min(0).max(100);

const palette = z
  .object({
    bg: colour,
    ink: colour,
    paper: colour,
    inkOnPaper: colour,
    muted: colour,
    line: colour,
    accent: colour,
    onAccent: colour,
  })
  .strict();

const section = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("opening"),
      variant: z.enum(siteRegistry.variants.opening),
    })
    .strict(),
  z
    .object({
      kind: z.literal("intro"),
      variant: z.enum(siteRegistry.variants.intro),
    })
    .strict(),
  z
    .object({
      kind: z.literal("work"),
      variant: z.enum(siteRegistry.variants.work),
    })
    .strict(),
  z
    .object({
      kind: z.literal("portrait"),
      variant: z.enum(siteRegistry.variants.portrait),
    })
    .strict(),
  z
    .object({
      kind: z.literal("services"),
      variant: z.enum(siteRegistry.variants.services),
    })
    .strict(),
]);

/**
 * Her "Infos pratiques" (Higani point 5). Every text may be empty (not
 * shown). Her phone and e-mail are published only because she typed them
 * here: never copied from her account.
 */
const practical = z
  .object({
    address: plainText(siteLimits.practicalAddress),
    area: plainText(siteLimits.practicalArea),
    access: plainText(siteLimits.practicalAccess),
    instructions: plainText(siteLimits.practicalInstructions),
    payment: plainText(siteLimits.practicalPayment),
    accessibility: plainText(siteLimits.practicalAccessibility),
    phone: plainText(siteLimits.practicalPhone).refine(
      (value) => /^(\+?[0-9][0-9 .()-]{5,})?$/.test(value),
      "Numéro de téléphone invalide.",
    ),
    email: plainText(siteLimits.practicalEmail).refine(
      (value) => !value || z.email().safeParse(value).success,
      "Adresse e-mail invalide.",
    ),
    showHours: z.boolean(),
    // Her conditions before booking (Higani point 6). Absent from sites
    // published before: nothing is shown for them.
    // Higani point 4: a messaging number, shown as a WhatsApp link when it
    // reads as an international number; never blocks her draft.
    whatsapp: plainText(siteLimits.practicalWhatsapp).optional(),
    lateness: plainText(siteLimits.practicalLateness).optional(),
    noShow: plainText(siteLimits.practicalNoShow).optional(),
    companions: plainText(siteLimits.practicalCompanions).optional(),
  })
  .strict();

/**
 * Her links elsewhere (Higani point 3). Kept as she typed them (plain
 * text, an address or her @name): the page links only what reads as an
 * http(s) address (experience/reach.ts), so a half-typed link never blocks
 * her draft and nothing else is ever linked.
 */
const links = z
  .array(
    z
      .object({
        network: z.enum(siteLinkNetworks),
        url: plainText(siteLimits.linkUrl),
        label: plainText(siteLimits.linkLabel).optional(),
      })
      .strict(),
  )
  .max(siteLimits.links);

const sceneKind = z.enum(["opening", "intro", "work", "portrait", "services"]);

const pageKind = z.enum(pageSectionKinds);
const presentation = z
  .object({
    order: z
      .array(pageKind)
      .max(pageSectionKinds.length)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
    labels: z
      .partialRecord(
        pageKind,
        z
          .object({
            title: plainText(siteLimits.sectionLabel).optional(),
            hideTitle: z.boolean().optional(),
            menu: plainText(siteLimits.sectionLabel).optional(),
          })
          .strict(),
      )
      .optional(),
    bookingLabel: plainText(siteLimits.bookingLabel).optional(),
    gallery: z.enum(siteRegistry.variants.work).optional(),
    galleryMotion: z.enum(siteRegistry.motions).optional(),
  })
  .strict();

export const siteConfigSchema = z
  .object({
    universe: z.enum(siteRegistry.universes),
    brand: z
      .object({
        name: plainText(siteLimits.name, true),
        kind: plainText(siteLimits.kind),
        location: plainText(siteLimits.location),
        intro: plainText(siteLimits.intro),
      })
      .strict(),
    content: z
      .object({
        cover: photo.nullable(),
        logo: photo.nullable().optional(),
        works: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z0-9-]{1,40}$/),
                photo,
                title: plainText(siteLimits.workTitle),
                note: plainText(siteLimits.workNote),
              })
              .strict(),
          )
          .max(siteLimits.works)
          .refine(
            (works) =>
              new Set(works.map((work) => work.id)).size === works.length,
            "Une œuvre apparaît deux fois.",
          ),
        portrait: z
          .object({
            photo: photo.nullable(),
            name: plainText(siteLimits.portraitName),
            role: plainText(siteLimits.portraitRole),
            text: plainText(siteLimits.portraitText),
          })
          .strict(),
        /** Focal point of each photo, by asset id (centre when absent). */
        focals: z.record(
          z.uuid(),
          z.object({ x: percent, y: percent }).strict(),
        ),
      })
      .strict(),
    tokens: z
      .object({
        palette,
        type: z.enum(siteRegistry.types),
        grade: z.enum(siteRegistry.grades),
        motion: z.enum(siteRegistry.motions),
        shape: z.enum(siteRegistry.shapes),
        /** The booking buttons' colour; the universe's when absent. */
        cta: colour.optional(),
      })
      .strict(),
    sections: z
      .array(section)
      .min(2)
      .max(5)
      .refine(
        (sections) =>
          new Set(sections.map((item) => item.kind)).size === sections.length,
        "Une scène apparaît deux fois.",
      )
      .refine(
        (sections) =>
          sections.some((item) => item.kind === "opening") &&
          sections.some((item) => item.kind === "services"),
        "L’ouverture et les prestations sont toujours présentes.",
      ),
    presentation: presentation.optional(),
    hidden: z
      .array(sceneKind)
      .max(5)
      .refine(
        (hidden) => !hidden.includes("opening") && !hidden.includes("services"),
        "L’ouverture et les prestations ne se masquent pas.",
      )
      .optional(),
    booking: z.enum(["page", "sheet"]),
    bookingFormat: z.enum(bookingFormats).optional(),
    quickBook: z.enum(["bar", "pill"]),
    /** Absent on versions published before it: no block of hers. */
    practical: practical.optional(),
    links: links.optional(),
  })
  .strict();

export type SiteConfig = z.output<typeof siteConfigSchema>;
export type SitePalette = SiteConfig["tokens"]["palette"];

/** Every asset id a configuration refers to (photos and focal keys). */
export function siteAssetIds(config: SiteConfig): string[] {
  const ids = new Set<string>(Object.keys(config.content.focals));
  if (config.content.logo) ids.add(config.content.logo.asset);
  if (config.content.cover) ids.add(config.content.cover.asset);
  if (config.content.portrait.photo)
    ids.add(config.content.portrait.photo.asset);
  for (const work of config.content.works) ids.add(work.photo.asset);
  return [...ids];
}
