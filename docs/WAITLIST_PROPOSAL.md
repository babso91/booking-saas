# Liste d'attente (proposition UI → Cloud)

**Statut : PROPOSÉ.** Rien de ce document n'est servi par le backend. Il décrit ce que l'interface attend, pour que Cloud le valide, le corrige ou le remplace.

Les deux écrans existent (`src/features/waitlist/`), testés contre un serveur en mémoire. **Ils ne sont montés dans aucune page réelle**, seulement dans `/apercu/liste-attente` (`?ecran=inscription|offre`, `?pris=1`).

## 1. Principe que l'écran dit à la cliente

Aucun créneau n'est mis de côté. Quand un créneau se libère, une offre est envoyée ; il revient à la première personne qui le réserve. Une offre manquée, expirée ou prise par quelqu'un d'autre laisse la demande active, tant que ses moments couvrent encore du temps.

## 2. Inscription

Depuis la réservation publique d'une prestation : les jours souhaités (14 jours au plus, sans dépasser l'horizon de l'établissement ; 5 jours au plus) et un moment de la journée, ou « Dès que possible ». Puis prénom, email et consentement explicite à être contactée.

```ts
POST /api/waitlist/requests
{
  requestId: string;              // idempotence : même id après une réponse perdue
  businessSlug: string;
  serviceId: string;
  optionChoiceIds: string[];
  windows: { localDate: "YYYY-MM-DD"; startMinute: number; endMinute: number }[]; // 1 à 5 ; vide si anyTime
  anyTime: boolean;               // toutes les fenêtres éligibles
  firstName: string;
  email: string;                  // en minuscules
  contactConsent: true;
}
→ { id, state: "pending_confirmation" | "active", activeUntil }
```

- Moments proposés, en minutes du jour civil de l'établissement : matin 0–720, après-midi 720–1080, fin de journée 1080–1440, journée entière 0–1440.
- `pending_confirmation` : l'écran demande de confirmer depuis l'email reçu. `active` : il dit qu'elle sera prévenue.
- Refus gérés : `rate_limited`, `service_not_found`, pas de réponse (nouvel essai avec le même `requestId`).

## 3. Offre

```ts
GET  /api/waitlist/offers/:id        → Offer
POST /api/waitlist/offers/:id/claim  { requestId, expectedVersion, expectedQuoteRevision } → Offer

type Offer = {
  id, version,
  state: "offered" | "expired" | "unavailable" | "booked",
  serviceName, startsAt, endsAt, localStartsAt, timezone, businessName,
  priceCents, durationMinutes, currency,
  quoteRevision,      // renvoyé à la réservation
  expiresAt,          // horloge du serveur
  requestActive,      // la demande continue
};
```

- **La réponse du serveur fait seule foi.** Le compte à rebours n'est qu'un repère : à zéro, l'offre est relue.
- Refus gérés :

| Code                       | Ce que fait l'écran                                                     |
| -------------------------- | ----------------------------------------------------------------------- |
| `offer_unavailable`        | « Ce créneau vient d'être réservé », relit l'offre (« demande active ») |
| `offer_expired`            | « L'offre a expiré », relit l'offre                                     |
| `quote_changed`            | « Le prix ou la durée a changé », relit l'offre, nouvelle confirmation  |
| `stale_offer`              | relit l'offre                                                           |
| `waitlist_offer_not_found` | « Offre introuvable », sans détail                                      |
| pas de réponse             | « Pas de réponse », nouvel essai avec le même `requestId`               |

- **Accès à l'offre.** L'écran prend un identifiant d'offre. Comment la cliente y est autorisée (capacité dans le lien de l'email, sans la placer dans l'URL exportée ni le referrer) est à décider par Cloud. L'écran n'en dépend pas.

## 4. Pas encore couvert

- La vue de la professionnelle (liste, ancienneté, préférences, journal des offres).
- La désinscription depuis l'email, et la liste d'attente dans le Client Hub.
- Le bouton « Être prévenue » dans l'étape des créneaux : il sera monté quand la route d'inscription existera (et seulement si l'établissement l'active).

## 5. Où c'est dans le code

- Contrat proposé : `src/features/waitlist/contract.ts`.
- Moments et contrôles : `windows.ts`.
- Écrans : `join-waitlist.tsx`, `waitlist-offer.tsx`.
- Serveur en mémoire : `memory-actions.ts`.
- Tests : `waitlist.test.tsx` (14).
