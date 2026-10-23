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
// the site renders, with a live preview. Our own quiet product UI, never
// competing with her site. Core and Signature share it; Signature unlocks
// composition and style.

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
  const [slot, setSlot] = useState<Slot>("cover");
  const allowed = (capability: Capability) => can(plan, capability);
  const set = (patch: Partial<SiteConfig>) => onChange({ ...config, ...patch });
  const setTokens = (patch: Partial<SiteConfig["tokens"]>) =>
    set({ tokens: { ...config.tokens, ...patch } });
  const setPalette = (patch: Partial<Palette>) =>
    setTokens({ palette: { ...config.tokens.palette, ...patch } });

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed top-16 right-4 z-[60] flex h-11 cursor-pointer items-center gap-2 rounded-full bg-white px-4 text-[14px] font-semibold shadow-[0_10px_30px_-10px_rgba(0,0,0,.5)]"
      >
        <span className="size-2 rounded-full bg-[#2B3BFF]" aria-hidden="true" />
        Studio
      </button>

      <AnimatePresence>
        {open ? (
          <motion.aside
            key="studio"
            role="dialog"
            aria-label="Studio de création"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-y-0 right-0 z-[70] flex w-[min(400px,92vw)] flex-col bg-[#FAFAF8] shadow-[-30px_0_80px_-30px_rgba(0,0,0,.45)]"
          >
            <div className="flex items-center justify-between border-b border-black/10 px-5 pt-[max(env(safe-area-inset-top),14px)] pb-3">
              <div>
                <p className="text-[16px] font-semibold tracking-[-0.01em]">
                  Studio
                </p>
                <p className="text-[12.5px] text-black/55">
                  Aperçu en direct · laboratoire
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="cursor-pointer rounded-full px-3 py-2 text-[14px] hover:bg-black/5"
              >
                Fermer
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-10">
              <div
                className="mt-4 grid grid-cols-2 rounded-xl bg-black/5 p-1"
                role="group"
                aria-label="Forfait"
              >
                {(["core", "signature"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={plan === item}
                    onClick={() => switchPlan(item)}
                    className={`h-10 cursor-pointer rounded-lg text-[14px] font-semibold ${plan === item ? "bg-white shadow-sm" : "text-black/55"}`}
                  >
                    {plans[item].name}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-black/60">
                {plans[plan].promise}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
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
                    Exemple Signature : {universe.signature.name}
                  </SmallButton>
                ) : null}
              </div>

              <Group title="Identité">
                <Text
                  label="Nom"
                  value={config.brand.name}
                  onChange={(name) => set({ brand: { ...config.brand, name } })}
                />
                <Text
                  label="Activité"
                  value={config.brand.kind}
                  onChange={(kind) => set({ brand: { ...config.brand, kind } })}
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
              </Group>

              <Group
                title="Photos"
                hint="Dans le produit, ce sont tes propres photos."
              >
                <div className="flex flex-wrap gap-1.5">
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
                      className={`h-8 cursor-pointer rounded-full px-3 text-[12.5px] font-medium ${slot === item ? "bg-black text-white" : "bg-black/5"}`}
                    >
                      {item === "cover"
                        ? "Couverture"
                        : `Réalisation ${item + 1}`}
                    </button>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-6 gap-1.5">
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
                        className={`relative aspect-square cursor-pointer overflow-hidden rounded-md ${current === id ? "ring-2 ring-[#2B3BFF] ring-offset-1" : ""}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photo(id, 160)}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      </button>
                    );
                  })}
                </div>
              </Group>

              <Group title="Couleurs">
                <div className="flex flex-wrap gap-2">
                  {universe.palettes.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() =>
                        setTokens({ palette: { ...item.palette } })
                      }
                      className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-white pr-3 pl-1.5 text-[13px] font-medium"
                    >
                      <span className="flex -space-x-1" aria-hidden="true">
                        {[
                          item.palette.bg,
                          item.palette.paper,
                          item.palette.accent,
                        ].map((color, index) => (
                          <span
                            key={index}
                            className="size-6 rounded-full border border-white"
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
              </Group>

              <Group title="Composition">
                <Locked
                  locked={!allowed("composition")}
                  what="Scènes, variantes et ordre"
                >
                  <ol className="flex flex-col gap-2">
                    {config.sections.map((section, index) => (
                      <li
                        key={`${section.kind}-${index}`}
                        className="rounded-xl border border-black/10 bg-white p-3"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] font-semibold">
                            {sceneNames[section.kind]}
                          </span>
                          {index > 0 ? (
                            <span className="flex gap-1">
                              <IconButton
                                label="Monter"
                                onClick={() => moveSection(index, -1)}
                                disabled={index <= 1}
                              >
                                ↑
                              </IconButton>
                              <IconButton
                                label="Descendre"
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
                            <button
                              key={variant.id}
                              type="button"
                              aria-pressed={section.variant === variant.id}
                              onClick={() => setVariant(index, variant.id)}
                              className={`h-8 cursor-pointer rounded-full px-3 text-[12.5px] font-medium ${section.variant === variant.id ? "bg-black text-white" : "bg-black/5"}`}
                            >
                              {variant.label}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ol>
                </Locked>
              </Group>

              <Group title="Style">
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
              </Group>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-7">
      <h3 className="text-[12px] font-semibold tracking-[0.08em] text-black/50 uppercase">
        {title}
      </h3>
      {hint ? <p className="mt-1 text-[12.5px] text-black/50">{hint}</p> : null}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
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
  if (!locked) return <div className="flex flex-col gap-3">{children}</div>;
  return (
    <div className="relative">
      <div
        className="pointer-events-none flex flex-col gap-3 opacity-35 select-none"
        aria-hidden="true"
        inert
      >
        {children}
      </div>
      <div className="absolute inset-0 flex items-start justify-center pt-4">
        <span className="rounded-full bg-black px-3 py-1.5 text-[12.5px] font-medium text-white">
          {what} · Signature
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
    "w-full rounded-lg border border-black/10 bg-white px-3 text-[14px] outline-none focus:border-black/40";
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12.5px] text-black/55">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          className={`${className} resize-none py-2`}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${className} h-10`}
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
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px]">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-black/50 uppercase">
          {value}
        </span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="size-8 cursor-pointer rounded border border-black/10 bg-transparent p-0"
        />
      </span>
    </label>
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
      <p className="text-[12.5px] text-black/55">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={`h-8 cursor-pointer rounded-full px-3 text-[12.5px] font-medium ${value === option.id ? "bg-black text-white" : "bg-black/5"}`}
          >
            {option.label}
          </button>
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
      className={`h-9 cursor-pointer rounded-full px-3 text-[12.5px] font-medium ${accent ? "bg-[#2B3BFF] text-white" : "bg-black/5 hover:bg-black/10"}`}
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
      className="flex size-8 cursor-pointer items-center justify-center rounded-lg bg-black/5 text-[14px] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
