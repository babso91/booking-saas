"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import type {
  GradeId,
  MotionId,
  Palette,
  PhotoSlot,
  Section,
  ShapeId,
  SiteConfig,
  TypePairId,
} from "./engine/config";
import { CatalogEditor } from "./catalog/catalog-editor";
import { validate, type Catalog } from "./catalog/model";
import { advise, ensureReadable } from "./engine/harmony";
import { SharePanel } from "./share/share-panel";
import {
  grades,
  motions,
  paletteKeys,
  shapes,
  typePairs,
} from "./engine/tokens";
import { PhotoEditor } from "./photo-editor";
import { photo } from "./photos";
import { can, dormant, plans, type Plan } from "./plans";
import type { Part, Published } from "./site";
import { universes, type Universe, type UniverseId } from "./universes";

// The creation studio, phone first: a bottom sheet over a live preview
// (a side panel on larger screens), clearly an editor. First her business:
// "Prestations", her catalogue (catalog/catalog-editor.tsx), the same in
// every universe and every plan. Then her site, one editor, two modes:
// "Simple" (Core) — universe, photos, texts, colours — and "Créatif"
// (Signature) — composition and style too. The preview is the
// editor: touching a photo opens it. Undo/redo, draft vs. what is online,
// and publishing. Artistic advice never blocks; readability problems are
// fixed before anything is published.

const variants: {
  [K in Section["kind"]]: {
    id: Extract<Section, { kind: K }>["variant"];
    label: string;
  }[];
} = {
  opening: [
    { id: "didone-cut", label: "Coupe Didone" },
    { id: "bloom", label: "Éclosion" },
    { id: "kinetic", label: "Cinétique" },
  ],
  intro: [
    { id: "statement", label: "Manifeste" },
    { id: "lines", label: "Lignes" },
  ],
  work: [
    { id: "lookbook", label: "Lookbook" },
    { id: "arches", label: "Arches" },
    { id: "filmstrip", label: "Pellicule" },
  ],
  portrait: [
    { id: "editorial", label: "Éditorial" },
    { id: "arch", label: "Arche" },
  ],
  services: [
    { id: "index", label: "Index de prix" },
    { id: "shelf", label: "Étagère" },
    { id: "tiles", label: "Tuiles" },
  ],
};

const sceneNames: Record<Section["kind"], string> = {
  opening: "Ouverture",
  intro: "Manifeste",
  work: "Réalisations",
  portrait: "Portrait",
  services: "Prestations",
};

/** What each scene brings, for the "Sections" switches. */
const sceneRoles: Record<Section["kind"], string> = {
  opening: "Ton nom et ta photo de couverture : toujours affichée.",
  intro: "Ta présentation en quelques mots.",
  work: "Tes photos de réalisations.",
  portrait: "Toi, au travail, avec tes mots.",
  services: "Tes prestations et la réservation : toujours affichée.",
};
const lockedScenes: Section["kind"][] = ["opening", "services"];

const universeMoods: Record<UniverseId, string> = {
  mila: "Éditorial · noir et blanc, grandes lettres",
  alma: "Sensoriel · lent, doux, chaleureux",
  "nail-lab": "Expressif · couleur franche, mouvement vif",
};

type Tab =
  | "share"
  | "catalog"
  | "sections"
  | "universe"
  | "photos"
  | "texts"
  | "colors"
  | "composition"
  | "style"
  | "creative";

