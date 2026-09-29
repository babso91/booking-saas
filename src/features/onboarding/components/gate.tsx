import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { LockIcon, SparkIcon, WifiOffIcon } from "@/components/ui/icons";

type GateKind = "unauthorized" | "onboarded" | "network";

const content: Record<
  GateKind,
  { icon: ReactNode; eyebrow: string; title: string; text: string }
> = {
  unauthorized: {
    icon: <LockIcon size={26} />,
    eyebrow: "Espace pro",
    title: "Connecte-toi pour continuer.",
    text: "Ta session a expiré ou tu n’es pas encore connectée. Tes réponses déjà saisies sont conservées sur cet appareil.",
  },
  onboarded: {
    icon: <SparkIcon size={26} />,
    eyebrow: "Tout est prêt",
    title: "Ton espace existe déjà.",
    text: "Ton activité est configurée. Tu peux modifier ces informations à tout moment depuis tes réglages.",
  },
  network: {
    icon: <WifiOffIcon size={26} />,
    eyebrow: "Connexion interrompue",
    title: "Impossible de charger ton espace.",
    text: "Vérifie ta connexion internet puis réessaie.",
  },
};

/** Full-page state used before or instead of the wizard. */
export function Gate({
  kind,
  onRetry,
}: {
  kind: GateKind;
  onRetry?: () => void;
}) {
  const { icon, eyebrow, title, text } = content[kind];

  return (
    <div className="mx-auto flex w-full max-w-[420px] animate-rise flex-col items-start gap-6">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-sand text-ink-soft">
        {icon}
      </span>
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
          {eyebrow}
        </p>
        <h1 className="font-display text-[40px] leading-[1.04] tracking-[-0.015em] text-ink">
          {title}
        </h1>
        <p className="text-[16px] leading-relaxed text-ink-soft">{text}</p>
      </div>
      <div className="flex w-full flex-col gap-3">
        {kind === "unauthorized" ? (
          <>
            <PrimaryLink href="/login">Se connecter</PrimaryLink>
            <Link
              href="/signup"
              className="py-2 text-center text-[15px] font-medium text-ink-soft underline-offset-4 hover:text-ink hover:underline"
            >
              Créer un compte
            </Link>
          </>
        ) : kind === "onboarded" ? (
          <PrimaryLink href="/app">Accéder à mon espace</PrimaryLink>
        ) : (
          <Button fullWidth onClick={onRetry}>
            Réessayer
          </Button>
        )}
      </div>
    </div>
  );
}

function PrimaryLink({
  href,
  children,
}: {
  href: "/login" | "/app";
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-14 w-full items-center justify-center rounded-2xl bg-ink text-base font-medium text-paper-raised shadow-[0_10px_24px_-12px_rgba(35,28,24,0.55)] transition-[background-color,transform] duration-200 hover:bg-[#382d27] active:scale-[0.985]"
    >
      {children}
    </Link>
  );
}

export function OnboardingSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[480px] animate-fade flex-col gap-8 [animation-delay:200ms]"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Chargement de ton espace…
      </span>
      <div className="grid grid-cols-4 gap-1.5">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="h-[3px] rounded-full bg-sand-deep" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <span className="h-3 w-28 animate-pulse rounded-full bg-sand-deep" />
        <span className="h-10 w-4/5 animate-pulse rounded-2xl bg-sand" />
        <span className="h-4 w-3/5 animate-pulse rounded-full bg-sand" />
      </div>
      <div className="flex flex-col gap-4">
        <span className="h-14 animate-pulse rounded-2xl bg-sand" />
        <span className="h-14 animate-pulse rounded-2xl bg-sand" />
      </div>
    </div>
  );
}
