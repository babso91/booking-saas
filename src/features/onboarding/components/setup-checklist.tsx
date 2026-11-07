import Link from "next/link";

import { CheckIcon, ChevronRightIcon } from "@/components/ui/icons";
import type { SetupProgressDto } from "@/features/businesses/data/setup-progress";
import { cn } from "@/lib/cn";

/**
 * What to configure after onboarding: services, then opening hours (both
 * counted on the server). With them, her clients book online on her page.
 * Her site comes third and is optional: without one, the page is her
 * booking page, so it never counts as unfinished setup.
 */
export function SetupChecklist({
  progress,
  sitePublished = false,
  compact = false,
}: {
  progress: SetupProgressDto;
  /** Whether a version of her site is online (read on the server). */
  sitePublished?: boolean;
  /** A banner above the agenda instead of the welcome page block. */
  compact?: boolean;
}) {
  const services = progress.activeServices > 0;
  const hours = progress.openingRanges > 0;
  const done = Number(services) + Number(hours);
  const steps = [
    {
      done: services,
      title: "Tes prestations",
      detail: services
        ? `${progress.activeServices} prestation${progress.activeServices > 1 ? "s" : ""} proposée${progress.activeServices > 1 ? "s" : ""}`
        : "Nom, durée et prix de ce que tu proposes",
      href: "/app/services" as const,
      action: services ? "Gérer" : "Ajouter",
    },
    {
      done: hours,
      title: "Tes horaires",
      detail: hours
        ? "Horaires de la semaine enregistrés"
        : "Les jours et les heures où tu travailles",
      href: "/app/settings/hours" as const,
      action: hours ? "Modifier" : "Configurer",
    },
    {
      done: sitePublished,
      title: "Ton site",
      detail: sitePublished
        ? "En ligne : tes clientes réservent depuis ton site"
        : "Choisis ton univers et publie-le, quand tu veux",
      href: "/app/site" as const,
      action: sitePublished ? "Modifier" : "Créer",
    },
  ];

  if (compact) {
    // Above the agenda: one line, so the agenda keeps its height on phones.
    return (
      <section
        aria-labelledby="setup-title"
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        <h2 id="setup-title" className="text-[14.5px] font-semibold text-ink">
          Mise en route · {done}/2
        </h2>
        <ul className="flex flex-wrap gap-2">
          {steps.slice(0, 2).map((step, index) => (
            <li key={step.title}>
              <Link
                href={step.href}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-full border px-3 text-[13.5px] font-medium",
                  step.done
                    ? "border-success/30 bg-success-soft text-success"
                    : "border-line bg-paper-raised text-ink hover:border-line-strong",
                )}
              >
                {step.done ? (
                  <CheckIcon size={15} aria-hidden="true" />
                ) : (
                  <span aria-hidden="true">{index + 1}.</span>
                )}
                {index === 0 ? "Prestations" : "Horaires"}
                {step.done ? <span className="sr-only"> (fait)</span> : null}
              </Link>
            </li>
          ))}
        </ul>
        <p className="hidden text-[13px] text-ink-muted md:block">
          Ensuite, tes clientes réservent en ligne sur ta page.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="setup-title"
      className={cn(
        "flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised text-left",
        compact ? "px-4 py-4 sm:px-5" : "px-5 py-5",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2
          id="setup-title"
          className={cn(
            "font-display leading-tight text-ink",
            compact ? "text-[22px]" : "text-[26px]",
          )}
        >
          Mise en route
        </h2>
        <p className="text-[13.5px] text-ink-muted">
          {done} étape{done > 1 ? "s" : ""} sur 2 terminée{done > 1 ? "s" : ""}
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Link
              href={step.href}
              className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-paper px-3.5 py-3 hover:border-line-strong"
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold",
                  step.done
                    ? "bg-success-soft text-success"
                    : "bg-sand text-ink-soft",
                )}
                aria-hidden="true"
              >
                {step.done ? <CheckIcon size={16} /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-medium text-ink">
                  {step.title}
                  {step.done ? <span className="sr-only"> (fait)</span> : null}
                </span>
                <span className="text-[13px] wrap-anywhere text-ink-muted">
                  {step.detail}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[13.5px] font-medium text-ink-soft">
                {step.action}
                <ChevronRightIcon size={16} />
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
