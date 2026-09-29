"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ArrowRightIcon, MailIcon } from "@/components/ui/icons";
import { PasswordField } from "@/components/ui/password-field";
import { signUpAction } from "@/features/auth/actions/auth";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  firstFieldErrors,
  PASSWORD_MIN_LENGTH,
  signUpSchema,
  type FieldErrors,
} from "@/features/auth/schemas";

import { AuthHeading } from "./auth-heading";
import { CheckEmail } from "./check-email";
import { ErrorNotice } from "./error-notice";

type Field = "email" | "password";

/**
 * Email + password only: the show/hide toggle replaces a confirmation field,
 * which mostly adds friction on mobile keyboards.
 */
export function SignupForm() {
  const router = useRouter();
  const [values, setValues] = useState({ email: "", password: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [shakeKey, setShakeKey] = useState(0);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (sentTo) headingRef.current?.focus({ preventScroll: true });
  }, [sentTo]);

  const update = (field: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    if (fieldErrors[field]) {
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== "idle") return;

    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) {
      const errors = firstFieldErrors<Field>(parsed.error);
      setFieldErrors(errors);
      setShakeKey((key) => key + 1);
      (errors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setFormError(null);
    setState("loading");

    const result = await callAction(() => signUpAction(parsed.data));

    if (!result.ok) {
      setState("idle");
      const rejected = result.error.fieldErrors ?? {};
      if (
        result.error.code === "validation_error" &&
        (rejected.password || rejected.email)
      ) {
        setFieldErrors({
          email: rejected.email ? "Cet email semble invalide." : undefined,
          password: rejected.password
            ? `Mot de passe trop simple : au moins ${PASSWORD_MIN_LENGTH} caractères variés.`
            : undefined,
        });
        setShakeKey((key) => key + 1);
        (rejected.email ? emailRef : passwordRef).current?.focus();
        return;
      }
      setFormError(result.error);
      return;
    }

    if (result.data.status === "confirmation_required") {
      setState("idle");
      setSentTo(result.data.email);
      return;
    }

    // signed_in: a session exists, onboarding is next.
    setState("success");
    const destination = result.data.next ?? "/onboarding";
    window.setTimeout(() => router.replace(destination), 450);
  }

  // Signing up again with a still-unconfirmed address re-sends the
  // confirmation email (backend contract). Same credentials, still in memory.
  async function resend(): Promise<boolean> {
    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) return false;
    const result = await callAction(() => signUpAction(parsed.data));
    return result.ok && result.data.status === "confirmation_required";
  }

  if (sentTo) {
    return (
      <CheckEmail
        email={sentTo}
        headingRef={headingRef}
        onResend={resend}
        onChangeEmail={() => {
          setSentTo(null);
          window.setTimeout(() => emailRef.current?.focus(), 0);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-9">
      <AuthHeading
        eyebrow="Créer mon espace"
        title={
          <>
            Ton activité, <em className="text-accent">joliment</em> organisée.
          </>
        }
      >
        Deux minutes pour créer ton compte, puis on prépare ta page de
        réservation ensemble.
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
              formError.code === "email_taken" ? (
                <Link
                  href="/login"
                  className="text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                >
                  Me connecter
                </Link>
              ) : formError.code === "network" ? (
                <button
                  type="submit"
                  className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                >
                  Réessayer
                </button>
              ) : undefined
            }
          />
        ) : null}

        <TextField
          ref={emailRef}
          label="Email professionnel"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="toi@exemple.fr"
          leadingIcon={<MailIcon size={19} />}
          value={values.email}
          onChange={update("email")}
          error={fieldErrors.email}
          shakeKey={shakeKey}
          disabled={state === "success"}
        />

        <PasswordField
          ref={passwordRef}
          label="Mot de passe"
          name="password"
          autoComplete="new-password"
          enterKeyHint="go"
          value={values.password}
          onChange={update("password")}
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
          loadingLabel="Création du compte…"
          successLabel="Compte créé"
          icon={<ArrowRightIcon size={18} />}
          className="mt-1"
        >
          Créer mon compte
        </Button>

        <p className="sr-only" role="status" aria-live="polite">
          {state === "loading"
            ? "Création du compte en cours"
            : state === "success"
              ? "Compte créé. Passage à la configuration de ton espace."
              : ""}
        </p>
      </form>

      <p className="animate-rise text-center text-[15px] text-ink-soft [animation-delay:120ms]">
        Déjà un compte ?{" "}
        <Link
          href="/login"
          className="font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-ink"
        >
          Se connecter
        </Link>
      </p>
    </div>
  );
}
