import type { Metadata } from "next";

import { SignOutButton } from "@/features/auth/components/sign-out-button";

export const metadata: Metadata = {
  title: "Tableau de bord",
};

export default function DashboardFoundationPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6">
      <p className="text-sm font-semibold tracking-wide text-rose-700 uppercase">
        Espace privé — fondation
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">
        Tableau de bord
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-stone-600">
        Aucun écran métier n’est implémenté à cette étape. La prochaine tâche
        ajoutera l’authentification, l’onboarding et la protection effective de
        cette route.
      </p>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </main>
  );
}
