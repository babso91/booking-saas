import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <p className="text-sm font-semibold text-rose-700">Erreur 404</p>
      <h1 className="mt-3 text-3xl font-semibold text-stone-950">
        Cette page n’existe pas.
      </h1>
      <p className="mt-4 text-stone-600">
        Le lien est peut-être incomplet ou la page n’est pas encore disponible.
      </p>
      <Link className="mt-8 font-medium text-rose-700" href="/">
        Revenir à l’accueil
      </Link>
    </main>
  );
}
