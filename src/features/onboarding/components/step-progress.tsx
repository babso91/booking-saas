"use client";

import { cn } from "@/lib/cn";

export type StepMeta = { id: string; label: string };

/**
 * Four segments that fill as the user advances. Completed steps are buttons
 * so the user can jump back; the current one carries aria-current="step".
 */
export function StepProgress({
  steps,
  current,
  onSelect,
  disabled,
}: {
  steps: StepMeta[];
  current: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  const remaining = steps.length - current - 1;

  return (
    <nav
      aria-label="Progression de la configuration"
      className="flex flex-col gap-3"
    >
      <ol
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        }}
      >
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step.id} className="min-w-0">
              <button
                type="button"
                disabled={!done || disabled}
                onClick={() => onSelect(index)}
                aria-current={active ? "step" : undefined}
                aria-label={`Étape ${index + 1} : ${step.label}${done ? " (terminée, revenir)" : active ? " (en cours)" : ""}`}
                className={cn(
                  "group/segment flex w-full flex-col gap-2 py-2 text-left disabled:cursor-default",
                  done && "cursor-pointer",
                )}
              >
                <span className="relative h-[3px] w-full overflow-hidden rounded-full bg-sand-deep">
                  <span
                    className={cn(
                      "absolute inset-0 origin-left rounded-full transition-[transform,background-color] duration-500 ease-soft",
                      done
                        ? "scale-x-100 bg-ink group-hover/segment:bg-accent"
                        : active
                          ? "scale-x-100 bg-accent"
                          : "scale-x-0 bg-accent",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    "hidden truncate text-[12.5px] transition-colors duration-300 sm:block",
                    active
                      ? "font-medium text-ink"
                      : done
                        ? "text-ink-soft group-hover/segment:text-ink"
                        : "text-ink-muted",
                  )}
                >
                  {step.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="flex items-center justify-between text-[13px] text-ink-muted sm:hidden">
        <span>
          <span className="font-medium text-ink">Étape {current + 1}</span> sur{" "}
          {steps.length}
        </span>
        <span key={remaining} className="animate-fade">
          {remaining === 0
            ? "Dernière étape"
            : `Encore ${remaining} étape${remaining > 1 ? "s" : ""}`}
        </span>
      </p>
    </nav>
  );
}
