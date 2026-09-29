"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { signOutAction } from "@/features/auth/actions/auth";
import { callAction } from "@/features/auth/client/call-action";
import { clearDraft } from "@/features/onboarding/draft";

/** Ends the session server-side, then hands over to /login. */
export function SignOutButton() {
  const router = useRouter();
  const [state, setState] = useState<ButtonState>("idle");
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setState("loading");
    setFailed(false);
    const result = await callAction(() => signOutAction());
    if (!result.ok) {
      setState("idle");
      setFailed(true);
      return;
    }
    clearDraft();
    router.replace(result.data.next);
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        size="md"
        state={state}
        loadingLabel="Déconnexion…"
        onClick={signOut}
      >
        Se déconnecter
      </Button>
      {failed ? (
        <p role="alert" className="text-[13.5px] text-danger">
          La déconnexion n’a pas abouti. Réessaie.
        </p>
      ) : null}
    </div>
  );
}
