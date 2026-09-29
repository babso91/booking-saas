"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { z } from "zod";

import { BrandMark } from "@/components/shared/brand-mark";
import { Button, type ButtonState } from "@/components/ui/button";
import { ArrowLeftIcon, ArrowRightIcon } from "@/components/ui/icons";
import {
  signOutAction,
  getOnboardingStatusAction,
} from "@/features/auth/actions/auth";
import { ErrorNotice } from "@/features/auth/components/error-notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { completeOnboardingAction } from "@/features/onboarding/actions/onboarding";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { cn } from "@/lib/cn";

import {
  clearAllDrafts,
  clearDraft,
  emptyDraft,
  loadDraft,
  saveDraft,
  type OnboardingDraft,
} from "../draft";
import {
  detailsStepSchema,
  fieldStep,
  identityStepSchema,
  onboardingSchema,
  preferencesStepSchema,
} from "../schemas";
import { detectTimezone } from "../settings";
import { slugify } from "../slug";
import { useSlugCheck } from "../use-slug-check";
import { BookingPreview } from "./booking-preview";
import { StepProgress, type StepMeta } from "./step-progress";
import { DetailsStep } from "./steps/details-step";
import { IdentityStep } from "./steps/identity-step";
import { PreferencesStep } from "./steps/preferences-step";
import { SlugStep } from "./steps/slug-step";
import type { StepProps } from "./steps/types";

const steps: StepMeta[] = [
  { id: "identity", label: "Ton activité" },
  { id: "link", label: "Ton lien" },
  { id: "preferences", label: "Réservations" },
  { id: "details", label: "Détails" },
];

const previewFocus = ["identity", "link", "preferences", "details"] as const;
const LAST_STEP = steps.length - 1;
const EXIT_MS = 150;

type Errors = Partial<Record<keyof OnboardingDraft, string>>;

