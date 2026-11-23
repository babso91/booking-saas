"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import Link from "next/link";

import {
  bookingFormats,
  bookingFormatCopy,
} from "@/features/public-booking/formats";
import {
  infoKey,
  isInfoKey,
  orderedKinds,
  sectionNames,
  type PageKey,
  type PageSectionKind,
  type SitePresentation,
  type SectionText,
} from "@/features/sites/presentation";
import { siteLimits } from "@/features/sites/config";

import { startingAt, type ShowcaseGroup } from "../catalog/model";
import type {
  GradeId,
  InfoSection,
  MotionId,
  Palette,
  PhotoSlot,
  Practical,
  Section,
  ShapeId,
  SiteConfig,
  TypePairId,
} from "../engine/config";
import { euros, minutes } from "../engine/engine";
import { advise, ensureReadable } from "../engine/harmony";
import { emptyPractical, whatsappHref } from "../practical";
import { LinksFields } from "./links-fields";
import { suggestionsFor } from "./suggestions";
import { SuggestionsCard } from "./suggestions-card";
import {
  grades,
  motions,
  paletteKeys,
  shapes,
  typePairs,
} from "../engine/tokens";
import { canonical } from "./canonical";
import { PhotoEditor, type UploadOutcome } from "./photo-editor";
import { useStudioPhoto } from "./photos";
import { can, dormant, plans, type Plan } from "./plans";
import { universes, type Universe, type UniverseId } from "./universes";

