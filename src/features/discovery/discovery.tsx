"use client";

import type { Route } from "next";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";

import type { Appearance } from "@/features/appearance/appearance";
import {
  AppearanceProvider,
  useAppearance,
} from "@/features/appearance/components/appearance-provider";
import {
  ambiances,
  inkPresets,
  signaturePresets,
  stonePresets,
  styles,
  trioIds,
  type AmbianceId,
  type StyleId,
} from "@/features/appearance/palettes";
import { cn } from "@/lib/cn";

import {
  emptyDraft,
  forgetForAccount,
  keepForAccount,
  readDraft,
  writeDraft,
  type DiscoveryDraft,
} from "./keep";
import { Stage } from "./stage";
import { UniverseToken } from "./tokens";

/**
 * Discover the software before having an account (experiment, 16/11).
 *
 * Not a gallery: her own day, in the real software, under her salon's
 * name. She tries the universes and their colours on it, chooses one, and
 * creates her account to keep it; she finds it again on arrival.
 *
 * Three moments, one page: the opening (her salon's name, the software
 * waiting behind, blurred), the exploration (the dock: universes, colours,
 * day/night), the choice (keep it: sign up). The browser's back button
 * goes back a moment; a reload or a closed tab finds her draft again.
 * Signing up directly stays one click away at every moment.
 */

type Moment = "opening" | "exploring" | "chosen";

const noSubscription = () => () => {};
const MOMENTS: Moment[] = ["opening", "exploring", "chosen"];

export function Discovery({ invitation }: { invitation: string | null }) {
  // The draft lives in this browser: read once there, never on the server.
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!inBrowser) return <div className="min-h-dvh bg-paper" />;
  return <Loaded invitation={invitation} />;
}

function Loaded({ invitation }: { invitation: string | null }) {
  const [initial] = useState<DiscoveryDraft>(() => readDraft() ?? emptyDraft());
  return (
    <AppearanceProvider initial={initial.appearance}>
      <Experience initial={initial} invitation={invitation} />
    </AppearanceProvider>
  );
}

