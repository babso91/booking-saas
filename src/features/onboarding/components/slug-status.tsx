import {
  AlertIcon,
  CheckIcon,
  InfoIcon,
  WifiOffIcon,
} from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

import type { SlugCheckState } from "../use-slug-check";

const copy = {
  checking: "Vérification…",
  available: "Disponible pour l’instant",
  taken: "Déjà utilisé",
  reserved: "Ce mot est réservé",
  unverified: "Vérification impossible pour le moment",
} as const;

/**
 * One-line, colour + icon + text status (never colour alone). Announced
 * politely to screen readers as it changes.
 */
export function SlugStatus({
  state,
  onRetry,
  id,
}: {
  state: SlugCheckState;
  onRetry: () => void;
  id: string;
}) {
  if (state.kind === "empty") {
    return <p id={id} className="min-h-6" aria-live="polite" />;
  }

  const tone =
    state.kind === "available"
      ? "text-success"
      : state.kind === "checking"
        ? "text-ink-muted"
        : state.kind === "unverified"
          ? "text-warning"
          : "text-danger";

  const icon =
    state.kind === "checking" ? (
      <Spinner size={15} />
    ) : state.kind === "available" ? (
      <span className="flex size-[18px] animate-pop items-center justify-center rounded-full bg-success text-paper-raised">
        <CheckIcon size={12} strokeWidth={2.6} />
      </span>
    ) : state.kind === "unverified" ? (
      <WifiOffIcon size={16} />
    ) : state.kind === "invalid" ? (
      <InfoIcon size={16} />
    ) : (
      <AlertIcon size={16} />
    );

  const label = state.kind === "invalid" ? state.message : copy[state.kind];

  return (
    <div id={id} aria-live="polite" className="flex min-h-6 flex-col gap-1">
      <p
        key={state.kind + label}
        className={cn(
          "flex animate-message items-center gap-2 text-[14px] font-medium",
          tone,
        )}
      >
        {icon}
        <span>{label}</span>
        {state.kind === "unverified" ? (
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer font-semibold text-ink underline decoration-line-strong underline-offset-4"
          >
            Réessayer
          </button>
        ) : null}
      </p>
      {state.kind === "available" ? (
        <p className="animate-message text-[13px] text-ink-muted">
          Il sera réservé pour toi à la création de ton espace.
        </p>
      ) : null}
      {state.kind === "unverified" ? (
        <p className="animate-message text-[13px] text-ink-muted">
          Tu peux continuer : on vérifiera de nouveau à la fin.
        </p>
      ) : null}
    </div>
  );
}
