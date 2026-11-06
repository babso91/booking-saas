import Link from "next/link";

import { AuthHeading } from "@/features/auth/components/auth-heading";
import { SignOutButton } from "@/features/auth/components/sign-out-button";

/**
 * The private beta, said before anything is filled in (docs/BETA_ACCESS.md):
 * - "signup": /signup opened without an invitation link, where any sign-up
 *   would be refused;
 * - "onboarding": signed in, but her account has no beta access, so
 *   creating her business would be refused.
 */
export function BetaNotice({ reason }: { reason: "signup" | "onboarding" }) {
  if (reason === "signup") {
    return (
      <div className="flex flex-col gap-9">
        <AuthHeading
          eyebrow="Bêta privée"
          title={
            <>
              Sur <em className="text-accent">invitation</em>, pour l’instant.
            </>
          }
        >
          Pour créer ton espace, ouvre le lien personnel reçu dans ton
          invitation : il t’amène ici, prête à commencer.
        </AuthHeading>
        <p className="animate-rise text-[15px] text-ink-soft [animation-delay:120ms]">
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

  return (
    <div className="flex flex-col gap-9">
      <AuthHeading
        eyebrow="Bêta privée"
        title={
          <>
            Ton compte attend son <em className="text-accent">invitation</em>.
          </>
        }
      >
        La bêta est ouverte sur invitation, et ce compte n’en a pas encore : la
        création de ton espace serait refusée. Si tu as reçu un lien
        d’invitation, déconnecte-toi puis ouvre-le, avec l’adresse à laquelle il
        t’a été envoyé.
      </AuthHeading>
      <div className="animate-rise [animation-delay:120ms]">
        <SignOutButton />
      </div>
    </div>
  );
}
