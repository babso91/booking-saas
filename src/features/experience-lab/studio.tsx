"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import type {
  GradeId,
  MotionId,
  Palette,
  Section,
  ShapeId,
  SiteConfig,
  TypePairId,
} from "./engine/config";
import { advise } from "./engine/harmony";
import {
  grades,
  motions,
  paletteKeys,
  shapes,
  typePairs,
} from "./engine/tokens";
import { photo, photoPool } from "./photos";
import { can, plans, toCore, type Capability, type Plan } from "./plans";
import type { Universe } from "./universes";

// The creation studio: the professional's controls over the same config
// the site renders, with a live preview. Our own quiet product UI, clearly
// an editor (never mistaken for her public site). Phone first: a bottom
// sheet with tabs and 44 px targets, the preview staying visible above;
// a side panel on larger screens. Core and Signature share it; Signature
// unlocks composition and style. Guardrails advise, never lock.

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
  services: "Prestations",
};

const tabs = [
  { id: "identity", label: "Identité" },
  { id: "photos", label: "Photos" },
  { id: "colors", label: "Couleurs" },
  { id: "composition", label: "Composition" },
  { id: "style", label: "Style" },
] as const;
type Tab = (typeof tabs)[number]["id"];

type Slot = "cover" | number;

export function Studio({
  universe,
  config,
  plan,
  onPlan,
  onChange,
  onReplay,
}: {
  universe: Universe;
  config: SiteConfig;
  plan: Plan;
  onPlan: (plan: Plan) => void;
  onChange: (config: SiteConfig) => void;
  onReplay: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("identity");
  const [slot, setSlot] = useState<Slot>("cover");
  const allowed = (capability: Capability) => can(plan, capability);
  const set = (patch: Partial<SiteConfig>) => onChange({ ...config, ...patch });
  const setTokens = (patch: Partial<SiteConfig["tokens"]>) =>
    set({ tokens: { ...config.tokens, ...patch } });
  const setPalette = (patch: Partial<Palette>) =>
    setTokens({ palette: { ...config.tokens.palette, ...patch } });
  const advice = advise(config);
  const problems = advice.filter((item) => item.level === "problem").length;

  function switchPlan(next: Plan) {
    if (next === plan) return;
    if (next === "core") {
      // Core keeps her content and a designed palette (with her accent).
      const preset = universe.palettes.find((item) =>
        paletteKeys.every(
          ({ key }) =>
            key === "accent" ||
            item.palette[key] === config.tokens.palette[key],
        ),
      );
      const restored = toCore(config, universe.config);
      onChange({
        ...restored,
        tokens: {
          ...restored.tokens,
          palette: {
            ...(preset?.palette ?? universe.config.tokens.palette),
            accent: config.tokens.palette.accent,
          },
        },
      });
    }
    onPlan(next);
  }

  function moveSection(index: number, by: -1 | 1) {
    const sections = [...config.sections];
    const target = index + by;
    if (target < 1 || target >= sections.length) return; // the opening stays first
    [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    set({ sections });
  }

  function setVariant(index: number, variant: string) {
    set({
      sections: config.sections.map((section, position) =>
        position === index ? ({ ...section, variant } as Section) : section,
      ),
    });
  }

  function assignPhoto(id: string) {
    if (slot === "cover") {
      set({ content: { ...config.content, cover: id } });
      return;
    }
    set({
      content: {
        ...config.content,
        works: config.content.works.map((work, position) =>
          position === slot ? { ...work, photo: id } : work,
        ),
      },
    });
  }

  return (
    <div
      style={{ fontFamily: "var(--font-lab-sans)" }}
      className="text-[#141414]"
    >
      {open ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
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
            className="fixed inset-x-0 bottom-0 z-[70] flex h-[62dvh] flex-col rounded-t-[22px] bg-[#FAFAF8] shadow-[0_-30px_80px_-30px_rgba(0,0,0,.55)] md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-[400px] md:rounded-none md:shadow-[-30px_0_80px_-30px_rgba(0,0,0,.45)]"
          >
            {/* Editor chrome: unmistakably the professional's tool. */}
            <div className="shrink-0 border-b border-black/10">
              <span
                className="mx-auto mt-2 block h-1.5 w-10 rounded-full bg-black/15 md:hidden"
                aria-hidden="true"
              />
              <div className="flex items-center justify-between gap-3 px-4 pt-2 pb-2 md:pt-[max(env(safe-area-inset-top),14px)]">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold">
                    Studio · mode édition
                  </p>
                  <p className="truncate text-[12px] text-black/55">
                    Tes clientes ne voient jamais ce panneau
                  </p>
                </div>
                <div
                  className="flex shrink-0 rounded-full bg-black/5 p-1"
                  role="group"
                  aria-label="Forfait"
                >
                  {(["core", "signature"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={plan === item}
                      onClick={() => switchPlan(item)}
                      className={`h-9 cursor-pointer rounded-full px-3 text-[13px] font-semibold ${plan === item ? "bg-white shadow-sm" : "text-black/55"}`}
                    >
                      {plans[item].name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Fermer le studio"
                  className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[18px] hover:bg-black/5"
                >
                  ✕
                </button>
              </div>
              <nav
                className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
                aria-label="Réglages"
              >
                {tabs.map((item) => {
                  const locked =
                    (item.id === "composition" && !allowed("composition")) ||
                    (item.id === "style" && !allowed("style"));
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={tab === item.id}
                      onClick={() => setTab(item.id)}
                      className={`flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[14px] font-medium ${tab === item.id ? "bg-[#141414] text-white" : "text-black/70"}`}
                    >
                      {item.label}
                      {locked ? <span aria-label="Signature">🔒</span> : null}
                      {item.id === "colors" && problems ? (
                        <span
                          className="size-2 rounded-full bg-[#D92D20]"
                          aria-label="À vérifier"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pt-4 pb-10">
              <p className="text-[13px] leading-relaxed text-black/60">
                {plans[plan].promise}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <SmallButton onClick={onReplay}>
                  Rejouer l’ouverture
                </SmallButton>
                <SmallButton
                  onClick={() => {
                    onChange(universe.config);
                    onPlan("core");
                  }}
                >
                  Univers d’origine
                </SmallButton>
                {universe.signature ? (
                  <SmallButton
                    accent
                    onClick={() => {
                      onPlan("signature");
                      onChange(universe.signature!.apply(config));
                      onReplay();
                    }}
                  >
                    Exemple Signature
                  </SmallButton>
                ) : null}
              </div>

              {advice.length ? (
                <ul className="mt-4 flex flex-col gap-2" aria-label="Conseils">
                  {advice.map((item) => (
                    <li
                      key={item.id}
                      className={`flex items-start gap-3 rounded-xl p-3 text-[13px] leading-snug ${item.level === "problem" ? "bg-[#FDECEA] text-[#7A1F17]" : "bg-[#EEF0FF] text-[#1F2A7A]"}`}
                    >
                      <span className="flex-1">{item.text}</span>
                      {item.fix ? (
                        <button
                          type="button"
                          onClick={() => onChange(item.fix!(config))}
                          className="h-9 shrink-0 cursor-pointer rounded-full bg-white px-3 text-[12.5px] font-semibold"
                        >
                          Appliquer
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-5 flex flex-col gap-4">
                {tab === "identity" ? (
                  <>
                    <Text
                      label="Nom"
                      value={config.brand.name}
                      onChange={(name) =>
                        set({ brand: { ...config.brand, name } })
                      }
                    />
                    <Text
                      label="Activité"
                      value={config.brand.kind}
                      onChange={(kind) =>
                        set({ brand: { ...config.brand, kind } })
                      }
                    />
                    <Text
                      label="Ville"
                      value={config.brand.location}
                      onChange={(location) =>
                        set({ brand: { ...config.brand, location } })
                      }
                    />
                    <Text
                      label="Présentation"
                      multiline
                      value={config.brand.intro}
                      onChange={(intro) =>
                        set({ brand: { ...config.brand, intro } })
                      }
                    />
                  </>
                ) : tab === "photos" ? (
                  <>
                    <p className="text-[12.5px] text-black/55">
                      Dans le produit, ce sont tes propres photos.
                    </p>
                    <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
                      {(
                        [
                          "cover",
                          ...config.content.works.map((_, index) => index),
                        ] as Slot[]
                      ).map((item) => (
                        <button
                          key={String(item)}
                          type="button"
                          aria-pressed={slot === item}
                          onClick={() => setSlot(item)}
                          className={`h-11 shrink-0 cursor-pointer rounded-full px-4 text-[13.5px] font-medium ${slot === item ? "bg-[#141414] text-white" : "bg-black/5"}`}
                        >
                          {item === "cover"
                            ? "Couverture"
                            : `Réalisation ${item + 1}`}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {photoPool.map((id) => {
                        const current =
                          slot === "cover"
                            ? config.content.cover
                            : config.content.works[slot]?.photo;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => assignPhoto(id)}
                            aria-label="Utiliser cette photo"
                            aria-pressed={current === id}
                            className={`relative aspect-square cursor-pointer overflow-hidden rounded-lg ${current === id ? "ring-3 ring-[#2B3BFF] ring-offset-2" : ""}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={photo(id, 200)}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : tab === "colors" ? (
                  <>
                    <p className="text-[12.5px] text-black/55">
                      Palettes conçues pour {config.brand.name.split(" ")[0]}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {universe.palettes.map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          onClick={() =>
                            setTokens({ palette: { ...item.palette } })
                          }
                          className="flex h-11 cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-white pr-4 pl-1.5 text-[13.5px] font-medium"
                        >
                          <span className="flex -space-x-1" aria-hidden="true">
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
                      label="Accent"
                      value={config.tokens.palette.accent}
                      onChange={(accent) => setPalette({ accent })}
                    />
                    <Locked
                      locked={!allowed("palette-free")}
                      what="Palette complète"
                    >
                      {paletteKeys
                        .filter(({ key }) => key !== "accent")
                        .map(({ key, label }) => (
                          <ColorRow
                            key={key}
                            label={label}
                            value={config.tokens.palette[key]}
                            onChange={(value) => setPalette({ [key]: value })}
                          />
                        ))}
                    </Locked>
                  </>
                ) : tab === "composition" ? (
                  <Locked
                    locked={!allowed("composition")}
                    what="Scènes, variantes et ordre"
                  >
                    <ol className="flex flex-col gap-2">
                      {config.sections.map((section, index) => (
                        <li
                          key={`${section.kind}-${index}`}
                          className="rounded-2xl border border-black/10 bg-white p-3"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[14px] font-semibold">
                              {sceneNames[section.kind]}
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
                                  disabled={index >= config.sections.length - 1}
                                >
                                  ↓
                                </IconButton>
                              </span>
                            ) : (
                              <span className="text-[12px] text-black/45">
                                toujours en premier
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {variants[section.kind].map((variant) => (
                              <Chip
                                key={variant.id}
                                selected={section.variant === variant.id}
                                onClick={() => setVariant(index, variant.id)}
                              >
                                {variant.label}
                              </Chip>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </Locked>
                ) : (
                  <Locked
                    locked={!allowed("style")}
                    what="Typographie, photo, mouvement et formes"
                  >
                    <Choice<TypePairId>
                      label="Typographie"
                      value={config.tokens.type}
                      options={Object.entries(typePairs).map(([id, item]) => ({
                        id: id as TypePairId,
                        label: item.label,
                      }))}
                      onChange={(type) => setTokens({ type })}
                    />
                    <Choice<GradeId>
                      label="Traitement photo"
                      value={config.tokens.grade}
                      options={Object.entries(grades).map(([id, item]) => ({
                        id: id as GradeId,
                        label: item.label,
                      }))}
                      onChange={(grade) => setTokens({ grade })}
                    />
                    <Choice<MotionId>
                      label="Mouvement"
                      value={config.tokens.motion}
                      options={Object.entries(motions).map(([id, item]) => ({
                        id: id as MotionId,
                        label: item.label,
                      }))}
                      onChange={(motion) => {
                        setTokens({ motion });
                        onReplay();
                      }}
                    />
                    <Choice<ShapeId>
                      label="Formes"
                      value={config.tokens.shape}
                      options={Object.entries(shapes).map(([id, item]) => ({
                        id: id as ShapeId,
                        label: item.label,
                      }))}
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
                  </Locked>
                )}
              </div>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Locked({
  locked,
  what,
  children,
}: {
  locked: boolean;
  what: string;
  children: ReactNode;
}) {
  if (!locked) return <div className="flex flex-col gap-4">{children}</div>;
  return (
    <div className="relative">
      <div
        className="pointer-events-none flex flex-col gap-4 opacity-35 select-none"
        aria-hidden="true"
        inert
      >
        {children}
      </div>
      <div className="absolute inset-x-0 top-3 flex justify-center">
        <span className="rounded-full bg-[#141414] px-3 py-2 text-[12.5px] font-medium text-white">
          🔒 {what} · Signature
        </span>
      </div>
    </div>
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
        <span className="font-mono text-[12px] text-black/50 uppercase">
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
  accent,
}: {
  onClick: () => void;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 cursor-pointer rounded-full px-4 text-[13px] font-medium ${accent ? "bg-[#2B3BFF] text-white" : "bg-black/5 hover:bg-black/10"}`}
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
      onClick={onClick}
      disabled={disabled}
      className="flex size-11 cursor-pointer items-center justify-center rounded-xl bg-black/5 text-[16px] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
