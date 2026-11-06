"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { ArrowRightIcon } from "@/components/ui/icons";
import { PasswordField } from "@/components/ui/password-field";
import { completeInvitationAction } from "@/features/auth/actions/auth";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  firstFieldErrors,
  PASSWORD_MIN_LENGTH,
  signUpSchema,
  type FieldErrors,
} from "@/features/auth/schemas";

import { AuthHeading } from "./auth-heading";
import { ErrorNotice } from "./error-notice";

const passwordOnly = signUpSchema.pick({ password: true });

/**
 * After the link sent to her address (an account existed already for it):
 * she chooses her password, and her invitation is activated.
 */
export function InvitationPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<"password">>({});
  const [formError, setFormError] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [shakeKey, setShakeKey] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== "idle") return;

    const parsed = passwordOnly.safeParse({ password });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors<"password">(parsed.error));
      setShakeKey((key) => key + 1);
      passwordRef.current?.focus();
      return;
    }

    setFormError(null);
    setState("loading");
    const result = await callAction(() =>
      completeInvitationAction(parsed.data),
    );
    if (!result.ok) {
      setState("idle");
      if (result.error.code === "validation_error") {
        setFieldErrors({
          password: `Mot de passe trop simple : au moins ${PASSWORD_MIN_LENGTH} caractères variés.`,
        });
        setShakeKey((key) => key + 1);
        passwordRef.current?.focus();
        return;
      }
      setFormError(result.error);
      return;
    }

    setState("success");
    const destination = result.data.next;
    window.setTimeout(() => router.replace(destination), 450);
  }

  return (
    <div className="flex flex-col gap-9">
      <AuthHeading eyebrow="Ton invitation" title="Choisis ton mot de passe.">
        Ton adresse est confirmée. Choisis le mot de passe de ton compte, puis
        on prépare ton espace.
      </AuthHeading>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex animate-rise flex-col gap-5 [animation-delay:60ms]"
      >
        {formError ? (
          <ErrorNotice
            error={formError}
            action={
              formError.code === "invitation_invalid" ||
              formError.code === "beta_invitation_required" ||
              formError.code === "unauthenticated" ? (
                <Link
                  href="/login"
                  className="text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                >
                  Me connecter
                </Link>
              ) : undefined
            }
          />
        ) : null}

        <PasswordField
          ref={passwordRef}
          label="Nouveau mot de passe"
          name="password"
          autoComplete="new-password"
          enterKeyHint="go"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldErrors.password) setFieldErrors({});
          }}
          error={fieldErrors.password}
          hint={`Au moins ${PASSWORD_MIN_LENGTH} caractères.`}
          showStrength
          shakeKey={shakeKey}
          disabled={state === "success"}
        />

        <Button
          type="submit"
          fullWidth
          state={state}
          loadingLabel="Activation…"
          successLabel="Invitation activée"
          icon={<ArrowRightIcon size={18} />}
          className="mt-1"
        >
          Activer mon invitation
        </Button>

        <p className="sr-only" role="status" aria-live="polite">
          {state === "loading"
            ? "Activation en cours"
            : state === "success"
              ? "Invitation activée. Passage à la configuration de ton espace."
              : ""}
        </p>
      </form>
    </div>
  );
}
