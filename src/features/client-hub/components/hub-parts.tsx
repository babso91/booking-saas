import type { ReactNode } from "react";

import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import type { HubError } from "../client/api";
import { dateParts } from "../client/format";

// Shared pieces of the customer's hub. Copy in the customer's "vous" voice.

const errorCopy: Partial<
  Record<HubError["code"], { title: string; message: string }>
> = {
  network: {
    title: "Connexion interrompue",
    message:
      "Impossible de joindre le serveur. Vérifiez votre connexion internet puis réessayez.",
  },
  client_hub_unavailable: {
    title: "Espace momentanément indisponible",
    message:
      "Votre espace ne peut pas être affiché pour le moment. Merci de réessayer plus tard.",
  },
  client_hub_not_found: {
    title: "Introuvable",
    message:
      "Cet élément n’existe pas ou n’est pas accessible depuis votre espace.",
  },
  rate_limited: {
    title: "Un instant",
    message:
      "Trop de demandes d’affilée. Patientez quelques minutes avant de réessayer.",
  },
};

export function hubErrorCopy(error: HubError) {
  return (
    errorCopy[error.code] ?? {
      title: "Petit contretemps",
      message: "Une erreur inattendue est survenue. Merci de réessayer.",
    }
  );
}

export const linkButton =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-50";

/** A read that failed: plain words and a retry. */
export function HubErrorNotice({
  error,
  onRetry,
  children,
}: {
  error: HubError;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const copy = hubErrorCopy(error);
  return (
    <Notice
      tone={error.code === "network" ? "offline" : "error"}
      title={copy.title}
      action={
        onRetry ? (
          <button type="button" onClick={onRetry} className={linkButton}>
            Réessayer
          </button>
        ) : undefined
      }
    >
      {children ?? copy.message}
    </Notice>
  );
}

const pillTones = {
  accent: "bg-accent-soft text-accent-strong",
  success: "bg-success-soft text-success",
  muted: "bg-sand text-ink-soft",
  danger: "bg-danger-soft text-danger",
  dark: "bg-paper-raised/12 text-paper-raised",
} as const;

export function Pill({
  tone,
  children,
  className,
}: {
  tone: keyof typeof pillTones;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold tracking-[0.01em] whitespace-nowrap",
        pillTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The day of an appointment, like a page torn from a desk calendar. */
export function DateTile({
  iso,
  timeZone,
  muted,
  size = "md",
}: {
  iso: string;
  timeZone: string;
  muted?: boolean;
  size?: "md" | "lg";
}) {
  const parts = dateParts(iso, timeZone);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 flex-col items-center justify-center overflow-hidden rounded-2xl border text-center",
        size === "lg" ? "w-[76px] py-2.5" : "w-[60px] py-2",
        muted
          ? "border-line bg-sand/50 text-ink-soft"
          : "border-accent/15 bg-accent-soft/60 text-accent-strong",
      )}
    >
      <span className="text-[11px] font-semibold tracking-[0.12em] uppercase">
        {parts.weekday}
      </span>
      <span
        className={cn(
          "font-display leading-none tabular-nums",
          size === "lg" ? "text-[38px]" : "text-[30px]",
          muted ? "text-ink-soft" : "text-ink",
        )}
      >
        {parts.day}
      </span>
      <span className="text-[11.5px] font-medium">{parts.month}</span>
    </span>
  );
}

export function SectionHeading({
  id,
  title,
  aside,
}: {
  id?: string;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <h2
        id={id}
        className="font-display text-[26px] leading-tight tracking-[-0.01em] text-ink"
      >
        {title}
      </h2>
      {aside}
    </div>
  );
}

/** A calm empty state: what it means, and the next useful step. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[26px] border border-dashed border-line-strong/70 bg-paper-raised/60 px-5 py-7 sm:px-7">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-sand text-ink-soft">
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[16px] font-semibold text-ink">{title}</p>
        {children ? (
          <p className="max-w-prose text-[14.5px] leading-relaxed text-ink-soft">
            {children}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block overflow-hidden rounded-xl bg-sand/70",
        "after:absolute after:inset-0 after:animate-progress after:bg-[linear-gradient(90deg,transparent,rgba(255,252,248,0.65),transparent)]",
        className,
      )}
    />
  );
}

/** Announced once to assistive technologies, shown as a skeleton. */
export function Loading({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** "Afficher plus" of a paginated list, with its own states. */
export function MoreButton({
  state,
  onMore,
  label,
}: {
  state: "idle" | "loading" | HubError;
  onMore: () => void;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 pt-1">
      {typeof state === "object" ? (
        <HubErrorNotice error={state}>
          La suite n’a pas pu être chargée.
        </HubErrorNotice>
      ) : null}
      <button
        type="button"
        onClick={onMore}
        aria-busy={state === "loading" || undefined}
        disabled={state === "loading"}
        className="h-11 cursor-pointer rounded-full border border-line bg-paper-raised px-5 text-[14.5px] font-medium text-ink transition-colors hover:border-line-strong disabled:cursor-wait disabled:opacity-60"
      >
        {state === "loading"
          ? "Chargement…"
          : typeof state === "object"
            ? "Réessayer"
            : label}
      </button>
    </div>
  );
}
