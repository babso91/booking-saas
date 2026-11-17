"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { ArrowRightIcon } from "@/components/ui/icons";
import { PasswordField } from "@/components/ui/password-field";
import { AuthHeading } from "@/features/auth/components/auth-heading";
import { ErrorNotice } from "@/features/auth/components/error-notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { PASSWORD_MIN_LENGTH } from "@/features/auth/schemas";
import {
  acceptTeamInviteAction,
  completeTeamInviteAction,
} from "@/features/team/actions/team";

/**
 * `/equipe/invitation` (docs/TEAM_CONTRACT.md, « Rejoindre l'équipe »).
 * The invitation never proves the account is hers: the server accepts it
 * only from a session that proved its password, or once she chose hers
 * after a recovery link. This page only routes her:
 * - not signed in: create her account or sign in, with the token;
 * - signed in: one explicit tap to join (it closes her other sessions);
 * - asked for a password: her own, then she joins.
 * The token is taken off the address bar as soon as it is read.
 */

const PASSWORD_MIN = PASSWORD_MIN_LENGTH;

export function TeamJoin({
  token,
  signedIn,
}: {
  /** From the link; absent after an email confirmation (kept server-side). */
  token: string | null;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<ButtonState>("idle");
  const [error, setError] = useState<UiError | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Off the visible address (and its history entry) once read.
    if (token) window.history.replaceState(null, "", "/equipe/invitation");
  }, [token]);

  function joined(next: string) {
    setState("success");
    window.setTimeout(() => router.replace(next as "/app"), 450);
  }

  async function join() {
    if (state !== "idle") return;
    setError(null);
    setState("loading");
    const result = await callAction(() =>
      acceptTeamInviteAction(token ? { token } : {}),
    );
    if (result.ok) return joined(result.data.next);
    setState("idle");
    if (result.error.code === "invitation_password_required") {
      setNeedsPassword(true);
      window.setTimeout(() => passwordRef.current?.focus(), 0);
      return;
    }
    setError(result.error);
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== "idle") return;
    if (password.length < PASSWORD_MIN) {
      setPasswordError(`Au moins ${PASSWORD_MIN} caractères.`);
      passwordRef.current?.focus();
      return;
    }
    setError(null);
    setState("loading");
    const result = await callAction(() =>
      completeTeamInviteAction(token ? { password, token } : { password }),
    );
    if (result.ok) return joined(result.data.next);
    setState("idle");
    if (result.error.code === "validation_error") {
      setPasswordError(
        `Mot de passe trop simple : au moins ${PASSWORD_MIN} caractères variés.`,
      );
      passwordRef.current?.focus();
      return;
    }
    setError(result.error);
  }

  if (!signedIn && !token)
    return (
      <div className="flex flex-col gap-6">
        <AuthHeading eyebrow="Invitation" title="Ce lien est incomplet">
          Ouvre-le directement depuis l’e-mail d’invitation, sans le recopier.
        </AuthHeading>
        <Link
          href="/login"
          className="w-fit text-[15px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
        >
          Me connecter
        </Link>
      </div>
    );

  if (!signedIn)
    return (
      <div className="flex flex-col gap-8">
        <AuthHeading eyebrow="Invitation" title="Rejoins l’équipe">
          On t’a invitée à travailler dans un espace. Crée ton compte avec
          l’adresse qui a reçu l’invitation, ou connecte-toi si tu en as déjà
          un.
        </AuthHeading>
        <div className="flex flex-col gap-3">
          <Link
            href={{ pathname: "/signup", query: { invitation: token! } }}
            className="flex h-14 items-center justify-center rounded-2xl bg-pop text-[16px] font-medium text-on-pop transition-transform duration-150 active:scale-[0.98]"
          >
            Créer mon compte
          </Link>
          <Link
            href={{ pathname: "/login", query: { invitation: token! } }}
            className="flex h-14 items-center justify-center rounded-2xl border border-line bg-paper-raised text-[16px] font-medium text-ink transition-transform duration-150 active:scale-[0.98]"
          >
            J’ai déjà un compte
          </Link>
        </div>
      </div>
    );

  if (needsPassword)
    return (
      <div className="flex flex-col gap-8">
        <AuthHeading eyebrow="Invitation" title="Choisis ton mot de passe">
          Ton adresse est confirmée. Choisis ton propre mot de passe : c’est lui
          qui prouve que le compte est le tien.
        </AuthHeading>
        <form noValidate onSubmit={complete} className="flex flex-col gap-5">
          {error ? <ErrorNotice error={error} /> : null}
          <PasswordField
            ref={passwordRef}
            label="Nouveau mot de passe"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError(undefined);
            }}
            error={passwordError}
            hint={`Au moins ${PASSWORD_MIN} caractères.`}
            showStrength
            disabled={state === "success"}
          />
          <Button
            type="submit"
            fullWidth
            state={state}
            loadingLabel="Activation…"
            successLabel="Équipe rejointe"
            icon={<ArrowRightIcon size={18} />}
          >
            Rejoindre l’équipe
          </Button>
        </form>
      </div>
    );

  return (
    <div className="flex flex-col gap-8">
      <AuthHeading eyebrow="Invitation" title="Rejoins l’équipe">
        Ton compte est prêt. Par sécurité, tes autres sessions ouvertes seront
        fermées quand tu rejoindras l’équipe.
      </AuthHeading>
      {error ? (
        <ErrorNotice
          error={error}
          action={
            error.code === "unauthenticated" ? (
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
      <Button
        fullWidth
        state={state}
        loadingLabel="Un instant…"
        successLabel="Équipe rejointe"
        icon={<ArrowRightIcon size={18} />}
        onClick={() => void join()}
      >
        Rejoindre l’équipe
      </Button>
    </div>
  );
}
