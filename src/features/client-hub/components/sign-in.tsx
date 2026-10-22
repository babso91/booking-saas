"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  LockIcon,
  MailIcon,
  SparkIcon,
} from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";

import {
  requestCode,
  verifyCode,
  type CodeChallenge,
  type HubError,
} from "../client/api";
import { useClientHub, type SignedOutReason } from "../client/session";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { hubErrorCopy, linkButton } from "./hub-parts";
import { hubHref } from "./hub-shell";

// Passwordless sign-in (docs/CLIENT_HUB_CONTRACT.md §2): an email, then the
// 8-digit code sent to it. The code lives in this component's memory only
// (never stored, never in a URL) and is cleared after each attempt. The
// answers never say whether an address is known: a code is sent to any
// valid address, and an account opens only once it is verified.

/** Wrong codes accepted per code by the backend, then it is exhausted. */
export const ATTEMPTS = 5;
/** A code is valid 10 minutes (the backend decides; this only displays). */
const CODE_TTL_MS = 10 * 60_000;
/** Pause between two sends, under the backend's own limits. */
export const RESEND_DELAY_MS = 30_000;

type CodeStep = {
  email: string;
  challengeId: string;
  /** performance.now() deadlines: a device clock change moves nothing. */
  expiresAt: number;
  resendAt: number;
  failures: number;
  /** A new code replaced the previous one. */
  resent?: boolean;
};

type SendError = HubError | { code: "invalid_email"; message: string };

const now = () => performance.now();

/** Remaining validity, from the server's instant but the device's clock. */
function deadline(challenge: CodeChallenge) {
  const left = Date.parse(challenge.expiresAt) - Date.now();
  // A device clock far ahead or behind: the contract's 10 minutes.
  const ttl =
    Number.isFinite(left) && left > 0 && left <= CODE_TTL_MS
      ? left
      : CODE_TTL_MS;
  return now() + ttl;
}

function checkEmail(value: string): string | null {
  const email = value.trim();
  if (!email) return "Indiquez votre adresse email.";
  if (!/^[\x21-\x7e]+$/.test(email))
    return "Utilisez une adresse sans accents, espaces ni caractères spéciaux.";
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email) || email.length > 254)
    return "Cette adresse email n’est pas valable.";
  return null;
}

const reasons: Record<Exclude<SignedOutReason, null>, string> = {
  expired: "Votre session a expiré. Reconnectez-vous avec un nouveau code.",
  "signed-out": "Vous êtes déconnectée. À bientôt !",
  elsewhere: "Vous avez été déconnectée depuis un autre onglet.",
};

export function SignIn() {
  const { session, signedIn, recheck } = useClientHub();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<CodeStep | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const signedInNow = session.status === "signed-in";

  useEffect(() => {
    if (signedInNow) router.replace(hubHref.home);
  }, [router, signedInNow]);

  const reason = session.status === "signed-out" ? session.reason : null;

  return (
    <SignInFrame>
      {session.status === "checking" || signedInNow ? (
        <div
          role="status"
          className="flex animate-fade items-center gap-3 text-[15px] text-ink-soft"
        >
          <Spinner />
          {signedInNow ? "Ouverture de votre espace…" : "Un instant…"}
        </div>
      ) : unavailable ? (
        <Unavailable
          onRetry={() => {
            setUnavailable(false);
            setStep(null);
          }}
        />
      ) : step ? (
        <CodeForm
          key={step.challengeId}
          step={step}
          onChange={setStep}
          onBack={() => setStep(null)}
          onUnavailable={() => setUnavailable(true)}
          onSignedIn={signedIn}
          onUncertain={recheck}
        />
      ) : (
        <EmailForm
          email={email}
          onEmailChange={setEmail}
          notice={reason ? reasons[reason] : null}
          sessionError={session.status === "error" ? session.error : null}
          onRetrySession={recheck}
          onSent={(challenge) =>
            setStep({
              email: email.trim(),
              challengeId: challenge.challengeId,
              expiresAt: deadline(challenge),
              resendAt: now() + RESEND_DELAY_MS,
              failures: 0,
            })
          }
          onUnavailable={() => setUnavailable(true)}
        />
      )}
    </SignInFrame>
  );
}

