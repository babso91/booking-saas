"use client";

import { useId, useRef, useState, type ReactNode } from "react";

import { useHeightTween } from "@/components/ui/motion";

import { Note } from "./engine";

// Higani point 18: the essentials first, the details at hand without being
// imposed. A long text of hers (her portrait, a practical detail, one of
// her sections) shows its first lines, then « Lire la suite »; her line
// breaks are kept. Folding is visual only: the whole text stays in the
// page, read whole by a screen reader and found by a search in the page.

const CLAMPS = {
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;
export type FoldLines = keyof typeof CLAMPS;

/**
 * Whether a text would run past `lines` lines of about `perLine`
 * characters (each of her line breaks starting a new one), with one line
 * of slack: a toggle that would reveal a single line is not worth it.
 */
export function foldsAt(text: string, lines: number, perLine: number) {
  const shown = text
    .trim()
    .split("\n")
    .reduce(
      (count, paragraph) =>
        count + Math.max(1, Math.ceil(paragraph.length / perLine)),
      0,
    );
  return shown > lines + 1;
}

export function FoldedText({
  text,
  lines,
  perLine,
  long,
  className = "",
  align = "start",
  children,
}: {
  text: string;
  /** How the text is set (her display face…); `text` when absent. */
  children?: ReactNode;
  /** The toggle's place under a centred text. */
  align?: "start" | "center";
  /** The lines shown while folded. */
  lines: FoldLines;
  /** About how many characters fit on a line, on a phone. */
  perLine?: number;
  /** Decided by the caller (her services' rule); else from the length. */
  long?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const folds = long ?? foldsAt(text, lines, perLine ?? 40);
  const box = useRef<HTMLParagraphElement>(null);
  useHeightTween(box, open);
  return (
    <>
      <p
        ref={box}
        id={id}
        className={`${className} whitespace-pre-line ${folds && !open ? CLAMPS[lines] : ""}`}
      >
        {children ?? text}
      </p>
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={`mt-1 min-h-11 cursor-pointer underline underline-offset-4 ${align === "center" ? "self-center" : "self-start"}`}
        >
          <Note>{open ? "Réduire" : "Lire la suite"}</Note>
        </button>
      ) : null}
    </>
  );
}
