export default function PublicBookingNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-3 px-4 sm:px-6">
      <h1 className="font-display text-[34px] leading-tight text-ink">
        Page introuvable
      </h1>
      <p className="text-[15px] leading-relaxed text-ink-soft">
        Aucun établissement ne correspond à cette adresse. Vérifiez le lien reçu
        de l’établissement.
      </p>
    </main>
  );
}
