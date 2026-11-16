import "server-only";

import type { ConsentChannel } from "@/features/marketing-consent/schemas";
import type { ConfiguredTransport } from "@/features/notifications/transport";
import { escapeHtml } from "@/features/notifications/templates/render";
import { getPublicEnv } from "@/lib/env/public";

// The confirmation of her marketing choices (double opt-in): sent directly
// through the configured transport, like the Hub's code (the link is never
// stored). Its token is in the link's fragment: the page reads it and sends
// it to the server; it never reaches a log nor a referrer.

const SEND_TIMEOUT_MS = 10_000;

export async function sendConsentConfirmation(
  configured: ConfiguredTransport,
  input: {
    to: string;
    businessName: string;
    token: string;
    channels: ConsentChannel[];
  },
) {
  const origin = new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin;
  const link = `${origin}/consentement/confirmer#t=${input.token}`;
  const what = input.channels
    .map((channel) => (channel === "email" ? "par e-mail" : "par SMS"))
    .join(" et ");
  const text = [
    "Bonjour,",
    "",
    `Lors de votre réservation chez ${input.businessName}, vous avez demandé à recevoir ses offres, promotions et nouveautés commerciales ${what}.`,
    "",
    `Pour le confirmer, ouvrez ce lien : ${link}`,
    "",
    "Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : rien ne sera enregistré.",
    "Vos messages concernant vos rendez-vous ne dépendent pas de ce choix.",
  ].join("\n");
  const html = `<p>Bonjour,</p><p>Lors de votre réservation chez <strong>${escapeHtml(input.businessName)}</strong>, vous avez demandé à recevoir ses offres, promotions et nouveautés commerciales ${what}.</p><p><a href="${escapeHtml(link)}">Confirmer mon choix</a></p><p>Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : rien ne sera enregistré. Vos messages concernant vos rendez-vous ne dépendent pas de ce choix.</p>`;
  await configured.transport.send(
    {
      to: input.to,
      from: configured.from,
      subject: `Confirmez vos choix pour ${input.businessName}`,
      text,
      html,
      idempotencyKey: `consent-confirmation-${input.token.slice(4, 36)}`,
    },
    AbortSignal.timeout(SEND_TIMEOUT_MS),
  );
}
