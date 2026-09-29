"use client";

import { useState, type KeyboardEvent } from "react";

import { passwordStrength } from "@/features/auth/schemas";
import { cn } from "@/lib/cn";

import { TextField, type TextFieldProps } from "./field";
import { EyeIcon, EyeOffIcon, LockIcon } from "./icons";

type PasswordFieldProps = Omit<TextFieldProps, "type" | "trailing"> & {
  showStrength?: boolean;
};

const strengthCopy = ["Trop court", "Correct", "Solide", "Excellent"] as const;

export function PasswordField({
  showStrength,
  hint,
  value,
  onKeyUp,
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const password = typeof value === "string" ? value : "";
  const strength = passwordStrength(password);

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState?.("CapsLock") ?? false);
    onKeyUp?.(event);
  };

  const computedHint = capsLock ? (
    <span className="text-warning">Majuscules activées.</span>
  ) : showStrength && password.length > 0 ? (
    <span className="flex items-center gap-2.5">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className={cn(
              "h-1 w-7 rounded-full transition-colors duration-300",
              strength > index
                ? strength === 1
                  ? "bg-warning"
                  : "bg-success"
                : "bg-sand-deep",
            )}
          />
        ))}
      </span>
      <span>{strengthCopy[strength]}</span>
    </span>
  ) : (
    hint
  );

  return (
    <TextField
      {...props}
      value={value}
      type={visible ? "text" : "password"}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      leadingIcon={<LockIcon size={19} />}
      hint={computedHint}
      onKeyUp={handleKey}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={
            visible ? "Masquer le mot de passe" : "Afficher le mot de passe"
          }
          aria-pressed={visible}
          className="flex size-11 cursor-pointer items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-sand/70 hover:text-ink"
        >
          <span className="relative size-5">
            <EyeIcon
              className={cn(
                "absolute inset-0 transition-[opacity,transform] duration-200",
                visible ? "scale-75 opacity-0" : "opacity-100",
              )}
            />
            <EyeOffIcon
              className={cn(
                "absolute inset-0 transition-[opacity,transform] duration-200",
                visible ? "opacity-100" : "scale-75 opacity-0",
              )}
            />
          </span>
        </button>
      }
    />
  );
}