function collectErrors(error: z.ZodError): Errors {
  const errors: Errors = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof OnboardingDraft | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

// Copy for fields rejected by the backend (validation_error). The backend
// message is not shown: it may be generic or not in the product's voice.
const backendFieldCopy: Errors = {
  firstName: "Vérifie ton prénom (80 caractères maximum).",
  lastName: "Vérifie ton nom (80 caractères maximum).",
  businessName: "Vérifie le nom de ton activité (120 caractères maximum).",
  slug: "Ce lien n’est pas valide. Essaie une variante.",
  timezone: "Choisis un fuseau horaire dans la liste.",
  minimumBookingNoticeMinutes: "Choisis une des options proposées.",
  maximumBookingAdvanceDays: "Choisis une des options proposées.",
  bufferMinutes: "Choisis une des options proposées.",
  phone: "Ce numéro semble incomplet.",
  location: "200 caractères maximum.",
  description: "Cette présentation est trop longue.",
  cancellationPolicy: "2000 caractères maximum.",
};

function initialState(owner: string) {
  const saved = loadDraft(owner);
  if (saved) return saved;
  return { draft: { ...emptyDraft, timezone: detectTimezone() }, step: 0 };
}

/**
 * The four-step onboarding. Rendered only behind the server guard of
 * /onboarding (requirePendingOnboarding). `owner` is the stable Auth user id:
 * the state below belongs to that account only. OnboardingFlow remounts the
 * wizard when it changes (`key`); as a safety net, an instance whose `owner`
 * changed anyway renders and saves nothing.
 */
export function OnboardingWizard({ owner }: { owner: string }) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [boundOwner] = useState(owner);
  const ownerChanged = owner !== boundOwner;
  const [initial] = useState(() => initialState(owner));
  const [draft, setDraft] = useState<OnboardingDraft>(initial.draft);
  const [step, setStep] = useState(initial.step);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [leaving, setLeaving] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [shakeKey, setShakeKey] = useState(0);
  const [formError, setFormError] = useState<UiError | null>(null);
  const [submitState, setSubmitState] = useState<ButtonState>("idle");
  const [waitingForSlug, setWaitingForSlug] = useState(false);
  const [finished, setFinished] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const fields = useRef<
    Partial<Record<keyof OnboardingDraft, HTMLElement | null>>
  >({});
  const firstRender = useRef(true);

  const slugCheck = useSlugCheck(draft.slug, {
    location: draft.location,
    firstName: draft.firstName,
  });

  useEffect(() => {
    if (!finished && !ownerChanged) saveDraft(draft, step, boundOwner);
  }, [draft, step, finished, ownerChanged, boundOwner]);

  // Move focus to the new step's heading so screen readers announce it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const registerField = useCallback(
    (name: keyof OnboardingDraft) => (element: HTMLElement | null) => {
      fields.current[name] = element;
    },
    [],
  );

  const update: StepProps["update"] = useCallback((key, value) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === "businessName" && !current.slugEdited) {
        next.slug = slugify(String(value));
      }
      return next;
    });
    setErrors((current) =>
      current[key] ? { ...current, [key]: undefined } : current,
    );
  }, []);

  const goTo = useCallback(
    (next: number) => {
      if (next === step || leaving) return;
      setDirection(next > step ? "forward" : "back");
      setFormError(null);

      if (reducedMotion) {
        setStep(next);
        window.scrollTo({ top: 0 });
        return;
      }

      setLeaving(true);
      window.setTimeout(() => {
        setStep(next);
        setLeaving(false);
        window.scrollTo({ top: 0 });
      }, EXIT_MS);
    },
    [step, leaving, reducedMotion],
  );

  const showErrors = useCallback((next: Errors) => {
    setErrors(next);
    setShakeKey((key) => key + 1);
    const first = (Object.keys(next) as (keyof OnboardingDraft)[]).find(
      (key) => next[key],
    );
    if (first) fields.current[first]?.focus({ preventScroll: false });
  }, []);

  function validateStep(index: number, slugState = slugCheck.state): Errors {
    if (index === 0) {
      const parsed = identityStepSchema.safeParse(draft);
      return parsed.success ? {} : collectErrors(parsed.error);
    }
    if (index === 1) {
      const state = slugState;
      if (state.kind === "empty")
        return { slug: "Choisis le lien de ta page." };
      if (state.kind === "invalid") return { slug: state.message };
      if (state.kind === "taken")
        return { slug: "Ce lien est déjà pris. Choisis une variante." };
      if (state.kind === "reserved")
        return { slug: "Ce mot est réservé. Essaie une variante." };
      return {};
    }
    if (index === 2) {
      const parsed = preferencesStepSchema.safeParse(draft);
      return parsed.success ? {} : collectErrors(parsed.error);
    }
    const parsed = detailsStepSchema.safeParse(draft);
    return parsed.success ? {} : collectErrors(parsed.error);
  }

  async function submit() {
    const parsed = onboardingSchema.safeParse(draft);
    if (!parsed.success) {
      const all = collectErrors(parsed.error);
      const target = Math.min(
        ...Object.keys(all).map((key) => fieldStep[key] ?? LAST_STEP),
      );
      setErrors(all);
      goTo(target);
      return;
    }

    setFormError(null);
    setSubmitState("loading");
    const result = await callAction(() =>
      completeOnboardingAction(parsed.data),
    );

    if (result.ok) {
      finish();
      return;
    }

    const { error } = result;

    switch (error.code) {
      // Race: the slug was free when checked, taken (or reserved) since.
      // Nothing typed is lost; the slug step offers verified variants.
      case "slug_taken":
      case "slug_reserved":
        setSubmitState("idle");
        slugCheck.markUnavailable(
          parsed.data.slug,
          error.code === "slug_taken" ? "taken" : "reserved",
        );
        setErrors({
          slug:
            error.code === "slug_taken"
              ? "Ce lien vient d’être pris. Choisis une des variantes."
              : "Ce mot est réservé. Essaie une variante.",
        });
        setShakeKey((key) => key + 1);
        goTo(1);
        return;
      case "validation_error": {
        setSubmitState("idle");
        const keys = Object.keys(error.fieldErrors ?? {}).filter(
          (key): key is keyof OnboardingDraft => key in backendFieldCopy,
        );
        if (keys.length === 0) {
          setFormError(error);
          return;
        }
        setErrors(
          Object.fromEntries(keys.map((key) => [key, backendFieldCopy[key]])),
        );
        setShakeKey((key) => key + 1);
        const target = Math.min(
          ...keys.map((key) => fieldStep[key] ?? LAST_STEP),
        );
        if (target !== step) goTo(target);
        return;
      }
      // Retry after a lost response, or a second tab. Success is declared
      // (and the draft deleted) only once the server confirms "ready";
      // otherwise everything is kept and the user can try again.
      case "already_onboarded": {
        const status = await callAction(() => getOnboardingStatusAction());
        if (status.ok && status.data.status === "ready") {
          finish();
          return;
        }
        setSubmitState("idle");
        setFormError(
          !status.ok
            ? status.error
            : status.data.status === "unauthenticated"
              ? { code: "unauthenticated" }
              : { code: "internal" },
        );
        return;
      }
      default:
        setSubmitState("idle");
        setFormError(error);
    }
  }

  // The success screen lives on /app/welcome, behind the "ready" guard: once
  // the business exists, the /onboarding guard sends the visitor away (the
  // action revalidates the layout), so the celebration cannot stay here.
  // /app/welcome reads the created business from the server session.
  function finish() {
    setFinished(true);
    setSubmitState("success");
    clearDraft(boundOwner);
    router.replace("/app/welcome");
  }

  const advance = (slugState = slugCheck.state) => {
    const stepErrors = validateStep(step, slugState);
    if (Object.keys(stepErrors).length > 0) {
      showErrors(stepErrors);
      return;
    }
    if (step < LAST_STEP) goTo(step + 1);
    else void submit();
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (leaving || submitState !== "idle" || waitingForSlug) return;

    // "Continue" pressed while the slug is still being checked: check now,
    // then continue (or show the problem) without a second tap.
    if (step === 1 && slugCheck.state.kind === "checking") {
      setWaitingForSlug(true);
      const settled = await slugCheck.checkNow();
      setWaitingForSlug(false);
      advance(settled);
      return;
    }
    advance();
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    const result = await callAction(() => signOutAction());
    if (!result.ok) {
      setSigningOut(false);
      setFormError(result.error);
      return;
    }
    clearAllDrafts();
    router.replace(result.data.next);
  }

  const focus = finished ? "done" : previewFocus[step]!;

  // Never render another account's answers (see the component comment).
  if (ownerChanged) return null;

  const stepProps: StepProps = {
    draft,
    update,
    errors,
    shakeKey,
    headingRef,
    registerField,
  };

  const ctaLabel = step === LAST_STEP ? "Créer mon espace" : "Continuer";
  const buttonState: ButtonState = waitingForSlug ? "loading" : submitState;

  return (
    <div className="flex min-h-dvh flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-4 lg:p-4">
      <div className="flex flex-1 flex-col px-5 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-10 lg:px-12 lg:pt-4 xl:px-20">
        <header className="flex h-14 items-center justify-between gap-3">
          {step > 0 && !finished ? (
            <button
              type="button"
              onClick={() => goTo(step - 1)}
              disabled={submitState !== "idle"}
              className="-ml-2.5 flex h-11 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-[15px] text-ink-soft transition-colors hover:bg-sand/70 hover:text-ink disabled:opacity-50"
            >
              <ArrowLeftIcon size={18} />
              Retour
            </button>
          ) : (
            <BrandMark />
          )}
          {!finished ? (
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="-mr-2.5 h-11 cursor-pointer rounded-xl px-2.5 text-[14px] text-ink-muted transition-colors hover:bg-sand/70 hover:text-ink disabled:opacity-50"
            >
              {signingOut ? "Déconnexion…" : "Se déconnecter"}
            </button>
          ) : null}
        </header>

        <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col pt-3 lg:pt-8">
          <StepProgress
            steps={steps}
            current={step}
            onSelect={goTo}
            disabled={submitState !== "idle"}
          />

          <form
            noValidate
            onSubmit={handleSubmit}
            className="flex flex-1 flex-col"
          >
            <div className="flex-1 pt-8 pb-10 lg:flex-none lg:pt-10">
              <div
                key={step}
                className={cn(
                  leaving
                    ? direction === "forward"
                      ? "animate-step-out-forward"
                      : "animate-step-out-back"
                    : direction === "forward"
                      ? "animate-step-in-forward"
                      : "animate-step-in-back",
                )}
              >
                {step === 0 ? <IdentityStep {...stepProps} /> : null}
                {step === 1 ? (
                  <SlugStep
                    {...stepProps}
                    slugState={slugCheck.state}
                    onRetryCheck={slugCheck.retry}
                  />
                ) : null}
                {step === 2 ? <PreferencesStep {...stepProps} /> : null}
                {step === 3 ? <DetailsStep {...stepProps} /> : null}
              </div>
            </div>

            <footer className="sticky bottom-0 z-10 -mx-5 flex flex-col gap-3 bg-[linear-gradient(to_top,var(--paper)_72%,transparent)] px-5 pt-6 pb-[max(env(safe-area-inset-bottom),1rem)] sm:-mx-10 sm:px-10 lg:static lg:mx-0 lg:bg-none lg:px-0 lg:pb-10">
              {formError ? (
                <ErrorNotice
                  error={formError}
                  action={
                    formError.code === "unauthenticated" ? (
                      <Link
                        href="/login"
                        className="text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                      >
                        Me reconnecter
                      </Link>
                    ) : formError.code === "network" ||
                      formError.code === "internal" ? (
                      <button
                        type="submit"
                        className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                      >
                        Réessayer
                      </button>
                    ) : undefined
                  }
                />
              ) : null}
              <Button
                type="submit"
                fullWidth
                state={buttonState}
                disabled={leaving}
                loadingLabel={
                  waitingForSlug
                    ? "Vérification du lien…"
                    : "Création de ton espace…"
                }
                successLabel="C’est prêt"
                icon={
                  step === LAST_STEP ? undefined : <ArrowRightIcon size={18} />
                }
              >
                {ctaLabel}
              </Button>
              {step === LAST_STEP ? (
                <p className="text-center text-[13px] text-ink-muted">
                  Tout reste modifiable plus tard.
                </p>
              ) : null}
              <p className="sr-only" role="status" aria-live="polite">
                {submitState === "loading"
                  ? "Création de ton espace en cours"
                  : waitingForSlug
                    ? "Vérification du lien en cours"
                    : ""}
              </p>
            </footer>
          </form>
        </main>
      </div>

      <aside
        aria-label="Aperçu de ta page de réservation"
        className="grain relative hidden overflow-hidden rounded-[28px] bg-sand lg:sticky lg:top-4 lg:flex lg:h-[calc(100dvh-2rem)] lg:flex-col lg:items-center lg:justify-center lg:gap-6"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute size-[640px] rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.2),transparent_62%)] transition-transform duration-[1200ms] ease-soft"
          style={{ transform: ambientPosition(finished ? 4 : step) }}
        />
        <p className="relative flex items-center gap-2 text-[12.5px] font-medium tracking-[0.12em] text-ink-soft uppercase">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-success/50" />
            <span className="relative size-2 rounded-full bg-success" />
          </span>
          Aperçu en direct
        </p>
        <div className="relative origin-center scale-[0.86] [@media(min-height:860px)]:scale-100">
          <BookingPreview draft={draft} focus={focus} />
        </div>
      </aside>
    </div>
  );
}

// The warm glow drifts to a new corner at each step: a quiet change of scene.
function ambientPosition(step: number) {
  const positions = [
    "translate(-30%, -35%)",
    "translate(30%, -25%)",
    "translate(25%, 30%)",
    "translate(-30%, 25%)",
    "translate(0%, 0%) scale(1.2)",
  ];
  return positions[step] ?? positions[0];
}
