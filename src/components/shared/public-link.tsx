"use client";

import { useRef, useState } from "react";

import { BookingHost } from "@/components/shared/booking-host";
import { cn } from "@/lib/cn";

/**
 * Her public page (/b/[slug]): her published site, or her booking page
 * while none is published. Clients book there without an account, so the
 * address is a real link she can open and copy to share.
 */
export function PublicLink({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const address = useRef<HTMLAnchorElement>(null);
  const path = `/b/${slug}`;

  async function copy() {
    try {
      // The origin she is on is the one her clients reach: no build variable.
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied("yes");
    } catch {
      // Clipboard refused: select the address so she can copy it by hand.
      const range = document.createRange();
      if (address.current) range.selectNodeContents(address.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 2500);
  }

  return (
    <div className={cn("flex flex-col gap-1.5 text-[13px]", className)}>
      <span className="text-ink-muted">Ta page, où tes clientes réservent</span>
      <a
        ref={address}
        href={path}
        target="_blank"
        rel="noopener"
        className="break-all text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
      >
        <BookingHost />
        {path}
        <span className="sr-only"> (s’ouvre dans un nouvel onglet)</span>
      </a>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="h-10 cursor-pointer rounded-full border border-line px-3.5 text-[13.5px] font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Copier le lien
        </button>
        <span role="status" className="text-[12.5px] text-ink-muted">
          {copied === "yes"
            ? "Lien copié"
            : copied === "failed"
              ? "Adresse sélectionnée : copie-la"
              : ""}
        </span>
      </div>
    </div>
  );
}
