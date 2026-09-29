import Link from "next/link";

import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";

// Monogram: an arc and a dot — a booked slot on the day's curve.
export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("inline-flex items-center gap-2.5 text-ink", className)}
      aria-label={`${brand.name} — accueil`}
    >
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
        {brand.name}
      </span>
    </Link>
  );
}
