"use client";

import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CalendarIcon, PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/features/agenda/components/status-badge";
import { isHexColor } from "@/lib/color/contrast";
import { cn } from "@/lib/cn";

import {
  accentKeptAsIs,
  defaultAccent,
  defaultAppearance,
  type Appearance,
  type ModePreference,
  type MotionPreference,
} from "../appearance";
import {
  accentPresets,
  ambiances,
  signaturePresets,
  STUDIO_SIGNATURE,
  styles,
  studioPalettes,
  type AmbianceId,
  type StyleId,
} from "../palettes";
import { useAppearance } from "./appearance-provider";

// "Apparence": her area, her way. Every choice applies at once to the whole
// area (the preview below is made of the real components), and is kept on
// this device. Readability is not hers to lose: an accent that would not
// read is adjusted, and the panel says so.

export function AppearanceSettings() {
  const { appearance, setAppearance } = useAppearance();
  const set = (patch: Partial<Appearance>) =>
    setAppearance({ ...appearance, ...patch });
  const adjusted =
    appearance.accent !== null &&
    (["light", "dark"] as const)
      .filter(
        (mode) => appearance.mode === "system" || appearance.mode === mode,
      )
      .some(
        (mode) =>
          !accentKeptAsIs(
            appearance.style,
            appearance.ambiance,
            mode,
            appearance.accent!,
          ),
      );
  const studio = appearance.style === "studio";
  const presets = studio ? signaturePresets : accentPresets;
  const own = defaultAccent(appearance.style, appearance.ambiance);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[42px]">
            Apparence
          </h1>
          <p className="max-w-2xl text-[14.5px] leading-relaxed text-ink-soft">
            Rends cet espace le tien. Tes choix s’appliquent tout de suite et
            restent sur cet appareil ; ils te suivront bientôt sur tous tes
            appareils.
          </p>
        </header>

        <Group
          legend="Style"
          description="La mise en scène de tout ton espace. Les rubriques et les mots restent les mêmes."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(Object.keys(styles) as StyleId[]).map((id) => (
              <Choice
                key={id}
                name="style"
                checked={appearance.style === id}
                onSelect={() =>
                  // Her accent was picked for a style; the new one starts
                  // from its own colour.
                  set({ style: id, accent: null })
                }
              >
                <StyleSwatch id={id} />
                <span className="mt-3 block text-[15px] font-semibold text-ink">
                  {styles[id].name}
                </span>
                <span className="block text-[13px] leading-snug text-ink-soft">
                  {styles[id].line}
                </span>
              </Choice>
            ))}
          </div>
        </Group>

        {studio ? null : (
          <Group legend="Ambiance">
            <div className="grid gap-3 sm:grid-cols-3">
              {(Object.keys(ambiances) as AmbianceId[]).map((id) => (
                <Choice
                  key={id}
                  name="ambiance"
                  checked={appearance.ambiance === id}
                  onSelect={() => set({ ambiance: id })}
                >
                  <AmbianceSwatch id={id} />
                  <span className="mt-3 block text-[15px] font-semibold text-ink">
                    {ambiances[id].name}
                  </span>
                  <span className="block text-[13px] leading-snug text-ink-soft">
                    {ambiances[id].mood}
                  </span>
                </Choice>
              ))}
            </div>
          </Group>
        )}

        <Group legend="Clair ou sombre">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["light", "Clair"],
                ["dark", "Sombre"],
                ["system", "Comme l’appareil"],
              ] as [ModePreference, string][]
            ).map(([mode, label]) => (
              <Choice
                key={mode}
                name="mode"
                compact
                checked={appearance.mode === mode}
                onSelect={() => set({ mode })}
              >
                <span className="text-[14px] font-medium text-ink">
                  {label}
                </span>
              </Choice>
            ))}
          </div>
        </Group>

        <Group
          legend={studio ? "Ta couleur signature" : "Couleur d’accent"}
          description={
            studio
              ? "Elle remplit le bloc « maintenant », marque l’heure et tes repères."
              : "Elle souligne les liens, les repères et l’heure actuelle dans ton agenda."
          }
        >
          <div className="flex flex-wrap gap-2">
            <Choice
              name="accent"
              compact
              checked={appearance.accent === null}
              onSelect={() => set({ accent: null })}
            >
              <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <span
                  aria-hidden="true"
                  className="size-4 rounded-full border border-line-strong"
                  style={{
                    background: own,
                  }}
                />
                {studio ? "Cobalt, celle du Studio" : "Celle de l’ambiance"}
              </span>
            </Choice>
            {presets
              .filter((preset) => !studio || preset.color !== STUDIO_SIGNATURE)
              .map((preset) => (
                <Choice
                  key={preset.color}
                  name="accent"
                  compact
                  checked={appearance.accent === preset.color}
                  onSelect={() => set({ accent: preset.color })}
                >
                  <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <span
                      aria-hidden="true"
                      className="size-4 rounded-full"
                      style={{ background: preset.color }}
                    />
                    {preset.name}
                  </span>
                </Choice>
              ))}
          </div>
          <label className="mt-3 flex min-h-12 w-fit cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper-raised px-3 text-[14px] font-medium text-ink">
            <input
              type="color"
              value={appearance.accent ?? own}
              onChange={(event) => {
                const value = event.target.value.toUpperCase();
                if (isHexColor(value)) set({ accent: value });
              }}
              className="size-9 cursor-pointer rounded-lg border border-line bg-transparent p-0.5"
            />
            Une autre couleur
          </label>
          {adjusted ? (
            <p className="mt-2 text-[13px] text-ink-soft">
              {studio
                ? "Tes grands aplats gardent ta couleur ; dans le texte, elle est un peu plus soutenue pour rester lisible."
                : "Ajustée pour rester lisible sur ton fond : la teinte est gardée, un peu plus soutenue."}
            </p>
          ) : null}
        </Group>

        <Group
          legend="Animations"
          description="Si ton appareil demande moins d’animations, c’est toujours respecté."
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["standard", "Standard", "Des transitions douces et courtes."],
                [
                  "discrete",
                  "Discrètes",
                  "L’essentiel, sans effets d’ambiance.",
                ],
                ["none", "Aucune", "Tout s’affiche immédiatement."],
              ] as [MotionPreference, string, string][]
            ).map(([motion, label, hint]) => (
              <Choice
                key={motion}
                name="motion"
                checked={appearance.motion === motion}
                onSelect={() => set({ motion })}
              >
                <span className="block text-[15px] font-semibold text-ink">
                  {label}
                </span>
                <span className="block text-[13px] leading-snug text-ink-soft">
                  {hint}
                </span>
              </Choice>
            ))}
          </div>
        </Group>

        <section aria-label="Aperçu" className="flex flex-col gap-3">
          <h2 className="font-display text-[22px] leading-tight text-ink">
            Aperçu
          </h2>
          <Preview />
        </section>

        <div>
          <Button
            variant="ghost"
            size="md"
            onClick={() => setAppearance(defaultAppearance)}
          >
            Revenir à l’apparence d’origine
          </Button>
        </div>
      </div>
    </div>
  );
}

