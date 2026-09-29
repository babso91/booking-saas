"use client";

import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";

import { AlertIcon, CheckIcon } from "./icons";
import { Spinner } from "./spinner";

export type FieldStatus = "idle" | "checking" | "success" | "error";

type FieldFrameProps = {
  id: string;
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  status?: FieldStatus;
  counter?: { value: number; max: number };
  // Change this key to replay the "shake" on repeated invalid submits.
  shakeKey?: number;
  children: (ids: { describedBy?: string; invalid: boolean }) => ReactNode;
};

/**
 * Shared label / hint / error scaffolding. Messages are linked to the control
 * with aria-describedby and appear with a short slide, never as big red boxes.
 */
function FieldFrame({
  id,
  label,
  optional,
  hint,
  error,
  counter,
  shakeKey,
  children,
}: FieldFrameProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  const controlRef = useRef<HTMLDivElement>(null);
  const hasError = Boolean(error);

  // Replays a small shake on each invalid submit (Web Animations API keeps the
  // input mounted, so focus and caret are preserved).
  useEffect(() => {
    if (!shakeKey || !hasError || !controlRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    controlRef.current.animate(
      [
        { transform: "none" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(4px)" },
        { transform: "translateX(-3px)" },
        { transform: "translateX(2px)" },
        { transform: "none" },
      ],
      { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [shakeKey, hasError]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="text-[15px] font-medium tracking-[-0.005em] text-ink"
        >
          {label}
          {optional ? (
            <span className="ml-1.5 text-[13px] font-normal text-ink-muted">
              facultatif
            </span>
          ) : null}
        </label>
        {counter ? (
          <span
            className={cn(
              "text-xs tabular-nums transition-colors",
              counter.value > counter.max ? "text-danger" : "text-ink-muted",
            )}
            aria-hidden="true"
          >
            {counter.value}/{counter.max}
          </span>
        ) : null}
      </div>

      <div ref={controlRef}>{children({ describedBy, invalid: hasError })}</div>

      <div className="min-h-0">
        {error ? (
          <p
            id={errorId}
            className="flex animate-message items-start gap-1.5 text-[13.5px] leading-snug text-danger"
          >
            <AlertIcon size={16} className="mt-px shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
      {hint && !error ? (
        <p
          id={hintId}
          className="-mt-2 text-[13.5px] leading-snug text-ink-muted"
        >
          {hint}
        </p>
      ) : null}
      {hint && error ? (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const controlShell = cn(
  "group/control relative flex items-center rounded-2xl border bg-paper-raised",
  "transition-[border-color,box-shadow,background-color] duration-200 ease-soft",
);

const focusRing =
  "focus-within:border-ink focus-within:shadow-[0_0_0_4px_rgba(151,73,58,0.12)]";

function shellState(status: FieldStatus, invalid: boolean, disabled?: boolean) {
  if (disabled) return "border-line bg-sand/40 opacity-70";
  if (invalid || status === "error")
    return "border-danger/70 focus-within:border-danger focus-within:shadow-[0_0_0_4px_rgba(156,61,46,0.12)]";
  if (status === "success") return cn("border-success/60", focusRing);
  return cn("border-line hover:border-line-strong", focusRing);
}

function StatusAdornment({ status }: { status: FieldStatus }) {
  return (
    <span
      className="pointer-events-none flex size-6 items-center justify-center"
      aria-hidden="true"
    >
      {status === "checking" ? (
        <Spinner size={16} className="text-ink-muted" />
      ) : null}
      {status === "success" ? (
        <span className="flex size-6 animate-pop items-center justify-center rounded-full bg-success-soft text-success">
          <CheckIcon size={14} strokeWidth={2.2} />
        </span>
      ) : null}
    </span>
  );
}

export type TextFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id"
> & {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  status?: FieldStatus;
  prefix?: ReactNode;
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
  counterMax?: number;
  shakeKey?: number;
  id?: string;
  ref?: Ref<HTMLInputElement>;
};

export function TextField({
  label,
  optional,
  hint,
  error,
  status = "idle",
  prefix,
  leadingIcon,
  trailing,
  counterMax,
  shakeKey,
  id: providedId,
  className,
  disabled,
  value,
  "aria-describedby": extraDescribedBy,
  ...inputProps
}: TextFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const length = typeof value === "string" ? value.length : 0;

  return (
    <FieldFrame
      id={id}
      label={label}
      optional={optional}
      hint={hint}
      error={error}
      status={status}
      shakeKey={shakeKey}
      counter={counterMax ? { value: length, max: counterMax } : undefined}
    >
      {({ describedBy, invalid }) => (
        <div
          className={cn(controlShell, shellState(status, invalid, disabled))}
        >
          {leadingIcon ? (
            <span className="pl-4 text-ink-muted transition-colors group-focus-within/control:text-ink">
              {leadingIcon}
            </span>
          ) : null}
          {prefix ? (
            <span className="pl-4 text-[16px] whitespace-nowrap text-ink-muted select-none">
              {prefix}
            </span>
          ) : null}
          <input
            id={id}
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={
              [describedBy, extraDescribedBy].filter(Boolean).join(" ") ||
              undefined
            }
            className={cn(
              "field-control h-14 w-full min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-muted/70",
              "disabled:cursor-not-allowed",
              prefix ? "pl-0.5" : leadingIcon ? "pl-3" : "pl-4",
              "pr-4",
              className,
            )}
            {...inputProps}
          />
          {status !== "idle" && status !== "error" ? (
            <span className="pr-3">
              <StatusAdornment status={status} />
            </span>
          ) : null}
          {trailing ? <span className="pr-1.5">{trailing}</span> : null}
        </div>
      )}
    </FieldFrame>
  );
}

export type TextAreaFieldProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> & {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  counterMax?: number;
  id?: string;
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextAreaField({
  label,
  optional,
  hint,
  error,
  counterMax,
  id: providedId,
  className,
  value,
  disabled,
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const length = typeof value === "string" ? value.length : 0;

  return (
    <FieldFrame
      id={id}
      label={label}
      optional={optional}
      hint={hint}
      error={error}
      counter={counterMax ? { value: length, max: counterMax } : undefined}
    >
      {({ describedBy, invalid }) => (
        <div
          className={cn(controlShell, shellState("idle", invalid, disabled))}
        >
          <textarea
            id={id}
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={cn(
              "field-control min-h-28 w-full resize-none bg-transparent px-4 py-3.5 text-[16px] leading-relaxed text-ink placeholder:text-ink-muted/70 [field-sizing:content]",
              className,
            )}
            {...props}
          />
        </div>
      )}
    </FieldFrame>
  );
}