function sendErrorCopy(error: SendError) {
  switch (error.code) {
    case "invalid_email":
      return null;
    case "rate_limited":
      return {
        title: "Trop de demandes",
        message:
          "Plusieurs codes ont déjà été demandés. Patientez quelques minutes avant d’en redemander un.",
      };
    case "forbidden":
      return {
        title: "Demande refusée",
        message:
          "Par sécurité, la demande n’a pas été acceptée. Rechargez la page puis réessayez.",
      };
    default:
      return hubErrorCopy(error as HubError);
  }
}

function EmailForm({
  email,
  onEmailChange,
  notice,
  sessionError,
  onRetrySession,
  onSent,
  onUnavailable,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  notice: string | null;
  sessionError: HubError | null;
  onRetrySession: () => void;
  onSent: (challenge: CodeChallenge) => void;
  onUnavailable: () => void;
}) {
  const [error, setError] = useState<SendError | null>(null);
  const [sending, setSending] = useState(false);
  const [shake, setShake] = useState(0);
  const busy = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const invalid = checkEmail(email);
    if (invalid) {
      setError({ code: "invalid_email", message: invalid });
      setShake((value) => value + 1);
      return;
    }
    busy.current = true;
    setSending(true);
    setError(null);
    const result = await requestCode(email.trim());
    busy.current = false;
    setSending(false);
    if (result.ok) return onSent(result.data);
    if (result.error.code === "client_hub_unavailable") return onUnavailable();
    if (result.error.code === "validation_error") {
      setError({
        code: "invalid_email",
        message:
          result.error.fieldErrors?.email?.[0] ??
          "Cette adresse email n’est pas valable.",
      });
      setShake((value) => value + 1);
      return;
    }
    setError(result.error);
  }

  const fieldError =
    error?.code === "invalid_email" ? error.message : undefined;
  const copy = error ? sendErrorCopy(error) : null;

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex animate-rise flex-col gap-7"
    >
      <Heading
        eyebrow="Mon espace"
        title={
          <>
            Vos rendez-vous et vos points,{" "}
            <em className="text-accent">au même endroit.</em>
          </>
        }
      >
        Indiquez l’adresse email donnée à votre établissement. Nous vous
        envoyons un code de connexion : aucun mot de passe à retenir.
      </Heading>

      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {sessionError && sessionError.code !== "client_hub_unauthenticated" ? (
        <Notice
          tone={sessionError.code === "network" ? "offline" : "warning"}
          title={hubErrorCopy(sessionError).title}
          action={
            <button
              type="button"
              onClick={onRetrySession}
              className={linkButton}
            >
              Réessayer
            </button>
          }
        >
          {hubErrorCopy(sessionError).message}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-4">
        <TextField
          label="Adresse email"
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="prenom@exemple.fr"
          leadingIcon={<MailIcon size={18} />}
          value={email}
          onChange={(event) => {
            onEmailChange(event.target.value);
            if (error) setError(null);
          }}
          error={fieldError}
          shakeKey={shake}
          disabled={sending}
          data-autofocus=""
        />
        {copy ? (
          <Notice
            tone={
              error?.code === "network"
                ? "offline"
                : error?.code === "rate_limited"
                  ? "warning"
                  : "error"
            }
            title={copy.title}
          >
            {copy.message}
          </Notice>
        ) : null}
        <Button
          type="submit"
          fullWidth
          state={sending ? "loading" : "idle"}
          loadingLabel="Envoi du code…"
          icon={<ArrowRightIcon size={18} />}
        >
          Recevoir mon code
        </Button>
      </div>

      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted">
        <LockIcon size={15} className="mt-0.5 shrink-0" />
        Vous ne voyez que ce que votre établissement a choisi de partager avec
        vous. Rien ne peut être modifié depuis cet espace.
      </p>
    </form>
  );
}

