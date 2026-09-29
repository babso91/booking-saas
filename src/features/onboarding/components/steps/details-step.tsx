import { TextAreaField, TextField } from "@/components/ui/field";
import { PhoneIcon, PinIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

import { DESCRIPTION_MAX_LENGTH } from "../../schemas";
import { StepHeader } from "../step-header";
import type { StepProps } from "./types";

const policyPresets = [
  {
    label: "24 h avant",
    text: "Annulation ou report gratuit jusqu’à 24 h avant le rendez-vous.",
  },
  {
    label: "48 h avant",
    text: "Annulation ou report gratuit jusqu’à 48 h avant le rendez-vous.",
  },
  {
    label: "Sans condition",
    text: "Merci de me prévenir dès que possible si tu ne peux pas venir.",
  },
];

export function DetailsStep({
  draft,
  update,
  errors,
  shakeKey,
  headingRef,
  registerField,
}: StepProps) {
  return (
    <div className="flex flex-col gap-8">
      <StepHeader
        eyebrow="Quelques détails"
        title="La touche finale."
        headingRef={headingRef}
        aside={
          <span className="rounded-full bg-sand px-2.5 py-1 text-[12px] font-medium text-ink-soft">
            Facultatif
          </span>
        }
      >
        Tout est optionnel et modifiable plus tard depuis tes réglages.
      </StepHeader>

      <div className="flex flex-col gap-6">
        <TextField
          ref={registerField("phone")}
          label="Téléphone"
          optional
          type="tel"
          name="phone"
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="next"
          placeholder="06 12 34 56 78"
          leadingIcon={<PhoneIcon size={18} />}
          hint="Pour que tes clientes puissent te joindre en cas de besoin."
          value={draft.phone}
          onChange={(event) => update("phone", event.target.value)}
          error={errors.phone}
          shakeKey={shakeKey}
          maxLength={30}
        />

        <TextField
          ref={registerField("location")}
          label="Adresse ou quartier"
          optional
          name="location"
          autoComplete="street-address"
          enterKeyHint="next"
          placeholder="12 rue des Lilas, Lyon 6e"
          leadingIcon={<PinIcon size={18} />}
          value={draft.location}
          onChange={(event) => update("location", event.target.value)}
          error={errors.location}
          shakeKey={shakeKey}
          maxLength={200}
        />

        <TextAreaField
          ref={registerField("description")}
          label="Présentation courte"
          optional
          name="description"
          placeholder="Spécialiste du regard naturel, je pose des extensions sur-mesure dans un atelier cosy."
          counterMax={DESCRIPTION_MAX_LENGTH}
          value={draft.description}
          onChange={(event) => update("description", event.target.value)}
          error={errors.description}
          rows={3}
        />

        <fieldset className="flex flex-col gap-3">
          <legend className="text-[15px] font-medium text-ink">
            Politique d’annulation
            <span className="ml-1.5 text-[13px] font-normal text-ink-muted">
              facultatif
            </span>
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {policyPresets.map((preset) => {
              const active = draft.cancellationPolicy === preset.text;
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    update("cancellationPolicy", active ? "" : preset.text)
                  }
                  className={cn(
                    "h-10 cursor-pointer rounded-full border px-3.5 text-[14px] transition-[background-color,border-color,color,transform] duration-200 active:scale-[0.97]",
                    active
                      ? "border-ink bg-ink text-paper-raised"
                      : "border-line bg-paper-raised text-ink-soft hover:border-line-strong hover:text-ink",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <TextAreaField
            ref={registerField("cancellationPolicy")}
            label={
              <span className="sr-only">
                Texte de la politique d’annulation
              </span>
            }
            name="cancellationPolicy"
            placeholder="Choisis un modèle ou écris la tienne."
            value={draft.cancellationPolicy}
            onChange={(event) =>
              update("cancellationPolicy", event.target.value)
            }
            error={errors.cancellationPolicy}
            rows={2}
          />
        </fieldset>
      </div>
    </div>
  );
}
