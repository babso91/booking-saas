"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type ChoiceChipsProps<T extends string | number> = {
  legend: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
};

/**
 * Single-choice group rendered as chips. Native radio inputs keep keyboard
 * (arrow keys) and screen reader semantics for free.
 */
export function ChoiceChips<T extends string | number>({
  legend,
  description,
  icon,
  name,
  value,
  options,
  onChange,
}: ChoiceChipsProps<T>) {
  const descriptionId = useId();

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      aria-describedby={description ? descriptionId : undefined}
    >
      <legend className="flex items-start gap-3">
        {icon ? (
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-sand text-ink-soft">
            {icon}
          </span>
        ) : null}
        <span className="flex flex-col gap-1">
          <span className="text-[15px] leading-snug font-medium text-ink">
            {legend}
          </span>
          {description ? (
            <span
              id={descriptionId}
              className="text-[13.5px] leading-snug text-ink-muted"
            >
              {description}
            </span>
          ) : null}
        </span>
      </legend>

      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={String(option.value)}
              className={cn(
                "relative flex h-11 cursor-pointer items-center rounded-full border px-4 text-[15px] transition-[background-color,border-color,color,transform] duration-200 ease-soft select-none active:scale-[0.97]",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                checked
                  ? "border-ink bg-ink text-paper-raised"
                  : "border-line bg-paper-raised text-ink-soft hover:border-line-strong hover:text-ink",
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(option.value)}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
