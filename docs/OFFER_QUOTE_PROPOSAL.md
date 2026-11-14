# Devis lié au créneau, offres et codes — contrat proposé (R4-03, côté cliente)

Statut : **proposé par l'UI, non implémenté**. Le récapitulatif existe
(`src/features/offers/`) et ne tourne que dans `/apercu/devis`, contre un
serveur en mémoire. La réservation publique réelle garde son prix actuel
tant que ce contrat n'est pas servi. Règles versionnées, pool de quota,
`promotion_consumptions`, verrous et snapshot de prix restent ceux de Cloud.

Hors de cette tranche : l'éditeur d'offres côté pro, l'offre indicative au
catalogue.

## Devis (ne réserve ni ne consomme rien)

`POST /api/public/businesses/:slug/offer-quote`

```ts
{ serviceId, optionChoiceIds, startsAt, coupon? }
→ {
  quoteRef: string;          // court, opaque, lié tenant/créneau/options/règle/devise, sans PII
  startsAt: string;
  baseCents: number;
  optionsCents: number;
  discountCents: number;     // borné à l'assiette ; total jamais négatif
  totalCents: number;
  currency: string;
  durationMinutes: number;
  depositCents: number | null; // montant à part
  validUntil: string;
  discountLabel: string | null;  // texte lisible par la cliente
  discountSource: "offer" | "code" | null;
}
```

- Une seule remise ; un code valide est préféré à l'offre automatique, et
  retirer le code fait revenir l'offre visible.
- Code non admissible : `coupon_refused`, **motif générique**, garde
  anti-abus M2.

## Confirmation

`confirm({ quoteRef, requestId })` (avec le payload autoritatif de la
réservation) → `{ bookingId, totalCents }`

| Code                | Quand                                         | Ce que l'écran fait                                                             |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `quote_changed`     | Devis expiré ou différent au moment du commit | Redemande un devis, affiche « le total passe de X à Y », confirmation explicite |
| `offer_unavailable` | Quota épuisé entre-temps                      | Idem ; **jamais de bascule silencieuse au prix normal**                         |
| `slot_unavailable`  | Créneau pris                                  | « Rien n'a été réservé », retour au choix du créneau, données gardées           |
| réseau              | —                                             | Même `requestId`                                                                |

- Même `requestId` + même `quoteRef` avec reçu commis → même reçu, même
  après expiration du devis.
- Le navigateur ne calcule jamais le prix confirmé.

## Recette couverte côté écran

Prestation 6000, options 1500, assiette 7500, −15 % → 1125, total 6375 ;
deux créneaux le même jour dont un seul éligible ; quota 1 utilisé par un
autre → nouveau total confirmé explicitement ; devis expiré ; créneau pris ;
réponse perdue (une seule réservation).
