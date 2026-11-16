import "server-only";

import type { ConfiguredTransport } from "@/features/notifications/transport";
import type { MatchedOffer } from "@/features/waitlist-server/data";
import { getPublicEnv } from "@/lib/env/public";

// The two emails of the waiting list. The token travels in the URL FRAGMENT
// (after #): browsers never send it to a server nor put it in a referrer.

const TIMEOUT_MS = 10_000;

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendConfirmationEmail(
  configured: ConfiguredTransport,
  input: {
    requestId: string;
    to: string;
    firstName: string;
    businessName: string;
    token: string;
  },
) {
  const link = `${getPublicEnv().NEXT_PUBLIC_APP_URL}/liste-attente/confirmer#t=${input.token}`;
  await configured.transport.send(
    {
      to: input.to,
      from: configured.from,
      subject: `Confirmez votre liste d’attente chez ${input.businessName}`,
      text: [
        `Bonjour ${input.firstName},`,
        "",
        `Pour être prévenue quand un créneau se libère chez ${input.businessName}, confirmez ici :`,
        link,
        "",
        "Rien n’est réservé pour vous : le premier qui réserve un créneau libéré l’obtient.",
        "Si vous n’avez rien demandé, ignorez cet email : vous ne recevrez rien d’autre.",
      ].join("\n"),
      html: `<p>Bonjour ${escape(input.firstName)},</p><p>Pour être prévenue quand un créneau se libère chez ${escape(input.businessName)}, <a href="${link}">confirmez ici</a>.</p><p>Rien n’est réservé pour vous&nbsp;: le premier qui réserve un créneau libéré l’obtient.</p><p>Si vous n’avez rien demandé, ignorez cet email&nbsp;: vous ne recevrez rien d’autre.</p>`,
      idempotencyKey: `waitlist-confirm-${input.requestId}`,
    },
    AbortSignal.timeout(TIMEOUT_MS),
  );
}

export async function sendOfferEmail(
  configured: ConfiguredTransport,
  offer: MatchedOffer,
) {
  const link = `${getPublicEnv().NEXT_PUBLIC_APP_URL}/liste-attente/offre/${offer.offerId}#t=${offer.token}`;
  const when = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: offer.timezone,
  }).format(new Date(offer.startsAt));
  const until = new Intl.DateTimeFormat("fr-FR", {
    timeStyle: "short",
    timeZone: offer.timezone,
  }).format(new Date(offer.expiresAt));
  await configured.transport.send(
    {
      to: offer.email,
      from: configured.from,
      subject: `Un créneau s’est libéré chez ${offer.businessName}`,
      text: [
        `Bonjour ${offer.firstName},`,
        "",
        `${offer.serviceName} : un créneau s’est libéré le ${when}.`,
        `Il revient à la première personne qui le réserve. Offre valable jusqu’à ${until} :`,
        link,
      ].join("\n"),
      html: `<p>Bonjour ${escape(offer.firstName)},</p><p>${escape(offer.serviceName)}&nbsp;: un créneau s’est libéré le ${escape(when)}.</p><p>Il revient à la première personne qui le réserve. <a href="${link}">Le réserver</a> (offre valable jusqu’à ${escape(until)}).</p>`,
      idempotencyKey: `waitlist-offer-${offer.offerId}`,
    },
    AbortSignal.timeout(TIMEOUT_MS),
  );
}
