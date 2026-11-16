# Niveaux VIP et parrainage : contrat servi (R4-02)

Réponse de Cloud à `docs/LOYALTY_TIERS_PROPOSAL.md` (PR #63). Les formes de
la proposition sont servies, avec les écarts listés en fin de document.
Migration : `supabase/migrations/20261116090000_loyalty_tiers_referral.sql`.
Tout repose sur le registre de fidélité existant : aucun second registre,
chaque crédit est une écriture du registre.

## Règles (pro, `src/features/loyalty/growth/actions.ts`)

| Action                                | Réponse           |
| ------------------------------------- | ----------------- |
| `getLoyaltyGrowthRulesAction()`       | `GrowthRulesDto`  |
| `setLoyaltyGrowthRulesAction(input)`  | `GrowthRulesDto`  |
| `getTierProgressAction({ clientId })` | `TierProgressDto` |

- `GrowthRulesDto = { tiers: TierDto[], windowDays, referralPoints, version }`.
- Entrée de `set` : `{ tiers: { name, threshold, perk? }[], windowDays, referralPoints, expectedVersion }`.
  - 0 à 5 niveaux, seuils strictement croissants, de 1 à 500 visites ;
  - nom de 1 à 40 caractères, avantage de 120 caractères au plus ;
  - fenêtre de 30 à 730 jours ;
  - `referralPoints` de 1 à 10000, ou `null` pour ne pas proposer de
    parrainage ;
  - `expectedVersion` vaut 0 avant le premier enregistrement.
    `version_conflict` sinon.
- Modifier les règles est réservé à l'owner et à l'admin. Tout membre peut
  les lire.
- L'`id` d'un niveau est dérivé de son seuil (`t5`).

## Niveaux

- **Calcul.** Le niveau compte les visites `completed` dont le début tombe
  dans les `windowDays` derniers jours. Fenêtre glissante, jamais le solde de
  points : dépenser des points ne fait pas baisser le niveau. Changer les
  seuils ne réécrit rien, car rien n'est stocké par cliente.
- `TierProgressDto = { tiers, tierId, currentValue, nextThreshold, windowDays, windowEnd, ruleVersion }`.
- **`windowEnd`** : le moment où la plus ancienne visite comptée sort de la
  fenêtre, donc où le compte peut baisser. `null` sans visite.
- **Côté cliente** : `GET /api/client-hub/businesses/:businessId/tier-progress`
  (session du Hub).

## Parrainage

- **Son lien** (Hub, relation attestée) :
  - `GET  /api/client-hub/businesses/:id/referral` :
    `{ offered: boolean, link: ReferralLinkDto | null }`. `offered` dit si
    l'établissement propose le parrainage maintenant ; `link` est son lien
    actif ou expiré ;
  - `POST /api/client-hub/businesses/:id/referral` avec `{ requestId }` :
    `ReferralLinkDto`. Le lien est valable 90 jours, et le précédent cesse de
    marcher. Rejeu par `requestId`. `referral_unavailable` (409) si
    l'établissement ne propose pas de parrainage, ou si sa fidélité est
    inactive.
- **Format du lien** : `/b/<slug>?parrainage=<code>`, la page publique avec
  un paramètre.
  - Le code n'est qu'une **attribution** : il n'ouvre rien, ni Hub ni CRM.
  - Rien n'est envoyé depuis l'écran : c'est elle qui partage son lien.
- **Réservation** : la page publique passe le code à `POST /api/bookings`
  (`referralCode`).
  - La réservation n'échoue jamais à cause du code. Un code inconnu ou expiré
    réserve sans attribution, et la réponse ne dit rien de la marraine.
  - L'attribution n'a lieu qu'une fois par cliente parrainée dans
    l'établissement. Elle est refusée :
    - pour un auto-parrainage ;
    - pour une cliente qui avait déjà un rendez-vous ;
    - pour un code d'un autre établissement.
  - Les points de la prime sont figés à l'attribution.
- **Prime** : quand la visite réservée par le lien passe à `completed`, la
  marraine reçoit une écriture `referral_reward`, avec une clé
  `referral × génération` : un seul crédit par réalisation.
  - Une visite rouverte donne une écriture `correction`.
  - Une visite à nouveau réalisée donne une nouvelle génération, toujours au
    montant figé.
  - Fidélité inactive au moment de la réalisation : aucune prime, et
    l'attribution est définitivement rejetée, comme l'éligibilité des points
    d'une visite, décidée à sa première réalisation.
  - Rendez-vous réattribué à une autre cliente : l'attribution est rejetée
    pour de bon, et une prime déjà versée est compensée.
- **Lien d'un établissement qui a arrêté le parrainage** : `GET` renvoie
  `state: "unavailable"`. Ne pas le proposer au partage.
- **Limite connue** : une marraine qui réserve avec une autre adresse crée une
  nouvelle fiche, et cela ne se détecte pas. La prime ne tombe qu'après une
  visite réellement réalisée, validée par la pro.
- **Q3 de la proposition** : ne pas afficher de solde négatif à côté du
  niveau. Le niveau ne dépend pas du solde.

## Nouveau type d'écriture

Le registre gagne le type `referral_reward`, ajouté aux unions TypeScript :

- `LoyaltyEntryType` côté fidélité et CRM ;
- `ClientHubLedgerEntryDto` ;
- validation de la frise CRM ;
- libellés : « Parrainage » et « Points de parrainage ».

## Écarts avec la proposition

1. **`nextThreshold` et `windowDays` sont ajoutés.** `windowEnd` correspond à
   la sortie de la plus ancienne visite comptée (fenêtre glissante).
2. **Le lien est une URL construite** : `ReferralLinkDto` est servi tel que
   proposé (`url`, `expiresAt`, `state`), avec un état de plus :
   `unavailable`.
3. **Délai avant prime** : aucun en V1. La prime est versée à la réalisation,
   et une réouverture la compense.
4. **Hors lot** :
   - l'écran pro des parrainages (historique, état, correction tracée) ;
   - la révocation d'un lien par la pro ;
   - la prime pour la filleule.
