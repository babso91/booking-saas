"use client";

import {
  isInfoKey,
  type PageKey,
  type PageSectionKind,
} from "@/features/sites/presentation";

import { useEngine } from "../engine/engine";

/** What « Modifier » opens for each section of her page (point 120). */
const EDITED: Partial<Record<PageSectionKind, string>> = {
  opening: "ton nom et ton métier",
  intro: "ta présentation",
  work: "tes réalisations",
  portrait: "ton portrait",
  services: "tes prestations",
  practical: "tes infos pratiques",
};

/**
 * In her studio only: « ✎ Modifier » on a section of the preview, which
 * opens her studio where that section is edited (Higani point 120). Not
 * on her reviews (written by her clients), nor on her public site.
 */
export function SectionEdit({ kind }: { kind: PageKey }) {
  const { edit, config } = useEngine();
  // One of her informative sections (point 16): edited in « Sections ».
  const info = isInfoKey(kind)
    ? config.infoSections?.find((item) => `info:${item.id}` === kind)
    : undefined;
  const what = isInfoKey(kind)
    ? info && `ta section « ${info.title.trim() || "sans titre"} »`
    : EDITED[kind];
  if (!edit?.section || !what) return null;
  return (
    <button
      type="button"
      onClick={() => edit.section!(kind)}
      aria-label={`Modifier ${what}`}
      // On the opening, below the site's header (its buttons sit at the top).
      className={`absolute right-3 z-20 flex min-h-11 cursor-pointer items-center rounded-full bg-black/70 px-3.5 text-[12.5px] font-medium text-white backdrop-blur ${kind === "opening" ? "top-[4.75rem]" : "top-3"}`}
      style={{ fontFamily: "var(--font-site-sans)" }}
    >
      <span aria-hidden="true">✎&nbsp;</span>Modifier
    </button>
  );
}
