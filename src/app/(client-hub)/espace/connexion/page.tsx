import type { Metadata } from "next";

import { SignIn } from "@/features/client-hub/components/sign-in";

export const metadata: Metadata = { title: "Connexion" };

export default function ClientHubSignInPage() {
  return <SignIn />;
}
