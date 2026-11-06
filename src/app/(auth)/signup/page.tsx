import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignupForm } from "@/features/auth/components/signup-form";

export const metadata: Metadata = {
  title: "Créer mon espace",
};

// The private beta's invitation link: /signup?invitation=<token>
// (docs/BETA_ACCESS.md). The token is only passed on to the server, which
// checks it; nothing is decided here.
export default async function SignupPage({
  searchParams,
}: PageProps<"/signup">) {
  const { invitation } = await searchParams;

  return (
    <AuthShell>
      <SignupForm
        invitationToken={
          typeof invitation === "string" ? invitation : undefined
        }
      />
    </AuthShell>
  );
}
