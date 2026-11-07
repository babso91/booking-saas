import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignupForm } from "@/features/auth/components/signup-form";
import { BetaNotice } from "@/features/beta/components/beta-notice";

export const metadata: Metadata = {
  title: "Créer mon espace",
};

// The private beta's invitation link: /signup?invitation=<token>
// (docs/BETA_ACCESS.md). The token is only passed on to the server, which
// checks it. Without one, any sign-up would be refused: that is said
// before she types anything.
export default async function SignupPage({
  searchParams,
}: PageProps<"/signup">) {
  const { invitation } = await searchParams;

  return (
    <AuthShell>
      {typeof invitation === "string" && invitation ? (
        <SignupForm invitationToken={invitation} />
      ) : (
        <BetaNotice reason="signup" />
      )}
    </AuthShell>
  );
}
