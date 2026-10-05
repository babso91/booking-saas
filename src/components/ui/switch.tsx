import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * On/off switch: a native checkbox with the switch role (keyboard, label and
 * form semantics come for free), drawn as a track and a thumb. State is also
 * carried by position, never by colour alone.
 */
export function Switch({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input
        type="checkbox"
        role="switch"
        className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className="h-7 w-12 rounded-full border border-line-strong/70 bg-sand-deep/60 transition-colors duration-200 ease-soft peer-checked:border-ink peer-checked:bg-ink peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-paper-raised peer-disabled:opacity-50"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1 left-1 size-5 rounded-full bg-paper-raised shadow-[0_1px_3px_rgba(35,28,24,0.25)] transition-transform duration-200 ease-soft peer-checked:translate-x-5"
      />
    </span>
  );
}