function Experience({
  initial,
  invitation,
}: {
  initial: DiscoveryDraft;
  invitation: string | null;
}) {
  const { appearance, change } = useAppearance();
  const [businessName, setBusinessName] = useState(initial.businessName);
  const [moment, setMoment] = useState<Moment>(
    initial.chosen ? "chosen" : initial.businessName ? "exploring" : "opening",
  );
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | null>(null);

  // Her draft follows every change.
  useEffect(() => {
    writeDraft({
      businessName,
      appearance,
      chosen: moment === "chosen",
      savedAt: Date.now(),
    });
  }, [businessName, appearance, moment]);

  // The browser's back button goes back a moment, not off the page; its
  // forward button comes back to the choice, kept again for her account.
  const latest = useRef(appearance);
  useEffect(() => {
    latest.current = appearance;
  }, [appearance]);
  useEffect(() => {
    window.history.replaceState({ discovery: moment }, "");
    const onPop = (event: PopStateEvent) => {
      const step = (event.state as { discovery?: Moment } | null)?.discovery;
      if (step && MOMENTS.includes(step)) {
        if (step === "chosen") keepForAccount(latest.current);
        else forgetForAccount();
        setMoment(step);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // Only once: later moments push their own entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback((next: Moment) => {
    window.history.pushState({ discovery: next }, "");
    setMoment(next);
  }, []);

  const reduced = appearance.motion === "none" || prefersReducedMotion();
  /** A change of look, morphing the whole screen where the browser can. */
  const morph = useCallback(
    (patch: Partial<Appearance>) => {
      const doc = document as Document & {
        startViewTransition?: (update: () => void) => unknown;
      };
      if (!reduced && doc.startViewTransition)
        doc.startViewTransition(() => flushSync(() => change(patch)));
      else change(patch);
    },
    [change, reduced],
  );

  function say(text: string) {
    setHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  }

  /**
   * What would leave this page or reach her account (a link, an
   * appointment, « Réglages ») stays here and says so; what only unfolds
   * on the page (her notes, the past visits) works for real.
   */
  function catchIntents(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as Element;
    // Only the control that unfolds works, not what it reveals (a menu's
    // links still lead to her area).
    const control = target.closest("a, button, [role='button'], [role='link']");
    if (control?.hasAttribute("aria-expanded")) return;
    if (!leadsSomewhere(target, event.currentTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    say(
      "Dans ton espace, ceci s’ouvre pour de vrai. Crée ton compte pour y aller.",
    );
  }

  const signupHref = (
    invitation
      ? `/signup?invitation=${encodeURIComponent(invitation)}`
      : "/signup"
  ) as Route;

  return (
    <>
      <div
        className={cn(
          "contents",
          moment === "opening" &&
            "[&>*]:pointer-events-none [&>*]:scale-[1.03] [&>*]:blur-[14px] [&>*]:saturate-[0.85]",
          "[&>*]:transition-[filter,transform] [&>*]:duration-700 [&>*]:ease-soft motion-reduce:[&>*]:transition-none",
        )}
        onClickCapture={catchIntents}
        aria-hidden={moment === "opening" || undefined}
        inert={moment === "opening" || undefined}
      >
        <Stage
          businessName={businessName}
          onIntent={() =>
            say(
              "Dans ton espace, ce rendez-vous s’ouvre pour de vrai. Crée ton compte pour y aller.",
            )
          }
        />
      </div>

      {moment === "opening" ? (
        <Opening
          businessName={businessName}
          onName={setBusinessName}
          onStart={() => go("exploring")}
          signupHref={signupHref}
        />
      ) : (
        <Dock
          appearance={appearance}
          onMorph={morph}
          onChoose={() => {
            keepForAccount(appearance);
            go("chosen");
          }}
          onRename={() => go("opening")}
          signupHref={signupHref}
          hidden={moment === "chosen"}
        />
      )}

      {moment === "chosen" ? (
        <Chosen
          businessName={businessName}
          style={appearance.style}
          signupHref={signupHref}
          onExplore={() => {
            forgetForAccount();
            go("exploring");
          }}
        />
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed inset-x-4 top-4 z-[70] mx-auto w-fit max-w-md rounded-2xl bg-ink px-4 py-3 text-center text-[14px] text-paper shadow-[0_18px_40px_-18px_rgb(var(--shadow-rgb)/0.6)] transition-[opacity,transform] duration-200 ease-soft",
          hint ? "opacity-100" : "-translate-y-2 opacity-0",
        )}
      >
        {hint}
      </p>
    </>
  );
}

/**
 * Whether a click on this element would do something: a link, a button,
 * or anything drawn as clickable (the arcs of Écrin's dial are SVG paths
 * with a click handler, no role). What looks clickable is caught.
 */
function leadsSomewhere(target: Element, stage: Element) {
  if (target.closest("a, button, [role='button'], [role='link']")) return true;
  for (
    let node: Element | null = target;
    node && node !== stage;
    node = node.parentElement
  ) {
    if (window.getComputedStyle(node).cursor === "pointer") return true;
  }
  return false;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---------------------------------------------------------------------- */
/* Opening: her salon's name, the software waiting behind.                 */
/* ---------------------------------------------------------------------- */

function Opening({
  businessName,
  onName,
  onStart,
  signupHref,
}: {
  businessName: string;
  onName: (value: string) => void;
  onStart: () => void;
  signupHref: Route;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-paper/70 backdrop-blur-[2px]">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
        <span className="text-[15px] font-semibold text-ink">Booking</span>
        <span className="flex items-center gap-4 text-[14px]">
          <Link
            href="/login"
            className="text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            Me connecter
          </Link>
          <Link
            href={signupHref}
            className="font-semibold text-ink underline decoration-line-strong underline-offset-4"
          >
            Créer mon compte
          </Link>
        </span>
      </div>

      <form
        className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-7 px-5 py-12 sm:px-8"
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <div className="flex flex-col gap-4">
          <h1 className="font-display text-[44px] leading-[1.02] text-balance text-ink sm:text-[60px]">
            Ton agenda devrait te ressembler
          </h1>
          <p className="max-w-[38ch] text-[17px] leading-relaxed text-pretty text-ink-soft">
            Essaie le logiciel sur une vraie journée, à ton nom. Quatre univers,
            une seule façon de travailler. Aucun compte pour l’instant.
          </p>
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-[14px] font-medium text-ink-soft">
            Le nom de ton salon
          </span>
          <input
            autoFocus
            value={businessName}
            maxLength={80}
            onChange={(event) => onName(event.target.value)}
            placeholder="Atelier Lune"
            autoComplete="organization"
            className="h-14 w-full rounded-2xl border border-line bg-paper-raised px-4 text-[19px] text-ink shadow-[0_1px_0_rgb(var(--shadow-rgb)/0.04)] placeholder:text-ink-muted focus-visible:border-ink focus-visible:outline-none"
          />
        </label>

        <div className="flex flex-col items-start gap-4">
          <button
            type="submit"
            className="flex h-14 items-center gap-2.5 rounded-2xl bg-pop px-6 text-[17px] font-semibold text-on-pop shadow-[0_14px_30px_-14px_rgb(var(--shadow-rgb)/0.6)] transition-transform duration-150 ease-soft hover:bg-pop-hover active:scale-[0.97]"
          >
            Voir ma journée
            <span aria-hidden="true">→</span>
          </button>
          <p className="text-[13.5px] text-ink-muted">
            Une journée fictive : aucune donnée n’est envoyée.
          </p>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* The dock: universes, their colours, day and night, the choice.          */
/* ---------------------------------------------------------------------- */

const STYLE_ORDER: StyleId[] = ["classique", "studio", "ecrin", "carnet"];

function colourOptions(style: StyleId) {
  if (style === "studio")
    return { label: "Ta couleur", presets: signaturePresets };
  if (style === "ecrin") return { label: "Ta pierre", presets: stonePresets };
  if (style === "carnet") return { label: "Ton encre", presets: inkPresets };
  return null;
}

const AMBIANCE_ORDER: AmbianceId[] = [...trioIds, "atelier", "lin", "sauge"];

function Dock({
  appearance,
  onMorph,
  onChoose,
  onRename,
  signupHref,
  hidden,
}: {
  appearance: Appearance;
  onMorph: (patch: Partial<Appearance>) => void;
  onChoose: () => void;
  onRename: () => void;
  signupHref: Route;
  hidden: boolean;
}) {
  const [open, setOpen] = useState(true);
  const colours = colourOptions(appearance.style);
  const dark = appearance.mode === "dark";
  const look = dark ? "dark" : "light";

  return (
    <section
      aria-label="Essayer les univers"
      className={cn(
        "fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-[44rem] rounded-[28px] bg-paper-raised/92 text-ink shadow-[0_1px_0_rgb(var(--shadow-rgb)/0.06),0_30px_70px_-30px_rgb(var(--shadow-rgb)/0.55)] backdrop-blur-xl transition-[opacity,transform] duration-300 ease-soft sm:bottom-5",
        hidden && "pointer-events-none translate-y-6 opacity-0",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3 sm:px-5">
        <p className="min-w-0 text-[13.5px] text-ink-soft">
          <span className="font-semibold text-ink">
            {styles[appearance.style].name}
          </span>
          <span className="hidden sm:inline">
            {" "}
            · {styles[appearance.style].line}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="shrink-0 cursor-pointer rounded-full px-2 py-1 text-[13px] font-medium text-ink-soft hover:text-ink"
        >
          {open ? "Réduire" : "Changer"}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-2 px-2.5 pt-2 pb-2.5 sm:gap-3 sm:px-4 sm:pt-3 sm:pb-3">
          <div
            role="radiogroup"
            aria-label="Univers"
            className="grid grid-cols-4 gap-1 sm:gap-2"
          >
            {STYLE_ORDER.map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={appearance.style === style}
                onClick={() => onMorph({ style, accent: null })}
                className={cn(
                  "group flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl p-1.5 transition-[background-color,transform] duration-150 ease-soft active:scale-[0.96]",
                  appearance.style === style ? "bg-sand" : "hover:bg-sand/60",
                )}
              >
                <UniverseToken
                  style={style}
                  active={appearance.style === style}
                />
                <span
                  className={cn(
                    "text-[12.5px]",
                    appearance.style === style
                      ? "font-semibold text-ink"
                      : "text-ink-soft",
                  )}
                >
                  {styles[style].name}
                </span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {/* One line, scrolled sideways on a phone. */}
            <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div
                role="radiogroup"
                aria-label="Ambiance"
                className="flex shrink-0 gap-1.5"
              >
                {AMBIANCE_ORDER.map((id) => {
                  const palette = ambiances[id][look];
                  const active = appearance.ambiance === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={`Ambiance ${ambiances[id].name}`}
                      title={ambiances[id].name}
                      onClick={() => onMorph({ ambiance: id })}
                      className={cn(
                        "size-7 shrink-0 cursor-pointer rounded-full transition-transform duration-150 ease-soft active:scale-90 sm:size-8",
                        active &&
                          "ring-2 ring-ink ring-offset-2 ring-offset-paper-raised",
                      )}
                      style={{
                        background: `conic-gradient(${palette.paper} 0 50%, ${palette.ink} 0 75%, ${palette.pop ?? palette.accent} 0)`,
                      }}
                    />
                  );
                })}
              </div>
              {colours ? (
                <div
                  role="radiogroup"
                  aria-label={colours.label}
                  className="flex shrink-0 gap-1.5 border-l border-line pl-3"
                >
                  {colours.presets.map((preset) => {
                    const active = appearance.accent === preset.color;
                    return (
                      <button
                        key={preset.color}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={`${colours.label} : ${preset.name}`}
                        title={preset.name}
                        onClick={() => onMorph({ accent: preset.color })}
                        className={cn(
                          "size-6 shrink-0 cursor-pointer rounded-full transition-transform duration-150 ease-soft active:scale-90",
                          active &&
                            "ring-2 ring-ink ring-offset-2 ring-offset-paper-raised",
                        )}
                        style={{ background: preset.color }}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dark}
              onClick={() => onMorph({ mode: dark ? "light" : "dark" })}
              aria-label="Nuit"
              className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-[13.5px] font-medium text-ink-soft hover:bg-sand hover:text-ink"
            >
              <span aria-hidden="true">{dark ? "☾" : "☀"}</span>
              <span aria-hidden="true" className="hidden sm:inline">
                {dark ? "Nuit" : "Jour"}
              </span>
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-2.5 border-t border-line px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
        <span className="flex items-center justify-center gap-5 text-[13.5px] sm:justify-start sm:gap-4">
          <button
            type="button"
            onClick={onRename}
            className="cursor-pointer text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            Changer de nom
          </button>
          <Link
            href={signupHref}
            className="text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            Créer mon compte
          </Link>
        </span>
        <button
          type="button"
          onClick={onChoose}
          className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full bg-pop px-5 text-[15px] font-semibold text-on-pop transition-transform duration-150 ease-soft hover:bg-pop-hover active:scale-[0.97]"
        >
          C’est mon univers
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------- */
/* The choice: keep it.                                                    */
/* ---------------------------------------------------------------------- */

function Chosen({
  businessName,
  style,
  signupHref,
  onExplore,
}: {
  businessName: string;
  style: StyleId;
  signupHref: Route;
  onExplore: () => void;
}) {
  const name = businessName.trim() || "Ton salon";
  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-ink/25 p-3 backdrop-blur-[3px] sm:items-center">
      <section
        aria-labelledby="discovery-chosen"
        className="flex w-full max-w-md animate-rise flex-col gap-5 rounded-[28px] bg-paper-raised p-6 text-ink shadow-[0_40px_90px_-40px_rgb(var(--shadow-rgb)/0.7)] sm:p-7"
      >
        <div className="flex items-center gap-4">
          <UniverseToken style={style} active large />
          <div className="flex min-w-0 flex-col">
            <span className="text-[13.5px] text-ink-muted">Ton univers</span>
            <h2
              id="discovery-chosen"
              className="font-display text-[28px] leading-tight wrap-anywhere"
            >
              {name}, en {styles[style].name}
            </h2>
          </div>
        </div>
        <p className="text-[15.5px] leading-relaxed text-pretty text-ink-soft">
          Crée ton espace pour le garder : tu le retrouveras tel quel dès ta
          première connexion, avec tes vrais rendez-vous.
        </p>
        <p className="text-[13.5px] leading-relaxed text-ink-muted">
          Ton mini-site, celui que voient tes clientes, se choisit à part, dans
          « Mon site ».
        </p>
        <div className="flex flex-col gap-2.5">
          <Link
            href={signupHref}
            className="flex h-13 items-center justify-center gap-2 rounded-2xl bg-pop py-3.5 text-[16px] font-semibold text-on-pop transition-transform duration-150 ease-soft hover:bg-pop-hover active:scale-[0.98]"
          >
            Créer mon espace
            <span aria-hidden="true">→</span>
          </Link>
          <button
            type="button"
            onClick={onExplore}
            className="h-11 cursor-pointer rounded-2xl text-[15px] font-medium text-ink-soft hover:bg-sand hover:text-ink"
          >
            Continuer à explorer
          </button>
        </div>
      </section>
    </div>
  );
}
