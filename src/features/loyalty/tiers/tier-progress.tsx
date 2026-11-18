import type { TierProgressDto } from "./contract";
import { standingOf } from "./progress";

// A client's VIP progression: her tier, the next one and the visits it
// still takes, until when the visits are counted. The same card for the
// professional (her client's file) and for the client (her space); the
// words change with who reads it.

export function TierProgress({
  progress,
  timezone,
  reader,
}: {
  progress: TierProgressDto;
  timezone: string;
  /** "pro": about her client; "client": to the client herself ("vous"). */
  reader: "pro" | "client";
}) {
  const { current, next, missing, ratio } = standingOf(progress);
  // When the oldest counted visit leaves the sliding window (the count may
  // go down then); null without any counted visit.
  const leaves = progress.windowEnd
    ? new Intl.DateTimeFormat("fr-FR", {
        timeZone: timezone,
        day: "numeric",
        month: "long",
      })
        .format(new Date(progress.windowEnd))
        // French writes the first of the month "1er".
        .replace(/^1 /, "1er ")
    : null;
  const span =
    progress.windowDays % 365 === 0
      ? `${(progress.windowDays / 365) * 12} derniers mois`
      : progress.windowDays % 30 === 0
        ? `${progress.windowDays / 30} derniers mois`
        : `${progress.windowDays} derniers jours`;
  const visits = (count: number) => `${count} visite${count > 1 ? "s" : ""}`;

  return (
    <section
      aria-label="Niveau de fidélité"
      className="flex flex-col gap-4 border-t border-line pt-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-[13px] font-medium text-ink-muted">Niveau</p>
          <p className="font-display text-[28px] leading-none text-ink">
            {current?.name ??
              (reader === "client" ? "Bienvenue" : "Aucun niveau")}
          </p>
        </div>
        <p className="text-[13.5px] text-ink-soft tabular-nums">
          {visits(progress.currentValue)}
        </p>
      </div>

      <div
        role="progressbar"
        aria-label={next ? `Vers ${next.name}` : "Niveau le plus haut"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        className="h-2 overflow-hidden rounded-full bg-sand"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>

      <p className="text-[14px] leading-relaxed text-ink-soft">
        {next
          ? reader === "client"
            ? `Encore ${visits(missing)} pour atteindre ${next.name}${next.perk ? ` : ${next.perk}` : ""}.`
            : `Encore ${visits(missing)} pour ${next.name}.`
          : reader === "client"
            ? "Vous êtes au niveau le plus haut."
            : "Au niveau le plus haut."}{" "}
        {reader === "client"
          ? `Ce sont vos visites des ${span}.`
          : `Visites des ${span}${leaves ? ` ; la plus ancienne en sortira le ${leaves}` : ""}.`}
      </p>
      {current?.perk ? (
        <p className="rounded-2xl bg-sand/60 px-4 py-3 text-[14px] text-ink">
          {reader === "client" ? "Votre avantage : " : "Avantage : "}
          {current.perk}
        </p>
      ) : null}
    </section>
  );
}
