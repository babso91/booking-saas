"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ArrowRightIcon, MailIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { PasswordField } from "@/components/ui/password-field";
import { signInAction } from "@/features/auth/actions/auth";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  firstFieldErrors,
  signInSchema,
  type FieldErrors,
} from "@/features/auth/schemas";

import { AuthHeading } from "./auth-heading";
import { ErrorNotice } from "./error-notice";

type Field = "email" | "password";

export function LoginForm({
  callbackFailed = false,
}: {
  callbackFailed?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ email: "", password: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<UiError | null>(null);
  const [showCallbackError, setShowCallbackError] = useState(callbackFailed);
  const [state, setState] = useState<ButtonState>("idle");
  const [shakeKey, setShakeKey] = useState(0);
  const [showForgot, setShowForgot] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const update = (field: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    if (fieldErrors[field]) {
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== "idle") return;

    const parsed = signInSchema.safeParse(values);
    if (!parsed.success) {
      const errors = firstFieldErrors<Field>(parsed.error);
      setFieldErrors(errors);
      setShakeKey((key) => key + 1);
      (errors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setFormError(null);
    setShowCallbackError(false);
    setState("loading");

    const result = await callAction(() => signInAction(parsed.data));

    if (!result.ok) {
      setState("idle");
      setFormError(result.error);
      if (result.error.code === "invalid_credentials") {
        setShakeKey((key) => key + 1);
        passwordRef.current?.select();
      }
      return;
    }

    // The server decides where this account goes ("/onboarding" or "/app");
    // the route guards confirm it on arrival.
    setState("success");
    const destination = result.data.next;
    window.setTimeout(() => router.replace(destination), 450);
  }

  return (
    <div className="flex flex-col gap-9">
      <AuthHeading eyebrow="Espace pro" title="Bon retour.">
        Connecte-toi pour retrouver ton agenda et tes clientes.
      </AuthHeading>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex animate-rise flex-col gap-5 [animation-delay:60ms]"
        aria-describedby={formError ? "login-error" : undefined}
      >
        {showCallbackError && !formError ? (
          <Notice tone="warning" title="Lien expiré ou déjà utilisé">
            Ce lien de confirmation ne fonctionne plus. Connecte-toi : si ton
            email n’est pas encore confirmé, on te le dira.
          </Notice>
        ) : null}

        {formError ? (
          <div id="login-error">
            <ErrorNotice
              error={formError}
              action={
                formError.code === "network" ? (
                  <button
                    type="submit"
                    className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                  >
                    Réessayer
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        <TextField
          ref={emailRef}
          label="Email"
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

        <div className="flex flex-col gap-2">
          <PasswordField
            ref={passwordRef}
            label="Mot de passe"
            name="password"
            autoComplete="current-password"
            enterKeyHint="go"
            value={values.password}
            onChange={update("password")}
            error={fieldErrors.password}
            shakeKey={shakeKey}
            disabled={state === "success"}
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowForgot((current) => !current)}
              aria-expanded={showForgot}
              aria-controls="forgot-password-note"
              className="-mr-2 cursor-pointer rounded-lg px-2 py-1.5 text-[14px] text-ink-soft underline-offset-4 hover:text-ink hover:underline"
            >
              Mot de passe oublié ?
            </button>
          </div>
          <div id="forgot-password-note">
            {showForgot ? (
              <Notice tone="info">
                La réinitialisation en ligne arrive très bientôt. En attendant,
                contacte le support pour récupérer ton accès.
              </Notice>
            ) : null}
          </div>
        </div>

        <Button
          type="submit"
          fullWidth
          state={state}
          loadingLabel="Connexion…"
          successLabel="Bienvenue"
          icon={<ArrowRightIcon size={18} />}
          className="mt-1"
        >
          Se connecter
        </Button>

        <p className="sr-only" role="status" aria-live="polite">
          {state === "loading"
            ? "Connexion en cours"
            : state === "success"
              ? "Connectée. Redirection vers ton espace."
              : ""}
        </p>
      </form>

      <p className="animate-rise text-center text-[15px] text-ink-soft [animation-delay:120ms]">
        Pas encore de compte ?{" "}
        <Link
          href="/signup"
          className="font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-ink"
        >
          Crée ton espace
        </Link>
      </p>
    </div>
  );
}