function Group({
  legend,
  description,
  children,
}: {
  legend: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset
      className="flex flex-col gap-3"
      aria-describedby={description ? id : undefined}
    >
      <legend className="mb-3 font-display text-[22px] leading-tight text-ink">
        {legend}
      </legend>
      {description ? (
        <p id={id} className="-mt-2 text-[13.5px] text-ink-soft">
          {description}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

/** A radio as a card: the whole card is the target, the focus ring shows. */
function Choice({
  name,
  checked,
  onSelect,
  compact,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer flex-col rounded-2xl border bg-paper-raised transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        compact ? "min-h-12 justify-center px-3.5 py-2" : "p-3.5",
        checked
          ? "border-ink ring-1 ring-ink"
          : "border-line hover:border-line-strong",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      {children}
    </label>
  );
}

/** A thumbnail of each style: its ground, its big moment, its type. */
function StyleSwatch({ id }: { id: StyleId }) {
  if (id === "studio") {
    const palette = studioPalettes.light;
    return (
      <span
        aria-hidden="true"
        className="flex h-20 flex-col gap-1.5 rounded-xl border p-2"
        style={{ background: palette.paper, borderColor: palette.line }}
      >
        <span
          className="font-condensed flex flex-1 items-end rounded-lg px-2 pb-1 text-[26px] leading-none font-black"
          style={{ background: STUDIO_SIGNATURE, color: "#FFFFFF" }}
        >
          14.05
        </span>
        <span className="flex gap-1">
          {[3, 1, 2, 2].map((flex, index) => (
            <span
              key={index}
              className="h-2 rounded-sm"
              style={{ flex, background: palette.ink }}
            />
          ))}
        </span>
      </span>
    );
  }
  const palette = ambiances.atelier.light;
  return (
    <span
      aria-hidden="true"
      className="flex h-20 gap-2 rounded-xl border p-2"
      style={{ background: palette.paper, borderColor: palette.line }}
    >
      <span
        className="w-1/4 rounded-lg"
        style={{ background: palette.paperRaised }}
      />
      <span className="flex flex-1 flex-col gap-1.5 pt-1">
        <span
          className="text-[17px] leading-none"
          style={{ color: palette.ink, fontFamily: "var(--font-serif)" }}
        >
          Agenda
        </span>
        {[0.9, 0.6].map((width) => (
          <span
            key={width}
            className="h-2 rounded-sm"
            style={{
              width: `${width * 100}%`,
              background: palette.accentSoft,
              borderLeft: `3px solid ${palette.accent}`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

function AmbianceSwatch({ id }: { id: AmbianceId }) {
  return (
    <span aria-hidden="true" className="flex gap-1.5">
      {(["light", "dark"] as const).map((mode) => {
        const palette = ambiances[id][mode];
        return (
          <span
            key={mode}
            className="flex h-16 flex-1 flex-col justify-between rounded-xl border p-2"
            style={{ background: palette.paper, borderColor: palette.line }}
          >
            <span
              className="h-1.5 w-2/3 rounded-full"
              style={{ background: palette.ink }}
            />
            <span className="flex items-center gap-1">
              <span
                className="size-2.5 rounded-full"
                style={{ background: palette.accent }}
              />
              <span
                className="h-1 flex-1 rounded-full"
                style={{ background: palette.inkMuted }}
              />
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** A day of her agenda, drawn with the area's own components. */
function Preview() {
  return (
    <div className="flex flex-col gap-3 rounded-[28px] border border-line bg-paper p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] text-ink-soft">
          <CalendarIcon size={18} /> Aujourd’hui
        </span>
        <span className="font-display text-[26px] leading-none text-ink">
          3 rendez-vous
        </span>
      </div>
      <div className="relative flex items-center gap-2" aria-hidden="true">
        <span className="size-2 rounded-full bg-accent" />
        <span className="h-px flex-1 bg-accent" />
      </div>
      <ul className="flex flex-col gap-2">
        {(
          [
            ["9:30", "Volume russe", "Camille (exemple)", "completed"],
            ["11:00", "Rehaussement de cils", "Inès (exemple)", "confirmed"],
          ] as const
        ).map(([time, service, client, status]) => (
          <li
            key={time}
            className="flex items-center gap-3 rounded-2xl border border-line bg-paper-raised px-4 py-3"
          >
            <span className="w-12 shrink-0 text-[14px] font-semibold text-ink tabular-nums">
              {time}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-ink">
                {service}
              </span>
              <span className="block truncate text-[13px] text-ink-muted">
                {client}
              </span>
            </span>
            <StatusBadge status={status} />
          </li>
        ))}
      </ul>
      <Notice tone="success">Rendez-vous enregistré (exemple).</Notice>
      <div className="flex flex-wrap gap-2">
        <Button size="md" icon={<PlusIcon size={18} />}>
          Nouveau rendez-vous
        </Button>
        <Button size="md" variant="secondary">
          Voir la semaine
        </Button>
      </div>
      <p className="text-[13px] text-ink-soft">
        Exemple : rien de ce qui s’affiche ici n’est enregistré. Les{" "}
        <span className="font-medium text-accent underline underline-offset-2">
          liens
        </span>{" "}
        prennent ton accent.
      </p>
    </div>
  );
}
