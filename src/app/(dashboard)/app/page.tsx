import type { Metadata } from "next";

import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { requireReadyBusiness } from "@/features/auth/data/guards";

export const metadata: Metadata = {
  title: "Tableau de bord",
};

export default async function DashboardFoundationPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  await requireReadyBusiness();

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6">
      <p className="text-sm font-semibold tracking-wide text-rose-700 uppercase">
        Espace privé
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">
        Tableau de bord
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-stone-600">
        Ton espace est configuré. Tes prestations, tes horaires et ton agenda
        arriveront ici dans les prochaines étapes.
      </p>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </main>
  );
}
