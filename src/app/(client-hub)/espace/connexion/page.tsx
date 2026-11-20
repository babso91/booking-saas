import type { Metadata } from "next";

import { SignIn } from "@/features/client-hub/components/sign-in";
import { safeHubReturnPath } from "@/features/client-hub/links";

export const metadata: Metadata = { title: "Connexion" };

export default async function ClientHubSignInPage({
  searchParams,
}: PageProps<"/espace/connexion">) {
  const query = await searchParams;
  return <SignIn returnTo={safeHubReturnPath(query.next)} />;
}
