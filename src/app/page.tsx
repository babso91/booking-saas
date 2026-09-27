const foundations = [
  "Next.js 16 et TypeScript strict",
  "Supabase SSR et séparation des secrets serveur",
  "Schéma PostgreSQL multi-tenant avec RLS",
  "Contrainte de base contre les rendez-vous qui se chevauchent",
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-6 py-20 sm:px-10">
      <p className="mb-5 text-sm font-semibold tracking-[0.18em] text-rose-700 uppercase">
        Fondation technique
      </p>
      <h1 className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-balance text-stone-950 sm:text-6xl">
        Le socle du SaaS de réservation est prêt.
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">
        Cette étape installe uniquement l’architecture et les garanties de
        sécurité. Les parcours de réservation, l’agenda et la fidélité seront
        implémentés dans les prochaines verticales.
      </p>

      <ul className="mt-10 grid gap-3 sm:grid-cols-2" aria-label="Fondations">
        {foundations.map((foundation) => (
          <li
            key={foundation}
            className="rounded-2xl border border-stone-200 bg-white p-5 text-sm leading-6 text-stone-700 shadow-sm"
          >
            {foundation}
          </li>
        ))}
      </ul>
    </main>
  );
}
