import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Connexion momentanément indisponible",
  robots: { index: false },
};

// Where the guards send a visitor when Supabase Auth cannot be reached
// (src/features/auth/data/guards.ts): a temporary error, not a sign-out.
// Her session cookies are untouched; going back to /app checks again.
export default function AuthUnavailable() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <p className="text-sm font-semibold text-rose-700">
        Indisponible pour le moment
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">
        Nous ne pouvons pas vérifier votre connexion.
      </h1>
      <p className="mt-4 text-stone-600">
        Le service de connexion ne répond pas. Vous n’êtes pas déconnectée et
        vos informations sont intactes. Réessayez dans un instant.
      </p>
      <Link className="mt-8 font-medium text-rose-700" href="/app">
        Réessayer
      </Link>
    </main>
  );
}
