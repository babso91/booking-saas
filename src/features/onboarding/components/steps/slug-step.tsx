import { useId } from "react";

import { TextField } from "@/components/ui/field";
import { LinkIcon } from "@/components/ui/icons";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

import { normalizeSlugInput, slugify } from "../../slug";
import type { SlugCheckState } from "../../use-slug-check";
import { SlugStatus } from "../slug-status";
import { StepHeader } from "../step-header";
import type { StepProps } from "./types";

export function SlugStep({
  draft,
  update,
  errors,
  shakeKey,
  headingRef,
  registerField,
  slugState,
  onRetryCheck,
}: StepProps & { slugState: SlugCheckState; onRetryCheck: () => void }) {
  const statusId = useId();
  // The server's normalised slug once known, the local preview otherwise.
  const previewSlug =
    "slug" in slugState ? slugState.slug : slugify(draft.slug);
  const suggestions =
    slugState.kind === "taken" || slugState.kind === "reserved"
      ? slugState.suggestions
      : [];
  const fieldStatus =
    slugState.kind === "checking"
      ? "checking"
      : slugState.kind === "available"
        ? "success"
        : slugState.kind === "taken" ||
            slugState.kind === "reserved" ||
            slugState.kind === "invalid"
          ? "error"
          : "idle";

  const setSlug = (value: string) => {
    update("slug", value);
    update("slugEdited", true);
  };

  return (
    <div className="flex flex-col gap-8">
      <StepHeader
        eyebrow="Ton lien de réservation"
        title="Ton adresse, rien qu’à toi."
        headingRef={headingRef}
      >
        C’est le lien que tu partageras sur Instagram, WhatsApp ou dans ta bio.
      </StepHeader>

      <div className="flex flex-col gap-3">
        {/* Large live rendering of the full link. */}
        <div
          aria-hidden="true"
          className={cn(
            "flex items-center gap-3 overflow-hidden rounded-3xl border px-4 py-4 transition-colors duration-300 sm:px-5",
            slugState.kind === "available"
              ? "border-success/30 bg-success-soft/50"
              : slugState.kind === "taken" ||
                  slugState.kind === "reserved" ||
                  slugState.kind === "invalid"
                ? "border-danger/20 bg-danger-soft/40"
                : "border-line bg-sand/50",
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-paper-raised text-ink-soft">
            <LinkIcon size={19} />
          </span>
          <p className="min-w-0 text-[15px] leading-snug break-all text-ink-muted sm:text-[17px]">
            {bookingHost()}/b/
            <span className="font-semibold text-ink">
              {previewSlug || "ton-lien"}
            </span>
          </p>
        </div>

        <TextField
          ref={registerField("slug")}
          label="Personnalise la fin du lien"
          name="slug"
          prefix="/b/"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="studio-mila"
          value={draft.slug}
          onChange={(event) => setSlug(normalizeSlugInput(event.target.value))}
          // A trailing hyphen is kept while typing, dropped when leaving.
          onBlur={() => {
            if (slugify(draft.slug) !== draft.slug)
              update("slug", slugify(draft.slug));
          }}
          error={errors.slug}
          status={errors.slug ? "error" : fieldStatus}
          shakeKey={shakeKey}
          aria-describedby={statusId}
          maxLength={63}
        />

        {!errors.slug ? (
          <SlugStatus id={statusId} state={slugState} onRetry={onRetryCheck} />
        ) : null}

        {suggestions.length > 0 ? (
          <div className="flex animate-message flex-col gap-2.5">
            <p className="text-[13.5px] text-ink-soft">
              Ces variantes sont libres pour l’instant :
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setSlug(suggestion)}
                  className="h-10 cursor-pointer rounded-full border border-line bg-paper-raised px-3.5 text-[14px] text-ink transition-[border-color,transform] duration-200 hover:border-ink active:scale-[0.97]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <p className="rounded-2xl bg-sand/60 px-4 py-3.5 text-[14px] leading-relaxed text-ink-soft">
        Astuce : un lien court se retient et se dicte facilement. Les accents et
        espaces sont convertis automatiquement.
      </p>
    </div>
  );
}
