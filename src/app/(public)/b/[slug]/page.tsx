import type { Metadata } from "next";

type PublicBusinessPageProps = {
  params: Promise<{ slug: string }>;
};

export const metadata: Metadata = {
  title: "Réservation",
};

export default async function PublicBusinessFoundationPage({
  params,
}: PublicBusinessPageProps) {
  const { slug } = await params;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <p className="text-sm font-semibold tracking-wide text-rose-700 uppercase">
        Page publique — fondation
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">/{slug}</h1>
      <p className="mt-4 leading-7 text-stone-600">
        Le catalogue et le parcours de réservation seront ajoutés après
        l’onboarding et la gestion des prestations.
      </p>
    </main>
  );
}
