"use client";

import Link from "next/link";
import { useId, useRef, useState, type MouseEvent } from "react";

import { useHeightTween } from "@/components/ui/motion";

import type { Suggestion, SuggestionTab } from "./suggestions";

/**
 * « Pour une page plus utile » (Higani point 124): folded to one line by
 * default, so it never stands between her and what she came to do. Each
 * idea leads to where it is filled in. Nothing when nothing is missing.
 */
export function SuggestionsCard({
  suggestions,
  onTab,
  onLeave,
}: {
  suggestions: Suggestion[];
  onTab: (tab: SuggestionTab) => void;
  /** On a link out of the studio: her draft is saved first. */
  onLeave: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // It unfolds and folds back, pushing what follows smoothly.
  const card = useRef<HTMLElement>(null);
  useHeightTween(card, open);
  if (!suggestions.length) return null;
  const count = suggestions.length;
  return (
    <section
      ref={card}
      aria-label="Pour une page plus utile"
      className="mb-4 rounded-2xl border border-black/10 bg-white"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 text-left"
      >
        <span className="min-w-0 flex-1 text-[14px] font-semibold">
          Pour une page plus utile{" "}
          <span className="font-normal text-black/55">
            · {count} {count > 1 ? "idées" : "idée"}
          </span>
        </span>
        <span aria-hidden="true" className="text-black/50">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div id={listId} className="border-t border-black/10 px-4 pt-3 pb-4">
          <p className="mb-3 text-[12.5px] leading-snug text-black/55">
            Rien n’est obligatoire : ta page se publie telle quelle.
          </p>
          <ul className="flex flex-col gap-3">
            {suggestions.map((item) => (
              <li key={item.id} className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">
                    {item.title}
                  </span>
                  <span className="block text-[12.5px] leading-snug text-black/55">
                    {item.why}
                  </span>
                </span>
                {"tab" in item.to ? (
                  <button
                    type="button"
                    onClick={() =>
                      onTab((item.to as { tab: SuggestionTab }).tab)
                    }
                    aria-label={`Compléter : ${item.title}`}
                    className="min-h-11 shrink-0 cursor-pointer rounded-full border border-black/15 px-3 text-[13px] font-medium hover:bg-black/5"
                  >
                    Compléter
                  </button>
                ) : (
                  <Link
                    href={item.to.href}
                    onClick={onLeave}
                    className="flex min-h-11 shrink-0 items-center rounded-full border border-black/15 px-3 text-[13px] font-medium hover:bg-black/5"
                  >
                    {item.to.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
