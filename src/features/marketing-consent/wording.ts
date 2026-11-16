/**
 * The wording shown to a client when she is asked whether she wants offers
 * (docs/MARKETING_CONSENT_WORDING_PROPOSAL.md).
 *
 * A PROPOSAL, NOT VALIDATED. It is not legal text: it must be checked
 * before any use. Until then:
 * - no consent is collected anywhere (`consentCollectionOpen` is false and
 *   nothing in the booking flow or the professional area asks for one);
 * - no marketing message is sent (campaigns stay off server-side).
 *
 * When a version is validated, it gets its own `version` (never reuse one:
 * each agreement keeps the version she saw), `validated: true`, and the
 * server learns to refuse any other version (asked of Cloud). Changing this
 * file alone opens nothing.
 */

/** « de Maison Iris », « d’Atelier Lune ». */
export function ofBusiness(name: string) {
  return /^[aeiouyàâäéèêëîïôöùûüœæ]/i.test(name.trim())
    ? `d’${name}`
    : `de ${name}`;
}

export const CONSENT_WORDING = {
  /** Recorded with each agreement as `proofVersion`. */
  version: "mkt-fr-proposition-1",
  validated: false,
  language: "fr",
  /** Above the two choices. */
  title: "Offres et nouveautés",
  optional: "Facultatif : votre réservation ne dépend pas de ce choix.",
  email: (businessName: string) =>
    `Recevoir par e-mail les offres et nouveautés ${ofBusiness(businessName)}`,
  sms: (businessName: string) =>
    `Recevoir par SMS les offres et nouveautés ${ofBusiness(businessName)}`,
  /** What is not marketing, and is sent in any case. */
  necessary:
    "Les messages liés à votre rendez-vous (confirmation, rappel, modification) vous sont envoyés dans tous les cas.",
  withdraw:
    "Vous pouvez changer d’avis à tout moment : un lien dans chaque message, ou votre espace client.",
  /** Who sends. Where her rights are explained: still to be decided. */
  controller: (businessName: string) =>
    `Ces messages vous sont envoyés par ${businessName}.`,
} as const;

/**
 * Whether a consent may be asked anywhere: no, while the wording is a
 * proposal. Opening it is a code change, reviewed, made with the server's
 * own refusal of unvalidated versions; no environment variable opens it.
 */
export const consentCollectionOpen = false;

export type MarketingChoice = { email: boolean; sms: boolean };

/** Never pre-checked: both start unticked, and stay so unless she ticks. */
export const noMarketingChoice = (): MarketingChoice => ({
  email: false,
  sms: false,
});