function CodeForm({
  step,
  onChange,
  onBack,
  onUnavailable,
  onSignedIn,
  onUncertain,
}: {
  step: CodeStep;
  onChange: Dispatch<SetStateAction<CodeStep | null>>;
  onBack: () => void;
  onUnavailable: () => void;
  onSignedIn: (session: { email: string; expiresAt: string }) => void;
  onUncertain: () => void;
}) {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState<HubError | null>(null);
  const [clock, setClock] = useState(now);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    const timer = window.setInterval(() => setClock(now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const left = Math.max(0, step.expiresAt - clock);
  const expired = left === 0;
  const locked = step.failures >= ATTEMPTS;
  const wait = Math.max(0, step.resendAt - clock);

  async function verify(value: string) {
    if (busy.current || expired || locked) return;
    busy.current = true;
    setVerifying(true);
    setError(null);
    setResent(null);
    const result = await verifyCode({
      challengeId: step.challengeId,
      email: step.email,
      code: value,
    });
    busy.current = false;
    if (result.ok) {
      setCode(""); // nothing of the code is kept
      onSignedIn(result.data);
      return;
    }
    setVerifying(false);
    if (result.error.code === "client_hub_unavailable") return onUnavailable();
    if (result.error.code === "network") {
      // The session may have been opened without the answer reaching us:
      // ask who is signed in rather than guessing.
      setError(result.error);
      onUncertain();
      return;
    }
    setCode("");
    if (result.error.code === "client_hub_code_invalid") {
      // Counted on this challenge only: a new code sent meanwhile keeps
      // its own attempts.
      onChange((current) =>
        current?.challengeId === step.challengeId
          ? { ...current, failures: current.failures + 1 }
          : current,
      );
    }
    setError(result.error);
    input.current?.focus();
  }

  async function resend() {
    // Not while a code is being checked: its answer belongs to this challenge.
    if (resending || verifying || wait > 0) return;
    setResending(true);
    setResent(null);
    const result = await requestCode(step.email);
    setResending(false);
    if (result.ok) {
      setCode("");
      setError(null);
      // A new challenge: its own deadline and attempts (a new key remounts
      // this form, the "sent" message is carried by the step).
      onChange({
        ...step,
        challengeId: result.data.challengeId,
        expiresAt: deadline(result.data),
        resendAt: now() + RESEND_DELAY_MS,
        failures: 0,
        resent: true,
      });
      return;
    }
    if (result.error.code === "client_hub_unavailable") return onUnavailable();
    setResent(result.error);
  }

  const message = locked
    ? "Trop d’essais pour ce code. Demandez-en un nouveau."
    : expired
      ? "Ce code a expiré. Demandez-en un nouveau."
      : error?.code === "client_hub_code_invalid"
        ? "Ce code n’est pas valable. Vérifiez-le ou demandez-en un nouveau."
        : error?.code === "validation_error"
          ? "Le code contient 8 chiffres."
          : null;
  const notice =
    error && !message
      ? error.code === "rate_limited"
        ? {
            title: "Trop d’essais",
            message:
              "Trop de codes incorrects depuis ce réseau. Patientez avant de réessayer.",
          }
        : error.code === "network"
          ? {
              title: "Vérification interrompue",
              message:
                "La réponse n’est pas arrivée. Vérifiez votre connexion puis réessayez avec le même code.",
            }
          : hubErrorCopy(error)
      : null;
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === CODE_LENGTH) void verify(code);
        else setError({ code: "validation_error" });
      }}
      className="flex animate-step-in-forward flex-col gap-7"
    >
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-1 py-1 text-[14px] text-ink-soft hover:text-ink"
      >
        <ArrowLeftIcon size={16} /> Modifier l’adresse
      </button>

      <Heading eyebrow="Étape 2 sur 2" title="Saisissez votre code">
        Nous avons envoyé un code à 8 chiffres à{" "}
        <strong className="font-semibold wrap-anywhere text-ink">
          {step.email}
        </strong>
        . Pensez à vérifier vos courriers indésirables.
      </Heading>

      <div className="flex flex-col gap-3">
        <CodeInput
          label="Code à 8 chiffres"
          value={code}
          inputRef={input}
          readOnly={verifying}
          disabled={expired || locked}
          invalid={Boolean(message)}
          describedBy={`${message ? errorId : ""} ${hintId}`.trim()}
          onChange={(digits) => {
            setCode(digits);
            if (error) setError(null);
            // A complete code is sent at once (typed, pasted or autofilled).
            if (digits.length === CODE_LENGTH && digits !== code)
              void verify(digits);
          }}
        />
        <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13.5px]">
          {message ? (
            <p
              id={errorId}
              role="alert"
              className="animate-message text-danger"
            >
              {message}
            </p>
          ) : (
            <p id={hintId} className="text-ink-muted">
              {verifying ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size={14} /> Vérification…
                </span>
              ) : (
                <>
                  Valable encore{" "}
                  <span className="font-medium text-ink-soft tabular-nums">
                    {minutes}:{String(seconds).padStart(2, "0")}
                  </span>
                </>
              )}
            </p>
          )}
          {!locked && !expired && step.failures > 0 && !message ? (
            <span className="text-ink-muted">
              {ATTEMPTS - step.failures} essai
              {ATTEMPTS - step.failures > 1 ? "s" : ""} restant
              {ATTEMPTS - step.failures > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      </div>

      {notice ? (
        <Notice
          tone={error?.code === "network" ? "offline" : "warning"}
          title={notice.title}
        >
          {notice.message}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button
          type="submit"
          fullWidth
          state={verifying ? "loading" : "idle"}
          loadingLabel="Vérification…"
          disabled={expired || locked || code.length < CODE_LENGTH}
        >
          Accéder à mon espace
        </Button>
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[14px] text-ink-soft">
          <span>Pas reçu de code ?</span>
          <button
            type="button"
            onClick={() => void resend()}
            disabled={resending || verifying || wait > 0}
            className={linkButton}
          >
            {resending
              ? "Envoi…"
              : wait > 0
                ? `Renvoyer dans ${Math.ceil(wait / 1000)} s`
                : "Recevoir un nouveau code"}
          </button>
        </div>
        {step.resent && !resent ? (
          <Notice tone="success">
            Un nouveau code vient d’être envoyé. Utilisez le plus récent.
          </Notice>
        ) : null}
        {resent ? (
          <Notice
            tone={resent.code === "network" ? "offline" : "warning"}
            title={sendErrorCopy(resent)?.title}
          >
            {sendErrorCopy(resent)?.message}
          </Notice>
        ) : null}
      </div>
    </form>
  );
}

function Unavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex animate-rise flex-col gap-6">
      <Heading eyebrow="Mon espace" title="Accès temporairement indisponible">
        La connexion à l’espace client n’est pas disponible pour le moment.
        Aucun code n’a été envoyé. Merci de réessayer plus tard, ou de contacter
        directement votre établissement.
      </Heading>
      <Button variant="secondary" onClick={onRetry} fullWidth>
        Réessayer
      </Button>
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
        {eyebrow}
      </p>
      <h1 className="font-display text-[40px] leading-[1.02] tracking-[-0.015em] text-balance text-ink sm:text-[46px]">
        {title}
      </h1>
      {children ? (
        <p className="text-[15.5px] leading-relaxed text-ink-soft">
          {children}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sign-in frame: the form, and on large screens an editorial panel
 * previewing the hub (decorative, hidden from assistive technologies).
 */
function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-4 lg:p-4">
      <div className="flex flex-1 flex-col px-5 pt-[max(env(safe-area-inset-top),1.25rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] sm:px-10 lg:px-12 lg:py-8 xl:px-20">
        <header className="flex items-center gap-2.5 text-ink">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="15" fill="var(--ink)" />
            <path
              d="M8.5 19.5a8 8 0 0 1 15 0"
              fill="none"
              stroke="var(--paper-raised)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <circle cx="21.3" cy="12.6" r="2.1" fill="var(--accent-soft)" />
          </svg>
          <span className="font-display text-[22px] leading-none tracking-[-0.01em]">
            Mon espace
          </span>
        </header>
        <main className="flex flex-1 flex-col justify-center py-10 lg:py-12">
          <div className="mx-auto w-full max-w-[420px]">{children}</div>
        </main>
      </div>
      <Showcase />
    </div>
  );
}

function Showcase() {
  return (
    <div
      aria-hidden="true"
      className="grain relative hidden overflow-hidden rounded-[28px] bg-sand lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14"
    >
      <div className="pointer-events-none absolute -top-40 -right-32 size-[520px] animate-drift rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.22),transparent_65%)]" />
      <div className="pointer-events-none absolute -bottom-48 -left-24 size-[480px] animate-drift rounded-full bg-[radial-gradient(circle_at_center,rgba(255,252,248,0.9),transparent_60%)] [animation-delay:-8s]" />

      <p className="relative max-w-sm text-[13px] font-medium tracking-[0.16em] text-ink-soft uppercase">
        Votre espace cliente
      </p>

      <div className="relative my-10 flex flex-1 items-center justify-center">
        <div className="relative h-[360px] w-full max-w-[440px]">
          <div className="absolute top-0 left-0 w-[280px] animate-float rounded-3xl border border-white/60 bg-paper-raised p-5 shadow-[0_30px_60px_-30px_rgba(35,28,24,0.35)] [--tilt:-3deg]">
            <div className="flex items-center justify-between text-[12px] text-ink-muted">
              <span className="flex items-center gap-2">
                <CalendarIcon size={15} /> Prochain rendez-vous
              </span>
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent-strong">
                Dans 3 jours
              </span>
            </div>
            <div className="mt-4 flex items-center gap-4">
              <span className="flex w-[60px] flex-col items-center rounded-2xl border border-accent/15 bg-accent-soft/60 py-2 text-accent-strong">
                <span className="text-[11px] font-semibold tracking-[0.12em] uppercase">
                  jeu.
                </span>
                <span className="font-display text-[30px] leading-none text-ink">
                  14
                </span>
                <span className="text-[11.5px] font-medium">nov.</span>
              </span>
              <div>
                <p className="font-display text-[24px] leading-tight text-ink">
                  Pose cil à cil
                </p>
                <p className="mt-0.5 text-[13px] text-ink-soft">
                  10:30 · 1 h 30
                </p>
              </div>
            </div>
          </div>

          <div className="absolute right-0 bottom-0 w-[270px] animate-float overflow-hidden rounded-3xl bg-ink p-5 text-paper-raised shadow-[0_30px_60px_-28px_rgba(35,28,24,0.6)] [--tilt:4deg] [animation-delay:-4.5s]">
            <div className="pointer-events-none absolute -top-16 -right-16 size-44 rounded-full bg-[radial-gradient(circle_at_center,rgba(242,226,216,0.35),transparent_65%)]" />
            <div className="relative flex items-center justify-between text-[12px] text-paper-raised/70">
              <span>Ma fidélité</span>
              <SparkIcon size={16} />
            </div>
            <p className="relative mt-3 font-display text-[54px] leading-none tabular-nums">
              340{" "}
              <span className="text-[20px] text-paper-raised/70">points</span>
            </p>
            <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-paper-raised/15">
              <span className="block h-full w-[85%] rounded-full bg-accent-soft" />
            </div>
            <p className="relative mt-2 text-[12.5px] text-paper-raised/75">
              Plus que 60 points avant votre soin offert
            </p>
          </div>
        </div>
      </div>

      <figure className="relative max-w-md">
        <blockquote className="font-display text-[34px] leading-[1.1] tracking-[-0.01em] text-ink xl:text-[40px]">
          Tout ce que votre établissement partage avec vous,{" "}
          <em className="text-accent">en un coup d’œil.</em>
        </blockquote>
      </figure>
    </div>
  );
}
