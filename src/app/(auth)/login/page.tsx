import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connexion",
};

export default function LoginFoundationPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <p className="text-sm font-semibold tracking-wide text-rose-700 uppercase">
        Espace professionnel
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">Connexion</h1>
      <p className="mt-4 leading-7 text-stone-600">
        L’authentification Supabase sera branchée dans la prochaine verticale.
        Cette route réserve dès maintenant la frontière publique de connexion.
      </p>
    </main>
  );
}
