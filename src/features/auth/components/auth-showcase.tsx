import { CalendarIcon, SparkIcon } from "@/components/ui/icons";

/**
 * Editorial side panel shown on large screens next to the auth forms. It
 * previews what the product does (a booking landing, a loyalty card) instead
 * of an empty background. Purely decorative for assistive technologies.
 */
export function AuthShowcase() {
  return (
    <div
      aria-hidden="true"
      className="grain relative hidden overflow-hidden rounded-[28px] bg-sand lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14"
    >
      <div className="pointer-events-none absolute -top-40 -right-32 size-[520px] animate-drift rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.22),transparent_65%)]" />
      <div className="pointer-events-none absolute -bottom-48 -left-24 size-[480px] animate-drift rounded-full bg-[radial-gradient(circle_at_center,rgba(255,252,248,0.9),transparent_60%)] [animation-delay:-8s]" />

      <p className="relative max-w-sm text-[13px] font-medium tracking-[0.16em] text-ink-soft uppercase">
        Pour les techniciennes cils, prothésistes ongulaires, brow artists et
        coiffeuses indépendantes
      </p>

      <div className="relative my-10 flex flex-1 items-center justify-center">
        <div className="relative h-[340px] w-full max-w-[420px]">
          <div className="absolute top-2 left-0 w-[268px] animate-float rounded-3xl border border-white/60 bg-paper-raised p-5 shadow-[0_30px_60px_-30px_rgba(35,28,24,0.35)] [--tilt:-3deg]">
            <div className="flex items-center gap-2 text-[12px] text-ink-muted">
              <CalendarIcon size={15} />
              Jeudi 14 · 10:30
            </div>
            <p className="mt-3 font-display text-[26px] leading-tight text-ink">
              Rehaussement de cils
            </p>
            <p className="mt-1 text-[13px] text-ink-soft">
              Camille R. · 1 h 15
            </p>
            <div className="mt-5 flex items-center justify-between rounded-2xl bg-success-soft px-3.5 py-2.5 text-[13px] text-success">
              <span>Réservé en ligne</span>
              <span className="font-semibold">Confirmé</span>
            </div>
          </div>

          <div className="absolute right-0 bottom-0 w-[244px] animate-float rounded-3xl bg-ink p-5 text-paper-raised shadow-[0_30px_60px_-28px_rgba(35,28,24,0.6)] [--tilt:4deg] [animation-delay:-4.5s]">
            <div className="flex items-center justify-between text-[12px] text-paper-raised/70">
              <span>Carte fidélité</span>
              <SparkIcon size={16} />
            </div>
            <p className="mt-3 font-display text-[24px] leading-tight">
              Plus qu’une visite avant ta récompense
            </p>
            <div className="mt-4 flex gap-1.5">
              {Array.from({ length: 6 }, (_, index) => (
                <span
                  key={index}
                  className={
                    index < 5
                      ? "size-6 rounded-full bg-accent-soft"
                      : "size-6 rounded-full border border-dashed border-paper-raised/40"
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <figure className="relative max-w-md">
        <blockquote className="font-display text-[34px] leading-[1.1] tracking-[-0.01em] text-ink xl:text-[40px]">
          Tes clientes réservent.{" "}
          <em className="text-accent">Toi, tu te concentres sur ton art.</em>
        </blockquote>
      </figure>
    </div>
  );
}
