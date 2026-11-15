import Link from "next/link";

// Tokens only: the page follows the visitor's palette like every other one.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
      <p
        aria-hidden="true"
        className="text-[88px] leading-none font-bold tracking-[-0.04em] text-ink-muted tabular-nums"
      >
        404
      </p>
      <h1 className="font-display text-[30px] leading-tight text-ink">
        Cette page n’existe pas
      </h1>
      <p className="text-[16px] text-ink-soft">
        Le lien est peut-être incomplet ou la page n’est pas encore disponible.
      </p>
      <Link
        className="mt-4 w-fit font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
        href="/"
      >
        Revenir à l’accueil
      </Link>
    </main>
  );
}
