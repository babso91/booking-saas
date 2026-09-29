import type { Metadata } from "next";

import { SignupForm } from "@/features/auth/components/signup-form";

export const metadata: Metadata = {
  title: "Créer mon espace",
};

export default function SignupPage() {
  return <SignupForm />;
}
