# Devis lié au créneau, offres et codes : contrat servi (R4-03)

Réponse de Cloud à `docs/OFFER_QUOTE_PROPOSAL.md` (PR #70). Le devis et la
confirmation sont servis **tels que proposés**, avec les écarts listés en
fin de document. Migration : `supabase/migrations/20261116100000_offer_quote.sql`.

## Devis : `POST /api/public/businesses/:slug/offer-quote`

- **Entrée** `{ serviceId, optionChoiceIds, startsAt, coupon? }`. **Sortie**
  `OfferQuote`, avec les champs de la proposition. `depositCents` vaut
  toujours `null` : il n'y a pas encore d'acompte.
- **Il ne réserve rien et ne consomme rien.** Le créneau doit être réservable
  à cet instant, sinon `slot_unavailable`.
- **`quoteRef`** : 16 caractères opaques, sans donnée personnelle. Le devis
  est conservé côté serveur 10 minutes (`validUntil`).
- **Une seule remise :**
  - Un code valide est préféré. Il est insensible à la casse et aux espaces.
  - Sans code, c'est la meilleure offre automatique qui s'applique (la plus
    forte remise, puis la plus ancienne).
  - Retirer le code fait revenir l'offre, puisque le devis est recalculé.
- **Calcul :** la remise est calculée sur l'assiette (prestation + options)
  et bornée par elle, donc le total n'est jamais négatif. Un pourcentage est
  arrondi à l'euro-centime inférieur.
- **Code refusé :** `coupon_refused` (422), avec un motif générique quelle que
  soit la règle. Après 20 codes refusés par réseau et par heure :
  `rate_limited`.

## Confirmation : `POST /api/bookings` avec `quoteRef`

- **Ce que fait la réservation :**
  - elle prend le verrou du planning ;
  - elle revérifie le devis : même créneau, mêmes options, même assiette,
    même durée, même devise, toujours valable ;
  - elle revérifie l'offre : active, même version, toujours applicable à ce
    créneau, à cet instant ;
  - elle consomme le quota dans la même transaction ;
  - elle enregistre le total remisé comme prix du rendez-vous.
- **Refus :**
  - `quote_changed` : devis expiré ou différent, ou offre modifiée ou mise en
    pause. L'écran redemande un devis et fait confirmer le nouveau total.
  - `promotion_exhausted` : quota épuisé entre-temps. **Jamais de bascule
    silencieuse au prix normal.**
  - `slot_unavailable` : créneau pris. La consommation du quota est annulée
    avec le reste.
- **Rejeu :** même `requestId` et même `quoteRef` donnent le même reçu, même
  après l'expiration du devis.
- **Annulation :** annuler le rendez-vous rend l'utilisation au quota, une
  seule fois.
- **Lien avec la fidélité :** la fidélité « à la dépense » compte le prix
  remisé (`price_cents_snapshot`).

## Côté pro (`src/features/offers-server/actions.ts`, owner et admin)

| Action                                                             | Effet                 |
| ------------------------------------------------------------------ | --------------------- |
| `listPromotionsAction()`                                           | toutes les promotions |
| `createPromotionAction(PromotionInput)`                            | offre ou code         |
| `setPromotionStateAction({ promotionId, state, expectedVersion })` | pause ou reprise      |

- **`PromotionInput`** : `{ kind: "offer"|"code", code?, label, percentOff | amountOffCents, minBasisCents?, serviceIds?, validFrom?, validUntil?, weekdays? (1 = lundi … 7), localStartMinute?, localEndMinute?, minNoticeMinutes?, quotaLimit? }`.
  - Les jours et les heures sont ceux de l'établissement : une heure civile
    répétée au changement d'heure donne deux instants distincts.
  - La devise est celle de l'établissement.
- **Une règle ne change jamais** une fois créée : pour la modifier, on la met
  en pause et on en crée une autre. Un devis désigne toujours une seule
  règle.
- **Refus :** `coupon_code_taken`, `promotion_not_found`, `version_conflict`,
  `invalid_input`.

## Écarts avec la proposition

1. **`promotion_exhausted`** à la place de `offer_unavailable` pour le quota
   épuisé : `offer_unavailable` existe déjà avec un autre sens (une offre de
   liste d'attente dont le créneau a été pris, #92). Même comportement à
   l'écran.
2. **Garder la même `quoteRef` pour réessayer.** La `quoteRef` entre dans
   l'empreinte du `requestId` : un nouveau devis suivi d'un nouvel essai avec
   le même `requestId` donne `idempotency_conflict`. Il faut donc réessayer
   avec le même devis, ou bien avec un nouveau `requestId`.
3. **Liste d'attente** : une place offerte se réserve au prix normal, sans
   offre automatique, ce qui n'est jamais une remise silencieuse. C'est un
   choix produit, qui peut évoluer.
4. **Pas d'acompte** : `depositCents` vaut `null`.
5. **Deux codes du côté pro** : `coupon_code_taken` et `promotion_not_found`.
6. **Hors lot :**
   - l'éditeur d'offres côté pro (seules les actions sont servies) ;
   - l'offre indicative au catalogue ;
   - les promotions par cliente vérifiée (V2) ;
   - les cartes cadeaux (R4-04).