/** Her draft, with undo and redo (history.ts). */
type Part<T> = {
  value: T;
  set: (value: T, key?: string) => void;
  /** A change applied to the latest value (history.ts). */
  update: (change: (value: T) => T, key?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

/** Her version online (null: never published). */
export type Online = {
  config: SiteConfig;
  number: number;
  publishedAt: string;
} | null;

// The creation studio, phone first: a bottom sheet over a live preview
// (a side panel on larger screens), clearly an editor. Her site, one
// editor, two modes, set by her plan on the server (never from here):
// "Simple" (Core) — universe, photos, texts, colours — and "Créatif"
// (Signature) — composition and style too. The preview is the editor:
// touching a photo opens it. Undo/redo, draft vs. what is online,
// publishing and her history. Her catalogue is business data, not design:
// shown as her clients see it, changed in Prestations (the same in every
// universe, published at once, never with the design). Artistic advice
// never blocks; readability problems are fixed before anything is
// published. From the Experience Engine lab (proto/experience-engine).

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

const universeMoods: Record<UniverseId, string> = {
  mila: "Éditorial · noir et blanc, grandes lettres",
  alma: "Sensoriel · lent, doux, chaleureux",
  "nail-lab": "Expressif · couleur franche, mouvement vif",
};

/**
 * Titles offered for a new informative section (Higani point 16): common
 * to appointments of every trade; she writes the text, and may retitle.
 */
const INFO_IDEAS = [
  "Avant votre rendez-vous",
  "Déroulé d’une séance",
  "Questions fréquentes",
  "Mes engagements",
];

/** Where each section of her page is edited (Higani point 120). */
export const sectionTabs = {
  opening: "texts",
  intro: "texts",
  work: "photos",
  portrait: "texts",
  services: "catalog",
  practical: "infos",
} as const;

export type Tab =
  | "history"
  | "catalog"
  | "reservation"
  | "sections"
  | "universe"
  | "photos"
  | "texts"
  | "infos"
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
  plan,
  onDesign,
  published,
  publishing,
  onPublish,
  view,
  onView,
  photoSlot,
  onPhotoSlot,
  onReplay,
  onPreviewBooking,
  library,
  onUpload,
  onDeletePhoto,
  status,
  history,
  flash,
  publicPath,
  onLeave,
  hasHours = null,
  tabRequest = null,
  onClientView,
}: {
  /** Opens « Comme mes clientes » (points 122, 123). */
  onClientView?: () => void;
  /** A tab asked from her page (« Modifier » on a section): opened. */
  tabRequest?: { tab: Tab; at: number } | null;
  /** Her usual hours are set (null: not known here). */
  hasHours?: boolean | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  universe: Universe;
  design: UniverseId;
  draft: Part<SiteConfig>;
  /** Her catalogue as her clients see it (get_public_catalog). */
  catalog: ShowcaseGroup[];
  /** Her plan, as the server keeps it. */
  plan: Plan;
  onDesign: (id: UniverseId) => void;
  published: Online;
  publishing: boolean;
  /** Publishes this (readable) draft; `corrections`: colours fixed for it. */
  onPublish: (config: SiteConfig, corrections: number) => void;
  view: "draft" | "live";
  onView: (view: "draft" | "live") => void;
  photoSlot: PhotoSlot | null;
  onPhotoSlot: (slot: PhotoSlot | null) => void;
  onReplay: () => void;
  onPreviewBooking?: () => void;
  /** Her photos already sent and ready (asset ids, latest first). */
  library: string[];
  onUpload: (file: File, purpose?: "logo") => Promise<UploadOutcome>;
  /** Out of her library: deleted, or `forGood` revoked everywhere. */
  onDeletePhoto: (
    id: string,
    forGood: boolean,
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  /** Where her draft stands (saved, saving, a conflict…): said at the top. */
  status: ReactNode;
  /** Her published versions and their restoring. */
  history: ReactNode;
  /** The last thing done, said briefly (published, restored…). */
  flash: string | null;
  /** Her public page (/b/[slug]), where her published site is. */
  publicPath: string;
  /** On her links out of the studio: her draft is saved first. */
  onLeave: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const photo = useStudioPhoto();
  const [tab, setTab] = useState<Tab>("universe");
  // A section's « Modifier » on her page: its tab, each time it is asked.
  const [asked, setAsked] = useState(tabRequest);
  if (tabRequest !== asked) {
    setAsked(tabRequest);
    if (tabRequest) setTab(tabRequest.tab);
  }
  const config = draft.value;
  const workInPhotoEditor =
    typeof photoSlot === "number" ? config.content.works[photoSlot] : undefined;
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
  // Her design only: her catalogue is published at once, in Prestations.
  const changed =
    published === null || canonical(config) !== canonical(published.config);
  const tabs: { id: Tab; label: string }[] = [
    { id: "catalog", label: "Prestations" },
    { id: "reservation", label: "Réservation" },
    { id: "universe", label: "Univers" },
    { id: "sections", label: "Sections" },
    { id: "photos", label: "Photos" },
    { id: "texts", label: "Textes" },
    { id: "infos", label: "Infos" },
    { id: "colors", label: "Couleurs" },
    ...(creative
      ? [
          { id: "composition" as const, label: "Composition" },
          { id: "style" as const, label: "Style" },
        ]
      : [{ id: "creative" as const, label: "Créatif ✦" }]),
    { id: "history", label: "Historique" },
  ];
  const current =
    creative || !["composition", "style"].includes(tab) ? tab : "creative";

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
    // Readability is fixed before anything is published (the server
    // checks it again, under both plans).
    const corrections = problems.length;
    const safe = ensureReadable(config);
    if (corrections) draft.set(safe);
    onPublish(safe, corrections);
  }

  // Her informative sections (point 16) after her scenes, as on her page.
  const sectionOrder = orderedKinds<PageKey>(
    [
      ...(creative ? config : universe.config).sections.map(
        (scene) => scene.kind,
      ),
      ...(config.infoSections ?? []).map((info) => infoKey(info.id)),
      "practical",
      "reviews",
    ],
    creative ? config.presentation?.order : undefined,
  );
  // The section she just added: opened, its text field ready.
  const [added, setAdded] = useState<string | null>(null);

  function addInfoSection(title: string) {
    const taken = new Set((config.infoSections ?? []).map((item) => item.id));
    let id = crypto.randomUUID().slice(0, 8);
    while (taken.has(id)) id = crypto.randomUUID().slice(0, 8);
    // Once she placed her sections (Signature), a new one still comes
    // after her scenes, before her practical infos, not after her reviews.
    const order = config.presentation?.order;
    const at = order?.findIndex(
      (item) => item === "practical" || item === "reviews",
    );
    set({
      infoSections: [...(config.infoSections ?? []), { id, title, text: "" }],
      ...(order
        ? {
            presentation: {
              ...config.presentation,
              order:
                at === undefined || at < 0
                  ? [...order, infoKey(id)]
                  : [...order.slice(0, at), infoKey(id), ...order.slice(at)],
            },
          }
        : {}),
    });
    setAdded(id);
  }

  function setInfoSection(
    id: string,
    patch: Partial<Omit<InfoSection, "id">>,
    key: string,
  ) {
    set(
      {
        infoSections: (config.infoSections ?? []).map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      },
      key,
    );
  }

  function removeInfoSection(id: string) {
    const order = config.presentation?.order;
    set({
      infoSections: (config.infoSections ?? []).filter(
        (item) => item.id !== id,
      ),
      ...(order
        ? {
            presentation: {
              ...config.presentation,
              order: order.filter((item) => item !== infoKey(id)),
            },
          }
        : {}),
    });
  }

  function setPresentation(patch: Partial<SitePresentation>, key?: string) {
    set({ presentation: { ...config.presentation, ...patch } }, key);
  }

  function setSectionText(
    kind: PageSectionKind,
    patch: SectionText,
    key?: string,
  ) {
    const labels = config.presentation?.labels;
    setPresentation(
      { labels: { ...labels, [kind]: { ...labels?.[kind], ...patch } } },
      key,
    );
  }

  function moveSection(kind: PageKey, by: -1 | 1) {
    const index = sectionOrder.indexOf(kind);
    const target = index + by;
    if (!creative || index < 0 || target < 0 || target >= sectionOrder.length)
      return;
    const order = [...sectionOrder];
    [order[index], order[target]] = [order[target]!, order[index]!];
    const sections = order.flatMap((item) =>
      config.sections.filter((scene) => scene.kind === item),
    );
    set({ sections, presentation: { ...config.presentation, order } });
  }

  /** Her photo in a place (null: none yet; a new work has none yet). */
  const slotPhoto = (slot: PhotoSlot): string | null =>
    (slot === "logo"
      ? config.content.logo
      : slot === "cover"
        ? config.content.cover
        : slot === "portrait"
          ? config.content.portrait.photo
          : config.content.works[slot]?.photo) || null;

  /** Takes a photo out of its place; a work goes with its photo. */
  function removePhoto(slot: PhotoSlot) {
    const content =
      slot === "logo"
        ? { ...config.content, logo: null }
        : slot === "cover"
          ? { ...config.content, cover: null }
          : slot === "portrait"
            ? {
                ...config.content,
                portrait: { ...config.content.portrait, photo: null },
              }
            : {
                ...config.content,
                works: config.content.works.filter(
                  (_, position) => position !== slot,
                ),
              };
    set({ content });
    onPhotoSlot(null);
  }

  /** A new work, opened in the photo editor to add its photo. */
  function addWork() {
    const works = config.content.works;
    set({
      content: {
        ...config.content,
        works: [
          ...works,
          {
            id: `w-${Date.now().toString(36)}`,
            photo: "",
            title: "",
            note: "",
          },
        ],
      },
    });
    onPhotoSlot(works.length);
  }

  // An upload can finish after she edited something else (or left the
  // photo): the photo goes into the draft as it is then, never into the
  // copy seen when the upload started (Codex review of #50).
  function replacePhoto(slot: PhotoSlot, id: string) {
    draft.update((current) => withPhoto(current, slot, id));
  }

  function setWorkTitle(id: string, title: string) {
    draft.update(
      (current) => ({
        ...current,
        content: {
          ...current.content,
          works: current.content.works.map((work) =>
            work.id === id ? { ...work, title } : work,
          ),
        },
      }),
      `works.${id}.title`,
    );
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
          // The same face as the launcher it replaces (site.tsx).
          style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
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
                <Link
                  href="/app"
                  onClick={onLeave}
                  aria-label="Revenir à mon espace"
                  className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-full text-[18px] hover:bg-black/5"
                >
                  ←
                </Link>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">Studio</p>
                  <p className="truncate text-[12px] text-black/55">
                    Mode édition · tes clientes ne voient pas ce panneau
                  </p>
                </div>
                {/* Her plan, as the server keeps it: never switched from here. */}
                <span
                  className="shrink-0 rounded-full bg-black/5 px-3 py-2 text-[13px] font-semibold"
                  title={plans[plan].promise}
                >
                  Mode {plans[plan].mode}
                </span>
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

              {/* Wraps on the narrowest phones (320 px): publish goes below. */}
              <div className="flex flex-wrap items-center gap-2 px-4 py-2">
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
                  className="flex min-w-[150px] flex-1 justify-center rounded-full bg-black/5 p-1"
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
                      className={`h-9 flex-1 cursor-pointer rounded-full px-2 text-[13px] font-semibold whitespace-nowrap ${view === id ? "bg-white shadow-sm" : "text-black/55"}`}
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
                  onClick={publish}
                  disabled={!changed || publishing}
                  className="ml-auto h-11 shrink-0 cursor-pointer rounded-full bg-[#2B3BFF] px-4 text-[14px] font-semibold text-white disabled:cursor-default disabled:bg-black/10 disabled:text-black/60"
                >
                  {publishing
                    ? "Publication…"
                    : !changed
                      ? "Publié ✓"
                      : "Publier"}
                </button>
              </div>
              {/* Where her draft stands: saved, saving, a conflict… */}
              <div className="px-4 pb-2">{status}</div>
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3 pb-2">
                {onClientView ? (
                  <button
                    type="button"
                    onClick={onClientView}
                    className="h-9 shrink-0 cursor-pointer rounded-full bg-[#141414] px-3.5 text-[13px] font-semibold text-white"
                  >
                    Voir comme mes clientes
                  </button>
                ) : null}
                {published ? <LiveLink path={publicPath} /> : null}
              </div>

              {view === "draft" && photoSlot === null ? (
                <nav
                  className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
                  aria-label="Réglages"
                >
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={current === item.id}
                      onClick={() => setTab(item.id)}
                      className={`flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[14px] font-medium ${current === item.id ? "bg-[#141414] text-white" : "text-black/70"} ${item.id === "universe" ? "relative ml-2 before:absolute before:top-3 before:-left-1.5 before:h-5 before:w-px before:bg-black/15" : ""}`}
                    >
                      {item.label}
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

              {view === "draft" && photoSlot === null ? (
                <SuggestionsCard
                  suggestions={suggestionsFor({ config, catalog, hasHours })}
                  onTab={setTab}
                  onLeave={onLeave}
                />
              ) : null}

              {view === "live" ? (
                <div className="flex flex-col gap-3">
                  <p className="rounded-xl bg-black/5 p-3 text-[13.5px] leading-relaxed">
                    {published ? (
                      <>
                        Tu vois ton site{" "}
                        <strong>tel que tes clientes le voient</strong> :
                        version {published.number}, publiée le{" "}
                        {new Date(published.publishedAt).toLocaleString(
                          "fr-FR",
                          {
                            day: "numeric",
                            month: "long",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                        , avec ton forfait actuel.
                        {changed
                          ? " Tes modifications en cours ne sont pas encore en ligne."
                          : ""}
                      </>
                    ) : (
                      "Ton site n’est pas encore publié : tes clientes voient ta page de réservation. Publie ton brouillon quand il te plaît."
                    )}
                  </p>
                  <SmallButton onClick={() => onView("draft")}>
                    Revenir au brouillon
                  </SmallButton>
                </div>
              ) : // A photo being edited wins over any tab (0 is a valid slot).
              photoSlot !== null ? (
                <PhotoEditor
                  slot={photoSlot}
                  id={slotPhoto(photoSlot)}
                  library={library}
                  onUpload={(file) =>
                    onUpload(file, photoSlot === "logo" ? "logo" : undefined)
                  }
                  onDelete={onDeletePhoto}
                  onRemove={() => removePhoto(photoSlot)}
                  focal={
                    config.content.focals[slotPhoto(photoSlot) ?? ""] ?? {
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
                            [slotPhoto(photoSlot) ?? ""]: focal,
                          },
                        },
                      },
                      `focal-${photoSlot}`,
                    )
                  }
                  onReplace={(id) => replacePhoto(photoSlot, id)}
                  onBack={() => onPhotoSlot(null)}
                >
                  {workInPhotoEditor?.photo ? (
                    <Text
                      label="Titre sous la photo"
                      value={workInPhotoEditor.title}
                      maxLength={siteLimits.workTitle}
                      onChange={(title) =>
                        setWorkTitle(workInPhotoEditor.id, title)
                      }
                    />
                  ) : null}
                </PhotoEditor>
              ) : current === "history" ? (
                history
              ) : current === "catalog" ? (
                <CatalogPanel catalog={catalog} onLeave={onLeave} />
              ) : (
                <div className="flex flex-col gap-4">
                  {!creative && dormant(config) ? (
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

                  {current === "reservation" ? (
                    <fieldset className="flex min-w-0 flex-col gap-2">
                      <legend className="mb-3 text-lg font-semibold">
                        Parcours de réservation
                      </legend>
                      {onPreviewBooking ? (
                        <button
                          type="button"
                          onClick={onPreviewBooking}
                          className="min-h-11 self-start rounded-full border border-black/25 px-4 text-sm font-semibold"
                        >
                          Essayer ce parcours
                        </button>
                      ) : null}
                      {bookingFormats.map((format) => (
                        <label
                          key={format}
                          className="flex cursor-pointer items-start gap-3 rounded-2xl border border-black/15 p-4 has-checked:border-black has-checked:bg-black/5"
                        >
                          <input
                            type="radio"
                            name="booking-format"
                            className="mt-1 accent-black"
                            checked={
                              (config.bookingFormat ?? "classic") === format
                            }
                            onChange={() => set({ bookingFormat: format })}
                          />
                          <span>
                            <strong className="block text-sm">
                              {bookingFormatCopy[format].name}
                            </strong>
                            <span className="mt-1 block text-sm leading-snug text-black/65">
                              {bookingFormatCopy[format].description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : current === "universe" ? (
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
                            src={photo(
                              universes[id].config.content.cover!,
                              480,
                            )}
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
                    <div className="flex flex-col gap-2">
                      {creative && (
                        <p className="text-[13.5px] text-black/60">
                          Les flèches changent l’ordre sur la page et dans le
                          sommaire.
                        </p>
                      )}
                      {sectionOrder.map((kind, index) => {
                        const arrows = (name: string) =>
                          creative && (
                            <div className="flex shrink-0 gap-1">
                              <IconButton
                                label={`Monter ${name}`}
                                onClick={() => moveSection(kind, -1)}
                                disabled={index === 0}
                              >
                                ↑
                              </IconButton>
                              <IconButton
                                label={`Descendre ${name}`}
                                onClick={() => moveSection(kind, 1)}
                                disabled={index === sectionOrder.length - 1}
                              >
                                ↓
                              </IconButton>
                            </div>
                          );
                        if (isInfoKey(kind)) {
                          const info = config.infoSections?.find(
                            (item) => infoKey(item.id) === kind,
                          );
                          if (!info) return null;
                          const name =
                            info.title.trim() || "Section sans titre";
                          return (
                            <div
                              key={kind}
                              className="rounded-2xl border border-black/10 bg-white p-3"
                            >
                              <div className="flex items-start justify-between gap-1">
                                <details
                                  className="min-w-0 flex-1"
                                  open={info.id === added || undefined}
                                >
                                  <summary className="min-h-11 cursor-pointer content-center py-2 text-[15px] font-semibold wrap-anywhere">
                                    {name}{" "}
                                    <span className="block text-[12.5px] font-normal text-black/55">
                                      Section d’information
                                    </span>
                                  </summary>
                                  <div className="mt-2 flex flex-col gap-3">
                                    <Text
                                      label="Titre"
                                      value={info.title}
                                      placeholder="Avant votre rendez-vous"
                                      maxLength={siteLimits.infoSectionTitle}
                                      onChange={(title) =>
                                        setInfoSection(
                                          info.id,
                                          { title },
                                          `info.${info.id}.title`,
                                        )
                                      }
                                    />
                                    <Text
                                      label="Texte"
                                      multiline
                                      rows={6}
                                      autoFocus={info.id === added}
                                      value={info.text}
                                      placeholder="Ce que tes clientes doivent savoir, avec tes mots. Tes retours à la ligne sont gardés."
                                      maxLength={siteLimits.infoSectionText}
                                      onChange={(text) =>
                                        setInfoSection(
                                          info.id,
                                          { text },
                                          `info.${info.id}.text`,
                                        )
                                      }
                                    />
                                    {!info.title.trim() || !info.text.trim() ? (
                                      <p className="text-[12.5px] text-black/55">
                                        Publiée sur ta page dès qu’elle a un
                                        titre et un texte.
                                      </p>
                                    ) : null}
                                    <button
                                      type="button"
                                      onClick={() => removeInfoSection(info.id)}
                                      // Its visible words first (WCAG 2.5.3), then which one.
                                      aria-label={`Retirer cette section : ${name}`}
                                      className="min-h-11 cursor-pointer self-start text-[13px] font-medium text-[#B3261E] underline underline-offset-4"
                                    >
                                      Retirer cette section
                                    </button>
                                  </div>
                                </details>
                                {arrows(name)}
                              </div>
                            </div>
                          );
                        }
                        const text = config.presentation?.labels?.[kind];
                        const switchable =
                          kind === "intro" ||
                          kind === "work" ||
                          kind === "portrait";
                        const name = sectionNames[kind];
                        return (
                          <div
                            key={kind}
                            className="rounded-2xl border border-black/10 bg-white p-3"
                          >
                            <div className="flex items-start justify-between gap-1">
                              <details className="min-w-0 flex-1">
                                <summary className="min-h-11 cursor-pointer content-center py-2 text-[15px] font-semibold">
                                  {name}
                                </summary>
                                <div className="mt-2 flex flex-col gap-3">
                                  <Text
                                    label="Titre sur la page"
                                    value={text?.title ?? ""}
                                    placeholder={
                                      kind === "opening"
                                        ? config.brand.name
                                        : "Titre de l’univers"
                                    }
                                    maxLength={siteLimits.sectionLabel}
                                    onChange={(title) =>
                                      setSectionText(
                                        kind,
                                        { title },
                                        kind + ".title",
                                      )
                                    }
                                  />
                                  <label className="flex min-h-11 items-center gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(text?.hideTitle)}
                                      onChange={(e) =>
                                        setSectionText(kind, {
                                          hideTitle: e.target.checked,
                                        })
                                      }
                                    />
                                    Masquer le titre sur la page
                                  </label>
                                  <Text
                                    label="Nom dans le sommaire"
                                    value={text?.menu ?? ""}
                                    placeholder={
                                      kind === "intro"
                                        ? "À propos"
                                        : kind === "opening"
                                          ? "Ajouter un lien vers l’ouverture"
                                          : kind === "reviews"
                                            ? "Avis"
                                            : name
                                    }
                                    maxLength={siteLimits.sectionLabel}
                                    onChange={(menu) =>
                                      setSectionText(
                                        kind,
                                        { menu },
                                        kind + ".menu",
                                      )
                                    }
                                  />
                                  {switchable && (
                                    <label className="flex min-h-11 items-center gap-2 text-sm">
                                      <input
                                        type="checkbox"
                                        role="switch"
                                        checked={!config.hidden?.includes(kind)}
                                        onChange={(e) =>
                                          set({
                                            hidden: e.target.checked
                                              ? (config.hidden ?? []).filter(
                                                  (item) => item !== kind,
                                                )
                                              : [
                                                  ...(config.hidden ?? []),
                                                  kind,
                                                ],
                                          })
                                        }
                                      />
                                      Afficher cette section
                                    </label>
                                  )}
                                </div>
                              </details>
                              {arrows(name)}
                            </div>
                          </div>
                        );
                      })}
                      {(config.infoSections?.length ?? 0) <
                      siteLimits.infoSections ? (
                        <div
                          role="group"
                          aria-labelledby="add-info-section"
                          className="mt-1 flex flex-col gap-2 rounded-2xl border border-dashed border-black/20 p-3"
                        >
                          <p
                            id="add-info-section"
                            className="text-[15px] font-semibold"
                          >
                            Ajouter une section d’information
                          </p>
                          <p className="text-[13px] text-black/60">
                            Un titre et ton texte, ajoutés après tes scènes
                            {creative
                              ? " ; les flèches la placent où tu veux."
                              : "."}{" "}
                            Choisis un titre ou écris le tien.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {INFO_IDEAS.map((idea) => (
                              <button
                                key={idea}
                                type="button"
                                onClick={() => addInfoSection(idea)}
                                className="min-h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[13px] font-medium hover:bg-black/10"
                              >
                                <span aria-hidden="true">+&nbsp;</span>
                                {idea}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => addInfoSection("")}
                              className="min-h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[13px] font-medium hover:bg-black/10"
                            >
                              <span aria-hidden="true">+&nbsp;</span>
                              Autre titre
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-[13px] text-black/55">
                          {siteLimits.infoSections} sections d’information au
                          plus : retire-en une pour en ajouter une autre.
                        </p>
                      )}
                    </div>
                  ) : current === "photos" ? (
                    <>
                      <p className="text-[13.5px] text-black/60">
                        Touche une photo, ici ou{" "}
                        <strong>directement dans l’aperçu</strong>, pour ajouter
                        la tienne, la recadrer ou modifier son titre dans les
                        réalisations. Les photos d’exemple de ton univers ne
                        sont jamais publiées.
                      </p>
                      <label className="flex flex-col gap-1.5 text-sm">
                        Présentation des réalisations
                        <select
                          className="min-h-12 rounded-xl border border-black/15 bg-white px-3"
                          value={config.presentation?.gallery ?? ""}
                          onChange={(e) =>
                            setPresentation({
                              gallery:
                                (e.target
                                  .value as SitePresentation["gallery"]) ||
                                undefined,
                            })
                          }
                        >
                          <option value="">
                            Suivre la composition du site
                          </option>
                          <option value="lookbook">
                            Lookbook · photos décalées en hauteur
                          </option>
                          <option value="arches">
                            Arches · défilement en profondeur
                          </option>
                          <option value="filmstrip">
                            Pellicule · défilement horizontal
                          </option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1.5 text-sm">
                        Animation de la galerie
                        <select
                          className="min-h-12 rounded-xl border border-black/15 bg-white px-3"
                          value={config.presentation?.galleryMotion ?? ""}
                          onChange={(e) =>
                            setPresentation({
                              galleryMotion:
                                (e.target
                                  .value as SitePresentation["galleryMotion"]) ||
                                undefined,
                            })
                          }
                        >
                          <option value="">Suivre le mouvement du site</option>
                          <option value="cut">Découpe · Mila</option>
                          <option value="settle">
                            Apparition douce · Alma
                          </option>
                          <option value="snap">Rebond · Nail Lab</option>
                        </select>
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {(
                          [
                            "logo",
                            "cover",
                            "portrait",
                            ...config.content.works.map((_, index) => index),
                          ] as PhotoSlot[]
                        ).map((slot) => {
                          const id = slotPhoto(slot);
                          const focal = (id && config.content.focals[id]) || {
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
                                {id ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={photo(id, 480)}
                                    alt=""
                                    className={`absolute inset-0 h-full w-full ${slot === "logo" ? "object-contain p-1" : "object-cover"}`}
                                    style={{
                                      objectPosition: `${focal.x}% ${focal.y}%`,
                                    }}
                                  />
                                ) : (
                                  <span
                                    aria-hidden="true"
                                    className="absolute inset-0 flex items-center justify-center text-[26px] text-black/35"
                                  >
                                    +
                                  </span>
                                )}
                              </span>
                              <span className="text-[12.5px] text-black/60">
                                {slot === "logo"
                                  ? "Logo"
                                  : slot === "cover"
                                    ? "Couverture"
                                    : slot === "portrait"
                                      ? "Ton portrait"
                                      : `Réalisation ${slot + 1}`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {config.content.works.length < 24 ? (
                        <SmallButton onClick={addWork}>
                          Ajouter une réalisation
                        </SmallButton>
                      ) : null}
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
                        label="Texte du bouton de réservation"
                        placeholder="Réserver"
                        value={config.presentation?.bookingLabel ?? ""}
                        maxLength={siteLimits.bookingLabel}
                        onChange={(bookingLabel) =>
                          setPresentation({ bookingLabel }, "bookingLabel")
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
                      {config.content.works.some((work) => work.photo) ? (
                        <fieldset className="mt-2 flex min-w-0 flex-col gap-3 border-t border-black/10 pt-3">
                          <legend className="pr-2 text-[13px] font-semibold">
                            Titres des réalisations
                          </legend>
                          {config.content.works.map((work, index) =>
                            work.photo ? (
                              <Text
                                key={work.id}
                                label={`Titre de la réalisation ${index + 1}`}
                                value={work.title}
                                maxLength={siteLimits.workTitle}
                                onChange={(title) =>
                                  setWorkTitle(work.id, title)
                                }
                              />
                            ) : null,
                          )}
                        </fieldset>
                      ) : null}
                    </>
                  ) : current === "infos" ? (
                    <>
                      <PracticalFields
                        value={config.practical ?? emptyPractical}
                        onChange={(practical, key) =>
                          set({ practical }, `practical.${key}`)
                        }
                      />
                      <LinksFields
                        value={config.links ?? []}
                        onChange={(links) => set({ links }, "links")}
                      />
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
                      {/* No billing yet: her plan is set with her, never here. */}
                      <p className="mt-2 rounded-xl bg-white/10 p-3 text-[13.5px] text-white/85">
                        Le mode Créatif s’ouvre avec le forfait Signature. Tes
                        réglages actuels seront conservés.
                      </p>
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
                                  {sectionNames[section.kind]}
                                  {config.hidden?.includes(section.kind) ? (
                                    <span className="ml-1.5 font-normal text-black/60">
                                      · masquée
                                    </span>
                                  ) : null}
                                </span>
                                <SmallButton onClick={() => setTab("sections")}>
                                  Ordre et titres
                                </SmallButton>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {variants[section.kind].map((variant) => (
                                  <Chip
                                    key={variant.id}
                                    selected={
                                      (section.kind === "work"
                                        ? (config.presentation?.gallery ??
                                          section.variant)
                                        : section.variant) === variant.id
                                    }
                                    onClick={() => {
                                      if (section.kind === "work") {
                                        setPresentation({
                                          gallery:
                                            variant.id as SitePresentation["gallery"],
                                        });
                                        return;
                                      }
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
                          bookingFormat: config.bookingFormat,
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
/**
 * Her catalogue, as her clients see it on her site: business data, shared
 * by every universe and plan, changed in Prestations and published there
 * at once (never with her design).
 */
function CatalogPanel({
  catalog,
  onLeave,
}: {
  catalog: ShowcaseGroup[];
  onLeave: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const count = catalog.reduce((sum, group) => sum + group.services.length, 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13.5px] text-black/60">
        Tes prestations, comme tes clientes les voient. Elles sont les mêmes
        dans tous les univers et se modifient dans Prestations : un changement y
        est en ligne tout de suite, sans publier ton site.
      </p>
      {count === 0 ? (
        <p className="rounded-xl bg-black/5 p-3 text-[13.5px]">
          Aucune prestation réservable en ligne pour l’instant : ton site dira «
          Bientôt » à leur place.
        </p>
      ) : (
        catalog.map((group) => (
          <div key={group.category?.id ?? "none"} className="flex flex-col">
            {group.category ? (
              <p className="pb-1 text-[12.5px] font-semibold tracking-wide text-black/55 uppercase">
                {group.category.name}
              </p>
            ) : null}
            <ul className="divide-y divide-black/10 rounded-2xl bg-white">
              {group.services.map((service) => {
                // As her site and her booking page say it.
                const from = startingAt(service);
                return (
                  <li
                    key={service.id}
                    className="flex items-baseline justify-between gap-3 px-3 py-2.5"
                  >
                    <span className="min-w-0 text-[14px] font-medium wrap-anywhere">
                      {service.name}
                      {service.options.length ? (
                        <span className="block text-[12.5px] font-normal text-black/55">
                          Options :{" "}
                          {service.options
                            .map((option) => option.question)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[13px] text-black/60 tabular-nums">
                      {from.durationVaries ? "dès " : ""}
                      {minutes(from.durationMinutes)} ·{" "}
                      {from.priceVaries ? "dès " : ""}
                      {euros(from.priceCents, service.currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      <Link
        href="/app/services"
        onClick={onLeave}
        className="flex h-11 items-center justify-center rounded-full bg-[#141414] px-4 text-[14px] font-semibold text-white"
      >
        Modifier mes prestations
      </Link>
    </div>
  );
}

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

/**
 * Her "Infos pratiques" (Higani point 5): what her clients read before
 * booking or coming. Every field is optional; her hours come from her
 * schedule, her phone and e-mail only from what she types here.
 */
function PracticalFields({
  value,
  onChange,
}: {
  value: Practical;
  onChange: (value: Practical, key: keyof Practical) => void;
}) {
  const field = (key: Exclude<keyof Practical, "showHours">) => ({
    value: value[key] ?? "",
    onChange: (text: string) => onChange({ ...value, [key]: text }, key),
  });
  return (
    <>
      <p className="text-[13.5px] text-black/60">
        Ce que tes clientes doivent savoir avant de réserver ou de venir. Tout
        est facultatif : un champ vide n’apparaît pas sur ton site.
      </p>
      <Text
        label="Adresse"
        maxLength={siteLimits.practicalAddress}
        {...field("address")}
      />
      <Text
        label="Zone d’intervention (si tu te déplaces)"
        maxLength={siteLimits.practicalArea}
        {...field("area")}
      />
      <button
        type="button"
        role="switch"
        aria-checked={value.showHours}
        onClick={() =>
          onChange({ ...value, showHours: !value.showHours }, "showHours")
        }
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium">
            Afficher mes horaires habituels
          </span>
          <span className="block text-[12.5px] leading-snug text-black/55">
            Lus depuis ton planning : ils restent d’accord avec tes créneaux.
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${value.showHours ? "bg-[#2B3BFF]" : "bg-black/20"}`}
        >
          <span
            className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform ${value.showHours ? "translate-x-[22px]" : "translate-x-0.5"}`}
          />
        </span>
      </button>
      <Text
        label="Accès (code, étage, transports, stationnement)"
        multiline
        maxLength={siteLimits.practicalAccess}
        {...field("access")}
      />
      <Text
        label="Avant de venir (consignes)"
        multiline
        maxLength={siteLimits.practicalInstructions}
        {...field("instructions")}
      />
      <Text
        label="Paiements acceptés"
        maxLength={siteLimits.practicalPayment}
        {...field("payment")}
      />
      <Text
        label="Accessibilité"
        multiline
        maxLength={siteLimits.practicalAccessibility}
        {...field("accessibility")}
      />
      <p className="mt-2 border-t border-black/10 pt-4 text-[13px] font-semibold">
        Conditions
      </p>
      <p className="text-[12.5px] leading-snug text-black/55">
        Lues par tes clientes avant de confirmer. Tes conditions d’annulation,
        saisies à ton inscription, s’affichent aussi.
      </p>
      <Text
        label="Retard"
        multiline
        maxLength={siteLimits.practicalLateness}
        placeholder="Ex. : au-delà de 15 minutes, la prestation peut être écourtée."
        {...field("lateness")}
      />
      <Text
        label="Rendez-vous manqué"
        multiline
        maxLength={siteLimits.practicalNoShow}
        placeholder="Ex. : prévenez-moi au plus tôt si vous ne pouvez pas venir."
        {...field("noShow")}
      />
      <Text
        label="Accompagnants (enfants, proches)"
        multiline
        maxLength={siteLimits.practicalCompanions}
        {...field("companions")}
      />
      <p className="mt-2 border-t border-black/10 pt-4 text-[13px] font-semibold">
        Contact
      </p>
      <p className="text-[12.5px] leading-snug text-black/55">
        Ton téléphone et ton e-mail n’apparaissent sur ton site que si tu les
        écris ici.
      </p>
      <Text
        label="Téléphone"
        type="tel"
        maxLength={siteLimits.practicalPhone}
        {...field("phone")}
      />
      <Text
        label="WhatsApp (avec l’indicatif, ex. +33 6 12 34 56 78)"
        type="tel"
        maxLength={siteLimits.practicalWhatsapp}
        hint={
          value.whatsapp?.trim() && !whatsappHref(value.whatsapp)
            ? "Ajoute l’indicatif du pays (+33…) : sans lui, le lien WhatsApp n’apparaît pas."
            : undefined
        }
        {...field("whatsapp")}
      />
      <Text
        label="E-mail"
        type="email"
        maxLength={siteLimits.practicalEmail}
        {...field("email")}
      />
    </>
  );
}

function Text({
  label,
  value,
  onChange,
  multiline,
  maxLength,
  type = "text",
  placeholder,
  hint,
  rows = 3,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  /** Ready to type in, right after she asked for it (a new section). */
  autoFocus?: boolean;
  maxLength?: number;
  type?: "text" | "tel" | "email";
  placeholder?: string;
  /** Said under the field (why what she typed will not show). */
  hint?: string;
}) {
  const hintId = useId();
  const className =
    "w-full rounded-xl border border-black/10 bg-white px-3 text-[16px] outline-none focus:border-black/40";
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-black/55">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          rows={rows}
          autoFocus={autoFocus}
          className={`${className} resize-none py-2.5`}
        />
      ) : (
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          maxLength={maxLength}
          aria-describedby={hint ? hintId : undefined}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          className={`${className} h-12`}
        />
      )}
      {hint ? (
        <span id={hintId} className="text-[12.5px] leading-snug text-[#B3261E]">
          {hint}
        </span>
      ) : null}
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
    <div role="group" aria-label={label}>
      <p className="text-[13px] text-black/55" aria-hidden="true">
        {label}
      </p>
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

/** Her site online: open it as her clients do, or copy its link. */
function LiveLink({ path }: { path: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 2500);
  }

  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px]">
      <a
        href={path}
        target="_blank"
        rel="noopener"
        className="flex h-9 min-w-0 items-center gap-1.5 rounded-full px-2 font-semibold text-[#2B3BFF] underline-offset-4 hover:underline"
      >
        <span className="truncate">Voir mon site en ligne</span>
        <span aria-hidden="true">↗</span>
        <span className="sr-only"> (nouvel onglet)</span>
      </a>
      <button
        type="button"
        onClick={copy}
        className="h-9 shrink-0 cursor-pointer rounded-full bg-black/5 px-3 font-medium hover:bg-black/10"
      >
        Copier le lien
      </button>
      <span role="status" className="min-w-0 truncate text-black/55">
        {copied === "yes"
          ? "Copié"
          : copied === "failed"
            ? `Copie refusée : ${path}`
            : ""}
      </span>
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

/** `config` with photo `id` in `slot`; everything else as it is. */
export function withPhoto(
  config: SiteConfig,
  slot: PhotoSlot,
  id: string,
): SiteConfig {
  const content =
    slot === "logo"
      ? { ...config.content, logo: id }
      : slot === "cover"
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
  return { ...config, content };
}
