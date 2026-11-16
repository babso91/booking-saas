"use client";

import { useId, type Ref } from "react";

import { cn } from "@/lib/cn";

export const CODE_LENGTH = 8;

/** Digits of what was typed or pasted (« 1234 5678 », « 1234-5678 »). */
export const codeDigits = (value: string) =>
  value.replace(/\D/g, "").slice(0, CODE_LENGTH);

/**
 * The 8-digit code. One real input (one-time-code autofill, numeric keypad,
 * pasting a whole code, native editing and screen reader support) drawn as
 * eight cells in two groups of four. The cells are decoration only.
 */
export function CodeInput({
  value,
  onChange,
  disabled,
  readOnly,
  invalid,
  describedBy,
  inputRef,
  label,
}: {
  value: string;
  onChange: (digits: string) => void;
  disabled?: boolean;
  /** While a code is checked: focus stays here, nothing can be typed. */
  readOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
}) {
  const id = useId();
  const active = Math.min(value.length, CODE_LENGTH - 1);

  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={id} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <div className="group/code relative">
        <div
          aria-hidden="true"
          className="pointer-events-none flex items-center justify-between gap-1.5 sm:gap-2"
        >
          {Array.from({ length: CODE_LENGTH }, (_, index) => {
            const digit = value[index];
            const current = index === active && value.length < CODE_LENGTH;
            return (
              <span key={index} className="contents">
                {index === CODE_LENGTH / 2 ? (
                  <span className="h-0.5 w-2 shrink-0 rounded-full bg-line-strong sm:w-3" />
                ) : null}
                <span
                  className={cn(
                    "relative flex h-14 min-w-0 flex-1 items-center justify-center rounded-xl border bg-paper-raised font-display text-[28px] text-ink tabular-nums transition-[border-color,box-shadow,background-color] duration-200 sm:h-16 sm:rounded-2xl sm:text-[32px]",
                    disabled
                      ? "border-line bg-sand/40 text-ink-muted"
                      : invalid
                        ? "border-danger/60"
                        : digit
                          ? "border-line-strong"
                          : "border-line",
                    current &&
                      !disabled &&
                      "group-focus-within/code:border-ink group-focus-within/code:shadow-[0_0_0_4px_rgba(151,73,58,0.12)]",
                  )}
                >
                  {digit ? (
                    <span className="animate-pop">{digit}</span>
                  ) : current && !disabled ? (
                    <span className="hidden h-7 w-[2px] animate-pulse rounded-full bg-ink group-focus-within/code:block" />
                  ) : null}
                </span>
              </span>
            );
          })}
        </div>
        <input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(event) => onChange(codeDigits(event.target.value))}
          onFocus={(event) => {
            // Typing always continues at the end, like the cells show.
            const end = event.target.value.length;
            event.target.setSelectionRange(end, end);
          }}
          disabled={disabled}
          readOnly={readOnly}
          aria-busy={readOnly || undefined}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          // Room for a pasted « 1234 5678 »; the digits are kept only.
          maxLength={CODE_LENGTH + 4}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="field-control absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-[0.01] outline-none selection:bg-transparent disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
