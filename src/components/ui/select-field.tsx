"use client";

import { useId, type ReactNode, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

import { AlertIcon } from "./icons";

/** Native select styled like TextField: best keyboard and mobile support. */
export function SelectField({
  label,
  error,
  hint,
  children,
  className,
  id: providedId,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  id?: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            "h-14 w-full cursor-pointer appearance-none rounded-2xl border bg-paper-raised pr-11 pl-4 text-[16px] text-ink transition-[border-color,box-shadow] duration-200",
            "focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_rgba(151,73,58,0.12)] focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-sand/40 disabled:opacity-70",
            error ? "border-danger/70" : "border-line hover:border-line-strong",
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <svg
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink-muted"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {error ? (
        <p
          id={`${id}-error`}
          className="flex animate-message items-start gap-1.5 text-[13.5px] text-danger"
        >
          <AlertIcon size={16} className="mt-px shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13.5px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
