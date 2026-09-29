import Link from "next/link";
import type { Ref } from "react";

import { Button } from "@/components/ui/button";

export function CheckEmail({
  email,
  headingRef,
  onChangeEmail,
}: {
  email: string;
  headingRef: Ref<HTMLHeadingElement>;
  onChangeEmail: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-8">
      <Envelope />

      <div className="flex animate-rise flex-col gap-3 [animation-delay:80ms]">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
          Presque terminé
        </p>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-[42px] leading-[1.02] tracking-[-0.015em] text-ink outline-none sm:text-[48px]"
        >
          Vérifie ta boîte mail.
        </h1>
        <p className="text-[16px] leading-relaxed text-ink-soft">
          Un lien d’activation vient de partir vers :
        </p>
        <p className="w-fit max-w-full rounded-xl bg-sand px-3 py-2 text-[15px] font-semibold [overflow-wrap:anywhere] text-ink">
          {email}
        </p>
        <p className="text-[16px] leading-relaxed text-ink-soft">
          Ouvre-le sur cet appareil pour continuer.
        </p>
      </div>

      <div className="flex w-full animate-rise flex-col gap-3 [animation-delay:140ms]">
        <Link
          href="/login"
          className="inline-flex h-14 w-full items-center justify-center rounded-2xl bg-ink text-base font-medium text-paper-raised shadow-[0_10px_24px_-12px_rgba(35,28,24,0.55)] transition-[background-color,transform] duration-200 hover:bg-[#382d27] active:scale-[0.985]"
        >
          J’ai confirmé, me connecter
        </Link>
        <Button variant="ghost" size="md" fullWidth onClick={onChangeEmail}>
          Modifier l’adresse email
        </Button>
      </div>

      <p className="animate-rise text-[14px] leading-relaxed text-ink-muted [animation-delay:200ms]">
        Rien après quelques minutes ? Jette un œil aux spams ou aux promotions.
      </p>
    </div>
  );
}

function Envelope() {
  return (
    <div className="relative animate-pop" aria-hidden="true">
      <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-[radial-gradient(circle,rgba(151,73,58,0.16),transparent_65%)]" />
      <svg width="84" height="84" viewBox="0 0 84 84">
        <rect
          x="6"
          y="18"
          width="72"
          height="50"
          rx="12"
          fill="var(--paper-raised)"
          stroke="var(--line-strong)"
          strokeWidth="1.5"
        />
        <path
          d="M10 24l32 22 32-22"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="68" cy="20" r="9" fill="var(--accent)" />
        <path
          d="M64 20.3l2.8 2.8 5-5.4"
          fill="none"
          stroke="var(--paper-raised)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="draw-check"
        />
      </svg>
    </div>
  );
}