export function Studio({
  open,
  onOpen,
  universe,
  design,
  draft,
  catalog,
  serviceFocus,
  onServiceFocus,
  plan,
  onPlan,
  onDesign,
  published,
  onPublish,
  view,
  onView,
  photoSlot,
  onPhotoSlot,
  onReplay,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  universe: Universe;
  design: UniverseId;
  draft: Part<SiteConfig>;
  /** Her catalogue (business data), with the draft's shared undo. */
  catalog: Part<Catalog>;
  serviceFocus: string | null;
  onServiceFocus: (id: string | null) => void;
  plan: Plan;
  onPlan: (plan: Plan) => void;
  onDesign: (id: UniverseId) => void;
  published: Published;
  onPublish: (config: SiteConfig) => void;
  view: "draft" | "live";
  onView: (view: "draft" | "live") => void;
  photoSlot: PhotoSlot | null;
  onPhotoSlot: (slot: PhotoSlot | null) => void;
  onReplay: () => void;
}) {
  const [tab, setTab] = useState<Tab>("catalog");
  const [flash, setFlash] = useState<string | null>(null);
  const config = draft.value;
  const creative = plan === "signature";
  const set = (patch: Partial<SiteConfig>, key?: string) =>
    draft.set({ ...config, ...patch }, key);
  const setTokens = (patch: Partial<SiteConfig["tokens"]>, key?: string) =>
    set({ tokens: { ...config.tokens, ...patch } }, key);
  const setPalette = (patch: Partial<Palette>, key?: string) =>
    setTokens({ palette: { ...config.tokens.palette, ...patch } }, key);
  const advice = advise(config);
  const problems = advice.filter((item) => item.level === "problem");
  const tips = advice.filter((item) => item.level === "tip");
  const catalogIssues = validate(catalog.value);
  const changed =
    JSON.stringify(config) !== JSON.stringify(published.config) ||
    JSON.stringify(catalog.value) !== JSON.stringify(published.catalog) ||
    plan !== published.plan ||
    design !== published.design;
  const tabs: { id: Tab; label: string }[] = [
    { id: "catalog", label: "Prestations" },
    { id: "universe", label: "Univers" },
    { id: "sections", label: "Sections" },
    { id: "photos", label: "Photos" },
    { id: "texts", label: "Textes" },
    { id: "colors", label: "Couleurs" },
    ...(creative
      ? [
          { id: "composition" as const, label: "Composition" },
          { id: "style" as const, label: "Style" },
        ]
      : [{ id: "creative" as const, label: "Créatif ✦" }]),
    { id: "share", label: "Partager" },
  ];
  // A service touched in the preview opens in "Prestations".
  const current = serviceFocus
    ? "catalog"
    : creative || !["composition", "style"].includes(tab)
      ? tab
      : "creative";

  // Desktop shortcuts, outside text fields.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) draft.redo();
        else draft.undo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft, open]);

  function publish() {
    if (catalogIssues.length) return; // the button says what is missing
    const corrections = problems.length;
    const safe = ensureReadable(config);
    if (corrections) draft.set(safe);
    onPublish(safe);
    setFlash(
      `En ligne · version ${published.version + 1}${corrections ? ` · ${corrections} correction${corrections > 1 ? "s" : ""} de lisibilité appliquée${corrections > 1 ? "s" : ""}` : ""}`,
    );
    window.setTimeout(() => setFlash(null), 3500);
  }

  function moveSection(index: number, by: -1 | 1) {
    const sections = [...config.sections];
    const target = index + by;
    if (target < 1 || target >= sections.length) return; // the opening stays first
    [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    set({ sections });
  }

  const slotPhoto = (slot: PhotoSlot) =>
    slot === "cover"
      ? config.content.cover
      : slot === "portrait"
        ? config.content.portrait.photo
        : config.content.works[slot]?.photo;

  function replacePhoto(slot: PhotoSlot, id: string) {
    const content =
      slot === "cover"
        ? { ...config.content, cover: id }
        : slot === "portrait"
          ? {
              ...config.content,
              portrait: { ...config.content.portrait, photo: id },
            }
          : {
              ...config.content,
              works: config.content.works.map((work, position) =>
                position === slot ? { ...work, photo: id } : work,
              ),
            };
    set({ content });
  }

  return (
    <div
      style={{ fontFamily: "var(--font-lab-sans)" }}
      className="text-[#141414]"
    >
      {open ? null : (
        <button
          type="button"
          onClick={() => onOpen(true)}
          className="fixed top-14 right-4 z-[45] flex h-11 cursor-pointer items-center gap-2 rounded-full bg-[#141414] px-4 text-[14px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(0,0,0,.6)] ring-1 ring-white/20"
        >
          <span aria-hidden="true">✎</span>
          Personnaliser
        </button>
      )}

      <AnimatePresence>
        {open ? (
          <motion.aside
            key="studio"
            role="dialog"
            aria-label="Studio de création"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-x-0 bottom-0 z-[70] flex h-[64dvh] flex-col rounded-t-[22px] bg-[#FAFAF8] shadow-[0_-30px_80px_-30px_rgba(0,0,0,.55)] md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-[420px] md:rounded-none md:shadow-[-30px_0_80px_-30px_rgba(0,0,0,.45)]"
          >
            <div className="shrink-0 border-b border-black/10">
              <span
                className="mx-auto mt-2 block h-1.5 w-10 rounded-full bg-black/15 md:hidden"
                aria-hidden="true"
              />
              <div className="flex items-center gap-2 px-4 pt-2 md:pt-[max(env(safe-area-inset-top),14px)]">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">Studio</p>
                  <p className="truncate text-[12px] text-black/55">
                    Mode édition · tes clientes ne voient pas ce panneau
                  </p>
                </div>
                <div
                  className="flex shrink-0 rounded-full bg-black/5 p-1"
                  role="group"
                  aria-label="Mode"
                >
                  {(["core", "signature"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={plan === item}
                      onClick={() => onPlan(item)}
                      className={`h-9 cursor-pointer rounded-full px-3 text-[13px] font-semibold ${plan === item ? "bg-white shadow-sm" : "text-black/55"}`}
                    >
                      {plans[item].mode}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onOpen(false);
                    onView("draft");
                    onPhotoSlot(null);
                  }}
                  aria-label="Fermer le studio"
                  className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[18px] hover:bg-black/5"
                >
                  ✕
                </button>
              </div>

              <div className="flex items-center gap-2 px-4 py-2">
                <IconButton
                  label="Annuler"
                  onClick={draft.undo}
                  disabled={!draft.canUndo || view === "live"}
                >
                  ↶
                </IconButton>
                <IconButton
                  label="Rétablir"
                  onClick={draft.redo}
                  disabled={!draft.canRedo || view === "live"}
                >
                  ↷
                </IconButton>
                <div
                  className="flex flex-1 justify-center rounded-full bg-black/5 p-1"
                  role="group"
                  aria-label="Aperçu"
                >
                  {(
                    [
                      ["draft", "Brouillon"],
                      ["live", "En ligne"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={view === id}
                      onClick={() => {
                        onView(id);
                        onPhotoSlot(null);
                      }}
                      className={`h-9 flex-1 cursor-pointer rounded-full px-2 text-[13px] font-semibold ${view === id ? "bg-white shadow-sm" : "text-black/55"}`}
                    >
                      {label}
                      {id === "draft" && changed ? (
                        <span
                          className="ml-1 inline-block size-1.5 rounded-full bg-[#2B3BFF] align-middle"
                          aria-label="modifications non publiées"
                        />
                      ) : null}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={
                    catalogIssues.length
                      ? () => {
                          onView("draft");
                          onPhotoSlot(null);
                          onServiceFocus(null);
                          setTab("catalog");
                        }
                      : publish
                  }
                  disabled={!changed}
                  aria-describedby={
                    catalogIssues.length ? "studio-catalog-issues" : undefined
                  }
                  className={`h-11 shrink-0 cursor-pointer rounded-full px-4 text-[14px] font-semibold disabled:cursor-default disabled:bg-black/10 disabled:text-black/60 ${changed && catalogIssues.length ? "bg-[#FDECEA] text-[#7A1F17]" : "bg-[#2B3BFF] text-white"}`}
                >
                  {!changed
                    ? "Publié ✓"
                    : catalogIssues.length
                      ? `À compléter (${catalogIssues.length})`
                      : "Publier"}
                </button>
                {catalogIssues.length ? (
                  <span id="studio-catalog-issues" className="sr-only">
                    Ton catalogue doit être complété avant de publier.
                  </span>
                ) : null}
              </div>

              {view === "draft" && !photoSlot ? (
                <nav
                  className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
                  aria-label="Réglages"
                >
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={current === item.id}
                      onClick={() => {
                        setTab(item.id);
                        onServiceFocus(null);
                      }}
                      className={`flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[14px] font-medium ${current === item.id ? "bg-[#141414] text-white" : "text-black/70"} ${item.id === "universe" ? "relative ml-2 before:absolute before:top-3 before:-left-1.5 before:h-5 before:w-px before:bg-black/15" : ""}`}
                    >
                      {item.label}
                      {item.id === "catalog" && catalogIssues.length ? (
                        <span
                          className="size-2 rounded-full bg-[#D92D20]"
                          aria-label="à compléter"
                        />
                      ) : null}
                      {item.id === "colors" && problems.length ? (
                        <span
                          className="size-2 rounded-full bg-[#D92D20]"
                          aria-label="à vérifier"
                        />
                      ) : null}
                    </button>
                  ))}
                </nav>
              ) : null}
            </div>

            <div className="flex-1 overflow-y-auto px-4 pt-4 pb-10">
              <AnimatePresence>
                {flash ? (
                  <motion.p
                    role="status"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mb-3 rounded-xl bg-[#E7F6EC] px-3 py-2.5 text-[13px] font-medium text-[#14532D]"
                  >
                    ✓ {flash}
                  </motion.p>
                ) : null}
              </AnimatePresence>

              {view === "live" ? (
                <div className="flex flex-col gap-3">
                  <p className="rounded-xl bg-black/5 p-3 text-[13.5px] leading-relaxed">
                    Tu vois ton site{" "}
                    <strong>tel que tes clientes le voient</strong> : version{" "}
                    {published.version}, publiée à{" "}
                    {published.at.toLocaleTimeString("fr-FR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    .
                    {changed
                      ? " Tes modifications en cours ne sont pas encore en ligne."
                      : ""}
                  </p>
                  <SmallButton onClick={() => onView("draft")}>
                    Revenir au brouillon
                  </SmallButton>
                </div>
              ) : current === "share" ? (
                <SharePanel config={config} changed={changed} />
              ) : current === "catalog" ? (
                <CatalogEditor
                  catalog={catalog}
                  focus={serviceFocus}
                  onFocus={onServiceFocus}
                />
              ) : photoSlot !== null && slotPhoto(photoSlot) ? (
                <PhotoEditor
                  slot={photoSlot}
                  id={slotPhoto(photoSlot)!}
                  focal={
                    config.content.focals[slotPhoto(photoSlot)!] ?? {
                      x: 50,
                      y: 50,
                    }
                  }
                  onFocal={(focal) =>
                    set(
                      {
                        content: {
                          ...config.content,
                          focals: {
                            ...config.content.focals,
                            [slotPhoto(photoSlot)!]: focal,
                          },
                        },
                      },
                      `focal-${photoSlot}`,
                    )
                  }
                  onReplace={(id) => replacePhoto(photoSlot, id)}
                  onBack={() => onPhotoSlot(null)}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  {!creative && dormant(config, universe) ? (
                    <p className="rounded-xl bg-[#EEF0FF] p-3 text-[13px] leading-snug text-[#1F2A7A]">
                      Tes réglages Créatif sont conservés. En Simple, ton site
                      utilise la composition de ton univers ; ils reviendront à
                      l’identique en Créatif.
                    </p>
                  ) : null}
                  {problems.length ? (
                    <Advice
                      items={problems}
                      tone="problem"
                      title="Lisibilité"
                      note="Corrigé automatiquement à la publication : tes clientes doivent pouvoir lire et réserver."
                      onFix={(fix) => draft.set(fix(config))}
                    />
                  ) : null}

                  {current === "universe" ? (
                    <>
                      <p className="text-[13.5px] text-black/60">
                        Change d’univers : ton nom, tes textes et tes photos te
                        suivent. Tes prestations ne dépendent pas de l’univers :
                        elles restent exactement les mêmes.
                      </p>
                      {(Object.keys(universes) as UniverseId[]).map((id) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={design === id}
                          onClick={() => onDesign(id)}
                          className={`flex cursor-pointer items-center gap-3 rounded-2xl border bg-white p-2 pr-4 text-left ${design === id ? "border-[#141414] ring-2 ring-[#141414]" : "border-black/10"}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo(universes[id].config.content.cover, 200)}
                            alt=""
                            className="size-16 rounded-xl object-cover"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[15px] font-semibold">
                              {universes[id].config.brand.name}
                            </span>
                            <span className="block text-[13px] text-black/55">
                              {universeMoods[id]}
                            </span>
                          </span>
                          {design === id ? (
                            <span className="text-[13px] font-semibold">
                              Choisi
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </>
                  ) : current === "sections" ? (
                    <>
                      <p className="text-[13.5px] text-black/60">
                        Choisis ce que ton site montre. Masquer une section ne
                        supprime rien : elle revient telle quelle.
                        {creative
                          ? " L’ordre et les variantes se règlent dans Composition."
                          : ""}
                      </p>
                      {(creative ? config : universe.config).sections.map(
                        (section, index) => {
                          const locked = lockedScenes.includes(section.kind);
                          const shown = !config.hidden?.includes(section.kind);
                          return (
                            <button
                              key={`${section.kind}-${index}`}
                              type="button"
                              role="switch"
                              aria-checked={shown}
                              disabled={locked}
                              onClick={() =>
                                set({
                                  hidden: shown
                                    ? [...(config.hidden ?? []), section.kind]
                                    : (config.hidden ?? []).filter(
                                        (kind) => kind !== section.kind,
                                      ),
                                })
                              }
                              className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-2.5 text-left disabled:cursor-default"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block text-[15px] font-medium">
                                  {sceneNames[section.kind]}
                                </span>
                                <span className="block text-[12.5px] leading-snug text-black/55">
                                  {sceneRoles[section.kind]}
                                </span>
                              </span>
                              <span
                                aria-hidden="true"
                                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${shown ? (locked ? "bg-black/25" : "bg-[#2B3BFF]") : "bg-black/20"}`}
                              >
                                <span
                                  className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform ${shown ? "translate-x-[22px]" : "translate-x-0.5"}`}
                                />
                              </span>
                            </button>
                          );
                        },
                      )}
                    </>
                  ) : current === "photos" ? (
                    <>
                      <p className="text-[13.5px] text-black/60">
                        Touche une photo, ici ou{" "}
                        <strong>directement dans l’aperçu</strong>, pour la
                        remplacer ou la recadrer.
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {(
                          [
                            "cover",
                            "portrait",
                            ...config.content.works.map((_, index) => index),
                          ] as PhotoSlot[]
                        ).map((slot) => {
                          const id = slotPhoto(slot)!;
                          const focal = config.content.focals[id] ?? {
                            x: 50,
                            y: 50,
                          };
                          return (
                            <button
                              key={String(slot)}
                              type="button"
                              onClick={() => onPhotoSlot(slot)}
                              className="flex cursor-pointer flex-col gap-1 text-left"
                            >
                              <span className="relative block aspect-[4/5] overflow-hidden rounded-xl bg-black/10">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={photo(id, 300)}
                                  alt=""
                                  className="absolute inset-0 h-full w-full object-cover"
                                  style={{
                                    objectPosition: `${focal.x}% ${focal.y}%`,
                                  }}
                                />
                              </span>
                              <span className="text-[12.5px] text-black/60">
                                {slot === "cover"
                                  ? "Couverture"
                                  : slot === "portrait"
                                    ? "Ton portrait"
                                    : `Réalisation ${slot + 1}`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : current === "texts" ? (
                    <>
                      <Text
                        label="Nom"
                        value={config.brand.name}
                        onChange={(name) =>
                          set(
                            { brand: { ...config.brand, name } },
                            "brand.name",
                          )
                        }
                      />
                      <Text
                        label="Activité"
                        value={config.brand.kind}
                        onChange={(kind) =>
                          set(
                            { brand: { ...config.brand, kind } },
                            "brand.kind",
                          )
                        }
                      />
                      <Text
                        label="Ville"
                        value={config.brand.location}
                        onChange={(location) =>
                          set(
                            { brand: { ...config.brand, location } },
                            "brand.location",
                          )
                        }
                      />
                      <Text
                        label="Présentation"
                        multiline
                        value={config.brand.intro}
                        onChange={(intro) =>
                          set(
                            { brand: { ...config.brand, intro } },
                            "brand.intro",
                          )
                        }
                      />
                      <p className="mt-2 border-t border-black/10 pt-4 text-[13px] font-semibold">
                        Ton portrait
                      </p>
                      {(
                        [
                          ["name", "Ton prénom", false],
                          ["role", "Ton métier", false],
                          ["text", "Quelques mots sur toi", true],
                        ] as const
                      ).map(([key, label, multiline]) => (
                        <Text
                          key={key}
                          label={label}
                          multiline={multiline}
                          value={config.content.portrait[key]}
                          onChange={(value) =>
                            set(
                              {
                                content: {
                                  ...config.content,
                                  portrait: {
                                    ...config.content.portrait,
                                    [key]: value,
                                  },
                                },
                              },
                              `portrait.${key}`,
                            )
                          }
                        />
                      ))}
                    </>
                  ) : current === "colors" ? (
                    <>
                      <p className="text-[13px] text-black/55">
                        Palettes conçues pour cet univers
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {universe.palettes.map((item) => (
                          <button
                            key={item.name}
                            type="button"
                            onClick={() =>
                              setTokens({
                                palette: {
                                  ...item.palette,
                                  accent:
                                    config.tokens.palette.accent ===
                                    universe.config.tokens.palette.accent
                                      ? item.palette.accent
                                      : config.tokens.palette.accent,
                                },
                              })
                            }
                            className="flex h-11 cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-white pr-4 pl-1.5 text-[13.5px] font-medium"
                          >
                            <span
                              className="flex -space-x-1"
                              aria-hidden="true"
                            >
                              {[
                                item.palette.bg,
                                item.palette.paper,
                                item.palette.accent,
                              ].map((color, index) => (
                                <span
                                  key={index}
                                  className="size-7 rounded-full border-2 border-white"
                                  style={{ background: color }}
                                />
                              ))}
                            </span>
                            {item.name}
                          </button>
                        ))}
                      </div>
                      <ColorRow
                        label="Ta couleur d’accent"
                        value={config.tokens.palette.accent}
                        onChange={(accent) => setPalette({ accent }, "accent")}
                      />
                      {can(plan, "cta") ? (
                        <CtaColor
                          value={config.tokens.cta}
                          palette={config.tokens.palette}
                          onChange={(cta) => setTokens({ cta }, "cta")}
                        />
                      ) : null}
                      {can(plan, "palette-free")
                        ? paletteKeys
                            .filter(({ key }) => key !== "accent")
                            .map(({ key, label }) => (
                              <ColorRow
                                key={key}
                                label={label}
                                value={config.tokens.palette[key]}
                                onChange={(value) =>
                                  setPalette({ [key]: value }, `palette.${key}`)
                                }
                              />
                            ))
                        : null}
                    </>
                  ) : current === "creative" ? (
                    <div className="flex flex-col gap-3 rounded-2xl bg-[#141414] p-5 text-white">
                      <p className="text-[18px] font-semibold">
                        Ton propre studio de direction artistique
                      </p>
                      <p className="text-[14px] leading-relaxed text-white/75">
                        {plans.signature.promise}
                      </p>
                      <ul className="flex flex-col gap-1.5 text-[14px] text-white/85">
                        <li>
                          ✦ Une autre ouverture, une autre galerie, un autre
                          menu
                        </li>
                        <li>✦ L’ordre de tes scènes</li>
                        <li>
                          ✦ Typographies, traitement photo, mouvement, formes
                        </li>
                        <li>✦ Toute ta palette</li>
                      </ul>
                      <button
                        type="button"
                        onClick={() => onPlan("signature")}
                        className="mt-2 h-11 cursor-pointer rounded-full bg-white px-4 text-[14px] font-semibold text-[#141414]"
                      >
                        Essayer le mode Créatif
                      </button>
                    </div>
                  ) : (
                    <>
                      {tips.length ? (
                        <Advice
                          items={tips}
                          tone="tip"
                          title="Conseils d’harmonie"
                          note="Ce sont des suggestions : tu restes libre d’expérimenter."
                          onFix={(fix) => draft.set(fix(config))}
                        />
                      ) : null}
                      {current === "composition" ? (
                        <ol className="flex flex-col gap-2">
                          {config.sections.map((section, index) => (
                            <li
                              key={`${section.kind}-${index}`}
                              className="rounded-2xl border border-black/10 bg-white p-3"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[14px] font-semibold">
                                  {sceneNames[section.kind]}
                                  {config.hidden?.includes(section.kind) ? (
                                    <span className="ml-1.5 font-normal text-black/60">
                                      · masquée
                                    </span>
                                  ) : null}
                                </span>
                                {index > 0 ? (
                                  <span className="flex gap-1">
                                    <IconButton
                                      label={`Monter ${sceneNames[section.kind]}`}
                                      onClick={() => moveSection(index, -1)}
                                      disabled={index <= 1}
                                    >
                                      ↑
                                    </IconButton>
                                    <IconButton
                                      label={`Descendre ${sceneNames[section.kind]}`}
                                      onClick={() => moveSection(index, 1)}
                                      disabled={
                                        index >= config.sections.length - 1
                                      }
                                    >
                                      ↓
                                    </IconButton>
                                  </span>
                                ) : (
                                  <span className="text-[12px] text-black/60">
                                    toujours en premier
                                  </span>
                                )}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {variants[section.kind].map((variant) => (
                                  <Chip
                                    key={variant.id}
                                    selected={section.variant === variant.id}
                                    onClick={() => {
                                      set({
                                        sections: config.sections.map(
                                          (item, position) =>
                                            position === index
                                              ? ({
                                                  ...item,
                                                  variant: variant.id,
                                                } as Section)
                                              : item,
                                        ),
                                      });
                                      if (section.kind === "opening")
                                        onReplay();
                                    }}
                                  >
                                    {variant.label}
                                  </Chip>
                                ))}
                              </div>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <>
                          <Choice<TypePairId>
                            label="Typographie"
                            value={config.tokens.type}
                            options={Object.entries(typePairs).map(
                              ([id, item]) => ({
                                id: id as TypePairId,
                                label: item.label,
                              }),
                            )}
                            onChange={(type) => setTokens({ type })}
                          />
                          <Choice<GradeId>
                            label="Traitement photo"
                            value={config.tokens.grade}
                            options={Object.entries(grades).map(
                              ([id, item]) => ({
                                id: id as GradeId,
                                label: item.label,
                              }),
                            )}
                            onChange={(grade) => setTokens({ grade })}
                          />
                          <Choice<MotionId>
                            label="Mouvement"
                            value={config.tokens.motion}
                            options={Object.entries(motions).map(
                              ([id, item]) => ({
                                id: id as MotionId,
                                label: item.label,
                              }),
                            )}
                            onChange={(motion) => {
                              setTokens({ motion });
                              onReplay();
                            }}
                          />
                          <Choice<ShapeId>
                            label="Formes"
                            value={config.tokens.shape}
                            options={Object.entries(shapes).map(
                              ([id, item]) => ({
                                id: id as ShapeId,
                                label: item.label,
                              }),
                            )}
                            onChange={(shape) => setTokens({ shape })}
                          />
                          <Choice<SiteConfig["booking"]>
                            label="Entrée de la réservation"
                            value={config.booking}
                            options={[
                              { id: "page", label: "Page" },
                              { id: "sheet", label: "Feuille" },
                            ]}
                            onChange={(booking) => set({ booking })}
                          />
                          <Choice<SiteConfig["quickBook"]>
                            label="Réservation rapide"
                            value={config.quickBook}
                            options={[
                              { id: "bar", label: "Barre" },
                              { id: "pill", label: "Pastille" },
                            ]}
                            onChange={(quickBook) => set({ quickBook })}
                          />
                        </>
                      )}
                      {universe.signature ? (
                        <SmallButton
                          onClick={() => {
                            draft.set(universe.signature!.apply(config));
                            onReplay();
                          }}
                        >
                          Inspiration : {universe.signature.name}
                        </SmallButton>
                      ) : null}
                    </>
                  )}

                  <div className="mt-2 flex flex-wrap gap-2 border-t border-black/10 pt-4">
                    <SmallButton onClick={onReplay}>
                      Rejouer l’ouverture
                    </SmallButton>
                    <SmallButton
                      onClick={() =>
                        draft.set({
                          ...universe.config,
                          brand: config.brand,
                          content: config.content,
                          hidden: config.hidden,
                        })
                      }
                    >
                      Revenir à l’univers d’origine
                    </SmallButton>
                  </div>
                </div>
              )}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The colour of her booking buttons (the "Réserver" pill or bar, the
 * booking's main button). She picks the colour; its text is computed, so
 * it always reads (engine/tokens.ts, ctaColors).
 */
function CtaColor({
  value,
  palette,
  onChange,
}: {
  value: string | undefined;
  palette: Palette;
  onChange: (cta: string | undefined) => void;
}) {
  const presets: { label: string; color: string | undefined }[] = [
    { label: "Celle de l’univers", color: undefined },
    { label: "Accent", color: palette.accent },
    { label: "Encre", color: palette.bg },
    { label: "Blanc", color: "#FFFFFF" },
  ];
  const custom =
    value !== undefined &&
    !presets.some(
      (preset) => preset.color?.toLowerCase() === value.toLowerCase(),
    );
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-black/10 bg-white p-3">
      <p className="text-[14px] font-medium">Bouton « Réserver »</p>
      <p className="text-[12.5px] leading-snug text-black/55">
        Sa couleur est à toi ; le texte s’ajuste tout seul pour rester lisible.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <Chip
            key={preset.label}
            selected={
              preset.color === undefined
                ? value === undefined
                : value?.toLowerCase() === preset.color.toLowerCase()
            }
            onClick={() => onChange(preset.color)}
          >
            <span className="flex items-center gap-2">
              {preset.color ? (
                <span
                  aria-hidden="true"
                  className="size-4 rounded-full border border-black/15"
                  style={{ background: preset.color }}
                />
              ) : null}
              {preset.label}
            </span>
          </Chip>
        ))}
      </div>
      <ColorRow
        label={custom ? "Ta couleur" : "Une autre couleur"}
        value={value ?? palette.accent}
        onChange={(color) => onChange(color)}
      />
    </div>
  );
}

function Advice({
  items,
  tone,
  title,
  note,
  onFix,
}: {
  items: ReturnType<typeof advise>;
  tone: "tip" | "problem";
  title: string;
  note: string;
  onFix: (fix: (config: SiteConfig) => SiteConfig) => void;
}) {
  return (
    <section
      aria-label={title}
      className={`flex flex-col gap-2 rounded-2xl p-3 ${tone === "problem" ? "bg-[#FDECEA] text-[#7A1F17]" : "bg-[#EEF0FF] text-[#1F2A7A]"}`}
    >
      <p className="text-[13px] font-semibold">{title}</p>
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-3 text-[13px] leading-snug"
        >
          <span className="flex-1">{item.text}</span>
          {item.fix ? (
            <button
              type="button"
              onClick={() => onFix(item.fix!)}
              className="h-9 shrink-0 cursor-pointer rounded-full bg-white px-3 text-[12.5px] font-semibold"
            >
              {tone === "problem" ? "Corriger" : "Appliquer"}
            </button>
          ) : null}
        </div>
      ))}
      <p className="text-[12px] opacity-75">{note}</p>
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const className =
    "w-full rounded-xl border border-black/10 bg-white px-3 text-[16px] outline-none focus:border-black/40";
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-black/55">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          className={`${className} resize-none py-2.5`}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${className} h-12`}
        />
      )}
    </label>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className="text-[14px]">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-black/60 uppercase">
          {value}
        </span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="size-11 cursor-pointer rounded-lg border border-black/10 bg-transparent p-0.5"
        />
      </span>
    </label>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`h-11 cursor-pointer rounded-full px-4 text-[13.5px] font-medium ${selected ? "bg-[#141414] text-white" : "bg-black/5"}`}
    >
      {children}
    </button>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="text-[13px] text-black/55">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Chip
            key={option.id}
            selected={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function SmallButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[13px] font-medium hover:bg-black/10"
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-black/5 text-[18px] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
