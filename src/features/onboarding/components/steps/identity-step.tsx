import { TextField } from "@/components/ui/field";
import { bookingHost } from "@/lib/brand";

import { initials } from "../../draft";
import { StepHeader } from "../step-header";
import type { StepProps } from "./types";

export function IdentityStep({
  draft,
  update,
  errors,
  shakeKey,
  headingRef,
  registerField,
}: StepProps) {
  const name = draft.businessName.trim();

  return (
    <div className="flex flex-col gap-8">
      <StepHeader
        eyebrow="Ton activité"
        title="Faisons connaissance."
        headingRef={headingRef}
      >
        Quelques mots pour poser les bases de ton espace.
      </StepHeader>

      {/* Mobile-only echo of the desktop preview: the space takes shape. */}
      <div
        aria-hidden="true"
        className="flex items-center gap-3.5 rounded-3xl border border-line bg-paper-raised p-3.5 lg:hidden"
      >
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-ink font-display text-[20px] text-paper-raised">
          <span key={initials(name)} className="animate-pop">
            {initials(name)}
          </span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span
            className={
              name
                ? "truncate font-display text-[21px] leading-tight text-ink"
                : "truncate font-display text-[21px] leading-tight text-ink-muted/60"
            }
          >
            {name || "Ton activité"}
          </span>
          <span className="truncate text-[13px] text-ink-muted">
            {bookingHost()}/b/
            <span className="text-ink-soft">{draft.slug || "…"}</span>
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            ref={registerField("firstName")}
            label="Prénom"
            name="firstName"
            autoComplete="given-name"
            autoCapitalize="words"
            enterKeyHint="next"
            placeholder="Mila"
            value={draft.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            error={errors.firstName}
            shakeKey={shakeKey}
            maxLength={120}
          />
          <TextField
            ref={registerField("lastName")}
            label="Nom"
            name="lastName"
            autoComplete="family-name"
            autoCapitalize="words"
            enterKeyHint="next"
            placeholder="Laurent"
            value={draft.lastName}
            onChange={(event) => update("lastName", event.target.value)}
            error={errors.lastName}
            shakeKey={shakeKey}
            maxLength={120}
          />
        </div>
        <TextField
          ref={registerField("businessName")}
          label="Nom de ton activité"
          name="businessName"
          autoComplete="organization"
          autoCapitalize="words"
          enterKeyHint="next"
          placeholder="Studio Mila Lashes"
          hint="C’est le nom que verront tes clientes."
          value={draft.businessName}
          onChange={(event) => update("businessName", event.target.value)}
          error={errors.businessName}
          shakeKey={shakeKey}
          maxLength={120}
        />
      </div>
    </div>
  );
}
