"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ArrowRightIcon, CheckIcon, CopyIcon } from "@/components/ui/icons";
import { bookingHost, bookingUrl } from "@/lib/brand";
import { cn } from "@/lib/cn";

const petals = Array.from({ length: 10 }, (_, index) => index * 36);

/** Rendered by /app/welcome with the business read from the server session. */
export function OnboardingSuccess({
  slug,
  businessName,
}: {
  slug: string;
  businessName: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(bookingUrl(slug));
      setCopied(true);
    } catch {
      // Clipboard can be blocked; the link stays visible and selectable.
    }
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="relative flex size-28 items-center justify-center"
        aria-hidden="true"
      >
        {petals.map((angle, index) => (
          <span
            key={angle}
            className={cn(
              "petal absolute top-1/2 left-1/2 -mt-1 -ml-1 size-2 rounded-full",
              index % 3 === 0
                ? "bg-accent"
                : index % 3 === 1
                  ? "bg-line-strong"
                  : "bg-success",
            )}
            style={{
              ["--angle" as string]: `${angle}deg`,
              animationDelay: `${280 + index * 18}ms`,
            }}
          />
        ))}
        <svg width="96" height="96" viewBox="0 0 56 56" className="relative">
          <circle cx="28" cy="28" r="25" fill="var(--success-soft)" />
          <circle
            cx="28"
            cy="28"
            r="25"
            fill="none"
            stroke="var(--success)"
            strokeWidth="1.6"
            className="draw-ring"
            transform="rotate(-90 28 28)"
          />
          <path
            d="M18.5 28.5l6.3 6.3L38 21.5"
            fill="none"
            stroke="var(--success)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="draw-check"
            style={{ animationDelay: "420ms" }}
          />
        </svg>
      </div>

      <p className="mt-8 animate-rise text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase [animation-delay:300ms]">
        {businessName}
      </p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 animate-rise font-display text-[44px] leading-[1.02] tracking-[-0.015em] text-ink outline-none [animation-delay:360ms] sm:text-[54px]"
      >
        Ton espace est prêt.
      </h1>
      <p className="mt-4 max-w-[34ch] animate-rise text-[16px] leading-relaxed text-ink-soft [animation-delay:420ms]">
        Ajoute tes prestations et tes horaires, puis partage ton lien.
      </p>

      <div className="mt-8 flex w-full max-w-[420px] animate-rise items-center gap-2 rounded-2xl border border-line bg-paper-raised p-2 pl-4 [animation-delay:480ms]">
        <p className="min-w-0 flex-1 text-left text-[15px] leading-snug [overflow-wrap:anywhere] text-ink-muted">
          {bookingHost()}/b/
          <span className="font-semibold text-ink">{slug}</span>
        </p>
        <button
          type="button"
          onClick={copy}
          className={cn(
            "flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-medium transition-colors duration-200",
            copied
              ? "bg-success-soft text-success"
              : "bg-sand text-ink hover:bg-sand-deep",
          )}
        >
          {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          <span aria-live="polite">{copied ? "Copié" : "Copier"}</span>
        </button>
      </div>

      <Link
        href="/app"
        className="group mt-6 inline-flex h-14 w-full max-w-[420px] animate-rise items-center justify-center gap-2.5 rounded-2xl bg-ink text-base font-medium text-paper-raised shadow-[0_10px_24px_-12px_rgba(35,28,24,0.55)] transition-[background-color,transform] duration-200 [animation-delay:540ms] hover:bg-[#382d27] active:scale-[0.985]"
      >
        Accéder à mon espace
        <ArrowRightIcon
          size={18}
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      </Link>
    </div>
  );
}
