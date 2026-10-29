import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { CheckIcon } from "./icons";
import { Spinner } from "./spinner";

export type ButtonState = "idle" | "loading" | "success";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  state?: ButtonState;
  // Labels announced and shown while loading / after success.
  loadingLabel?: string;
  successLabel?: string;
  icon?: ReactNode;
  fullWidth?: boolean;
};

// Every state is drawn from the palette's tokens, never a fixed colour: a
// hover tuned for ivory is unreadable on espresso. Checked in every style,
// ambiance and mode by button-contrast.test.ts (4.5:1, text on background).
// Disabled: a quiet ground, still legible (the reason it is off is said
// around it, not hidden in a faint label).
export const buttonVariants = {
  primary:
    "bg-ink text-paper-raised shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_10px_24px_-12px_rgb(var(--shadow-rgb)/0.55)] hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--paper))] disabled:bg-sand disabled:text-ink-soft disabled:shadow-none",
  secondary:
    "bg-paper-raised text-ink border border-line hover:border-line-strong hover:bg-[color-mix(in_srgb,var(--paper-raised)_94%,var(--ink))] disabled:text-ink-muted",
  ghost:
    "bg-transparent text-ink-soft hover:text-ink hover:bg-sand/60 disabled:text-ink-muted",
  danger:
    "bg-danger text-paper-raised hover:bg-danger-strong disabled:bg-sand disabled:text-ink-soft disabled:shadow-none shadow-[0_10px_24px_-14px_color-mix(in_srgb,var(--danger)_60%,transparent)]",
} as const;

const sizes = {
  md: "h-11 px-4 text-[15px] rounded-xl gap-2",
  lg: "h-14 px-6 text-base rounded-2xl gap-2.5",
} as const;

/**
 * Button with real states: the label cross-fades to a spinner while loading
 * and to a drawn check on success, without changing width.
 */
export function Button({
  variant = "primary",
  size = "lg",
  state = "idle",
  loadingLabel,
  successLabel,
  icon,
  fullWidth,
  className,
  children,
  disabled,
  type = "button",
  onClick,
  ...props
}: ButtonProps) {
  const busy = state !== "idle";

  // While busy the button stays focusable (focus is not lost mid-action) but
  // cannot be activated by pointer or keyboard: the click, and for submit
  // buttons the form submission, are cancelled.
  const handleClick: ButtonHTMLAttributes<HTMLButtonElement>["onClick"] = (
    event,
  ) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      type={type}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={state === "loading" || undefined}
      data-state={state}
      className={cn(
        "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center font-medium tracking-[-0.005em] whitespace-nowrap select-none",
        "transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-soft",
        "active:scale-[0.985] disabled:cursor-not-allowed disabled:active:scale-100",
        busy && "pointer-events-none",
        state === "success" && variant === "primary"
          ? "bg-success text-paper-raised"
          : buttonVariants[variant],
        sizes[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
      onClick={handleClick}
    >
      <span
        className={cn(
          "inline-flex items-center gap-[inherit] transition-[opacity,transform] duration-200 ease-soft",
          busy && "-translate-y-1 opacity-0",
        )}
      >
        {children}
        {icon ? (
          <span className="transition-transform duration-200 ease-soft group-hover/button:translate-x-0.5">
            {icon}
          </span>
        ) : null}
      </span>

      <span
        aria-hidden={state !== "loading"}
        className={cn(
          "absolute inset-0 inline-flex items-center justify-center gap-2 transition-[opacity,transform] duration-200 ease-soft",
          state === "loading"
            ? "opacity-100"
            : "pointer-events-none translate-y-1 opacity-0",
        )}
      >
        <Spinner />
        {loadingLabel ? <span>{loadingLabel}</span> : null}
      </span>

      <span
        aria-hidden={state !== "success"}
        className={cn(
          "absolute inset-0 inline-flex items-center justify-center gap-2 transition-opacity duration-200",
          state === "success" ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {state === "success" ? (
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M5 12.5l4.2 4.2L19 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="draw-check"
            />
          </svg>
        ) : (
          <CheckIcon />
        )}
        {successLabel ? <span>{successLabel}</span> : null}
      </span>
    </button>
  );
}
