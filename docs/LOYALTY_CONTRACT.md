# Moteur de fidélité V1 : contrat backend (PR #23)

Backend seulement : aucun écran n'est livré. Ce document décrit ce que l'interface (Claude UI) peut appeler et ce que le backend garantit. Migration : `supabase/migrations/20261020090000_loyalty_engine.sql`. Code : `src/features/loyalty/` (schémas, données, Server Actions, types). Tests PostgreSQL : `tests/integration/loyalty.test.ts`. Montée de version : `tests/upgrade/loyalty-engine.test.ts`.

## Principes

- **Le ledger est la seule vérité.** Un solde est la somme des écritures `loyalty_events` d'une cliente. Il n'existe aucun compteur stocké qui pourrait diverger.
- **Écritures immuables.** Aucune écriture n'est modifiée ni supprimée, y compris par un rôle privilégié (trigger `loyalty_ledger_immutable`). Seule la suppression de l'activité entière les emporte en cascade.
- **Corrections compensatoires.** Une erreur se corrige par une écriture `correction` qui nomme l'écriture annulée (`reverses_event_id`). Elle a la même cliente et des points opposés, et une écriture n'est annulée qu'une fois (index unique).
- **Seule la professionnelle fait gagner des points.** Les points ne viennent que du passage d'un rendez-vous à `completed` par l'agenda (`agenda_set_appointment_status`, après vérification de la session et de l'appartenance). La réservation publique ne crée que des rendez-vous `confirmed`. Elle ne rapporte jamais de point, même une fois l'heure passée.
- **Aucun accès sans session professionnelle.** Il n'y a aucun droit `anon`, aucune recherche par email ni par jeton. Connaître l'email d'une cliente ne donne accès à rien.
- **Isolation par activité.** L'activité vient toujours de la session (`runBusinessAction`), jamais de l'entrée. Chaque fonction SQL revérifie l'appartenance, puis adresse chaque ligne par `(id, business_id)`. Un identifiant d'une autre activité répond « introuvable ».
- **Pas d'écriture directe.** Les rôles d'API n'ont que `SELECT` (sous RLS) sur `loyalty_programs`, `loyalty_service_rules`, `rewards`, `loyalty_events` et `reward_redemptions`. Toute écriture passe par les fonctions `public.loyalty_*`.

## Programme

| Champ                           | Règle                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `active`                        | opt-in : un programme créé à l'inscription est **inactif**                                             |
| `accrualMode`                   | `appointment` (points fixes par rendez-vous terminé) ou `spend` (au montant)                           |
| `pointsPerCompletedAppointment` | entier de 1 à 10 000                                                                                   |
| `pointsPerEuro`                 | `spend` seulement : chaîne décimale exacte (`"1.5"`), de 0,01 à 100, 4 décimales au plus               |
| `version`                       | à renvoyer en `expectedVersion` ; `0` si l'activité n'a pas encore de programme                        |
| `serviceRules`                  | points fixes par prestation, de 0 à 10 000 (0 : la prestation ne rapporte rien), prioritaires sur tout |

**Calcul d'un gain** (à la complétion, en entiers et `NUMERIC`, jamais en flottant) :

1. une règle de la prestation existe : ses points ;
2. sinon, en mode `appointment` : `pointsPerCompletedAppointment` ;
3. sinon, en mode `spend` : `floor(prix_snapshot_en_centimes × pointsPerEuro / 100)`.

Le prix utilisé est l'**instantané du rendez-vous** (`price_cents_snapshot`), pas le prix actuel de la prestation. Le résultat est plafonné à 1 000 000 par rendez-vous, et un gain de 0 n'écrit rien. Le calcul (mode, taux, prix, devise, prestation, version du programme) est enregistré dans `details` de l'écriture.

**Activation :**

- programme inactif : aucune complétion ne rapporte ;
- l'activation n'est pas rétroactive, même par réouverture : l'éligibilité d'un rendez-vous est fixée **une fois pour toutes à sa première complétion** (programme actif ou non à cet instant), dans `private.loyalty_appointment_eligibility`. Un rendez-vous terminé programme inactif ne rapportera jamais de points automatiques, même rouvert et terminé à nouveau après l'activation ; seul un ajustement manuel peut le créditer volontairement. Un rendez-vous terminé programme actif reste éligible (réouvertures, générations), y compris après une désactivation puis une réactivation ;
- désactiver ne retire aucun point ;
- avec un programme inactif, les récompenses ne peuvent pas être attribuées, mais les soldes et l'historique restent lisibles.

## Cycle de vie d'un rendez-vous

| Transition (agenda)             | Effet fidélité                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| réservation publique / manuelle | aucun                                                                                         |
| `confirmed` → `completed`       | première complétion : fixe l'éligibilité ; gain (génération 1) si le programme est actif      |
| `no_show` → `completed`         | gain                                                                                          |
| `completed` → `confirmed`       | **désormais autorisé** : le gain est annulé par une écriture `correction` compensatoire       |
| re-`completed`                  | si éligible et programme actif : nouveau gain (génération n + 1), sur les instantanés actuels |
| `cancelled`, `no_show`          | aucun point                                                                                   |
| complétion répétée, concurrente | un seul gain : le verrou du rendez-vous sérialise, et un même statut n'est pas une transition |

- Un rendez-vous terminé dont le gain tient toujours garde sa cliente, sa prestation et son prix (`appointment_not_editable`, quel que soit le chemin d'écriture).
- **Annulation d'un gain déjà dépensé :** l'écriture compensatoire est enregistrée quand même. Le solde peut alors devenir négatif, et c'est le seul cas. Aucune dépense n'est possible tant qu'il n'est pas redevenu positif.

## Récompenses

| Type                  | `rewardValue`                        | Autre                             |
| --------------------- | ------------------------------------ | --------------------------------- |
| `fixed_discount`      | montant en centimes (1 à 10 000 000) | `currency` = devise de l'activité |
| `percentage_discount` | 1 à 100                              | —                                 |
| `free_service`        | `null`                               | `serviceId` obligatoire           |

- **Création :** idempotente par `requestId`. Les mêmes valeurs renvoient la même récompense ; d'autres valeurs donnent `idempotency_conflict`.
- **Modification :** tous les champs modifiables, avec `expectedVersion` (`stale_reward`). Le type ne change pas. Les mêmes valeurs renvoyées ensuite réussissent.
- **Pas de suppression :** une récompense se désactive (`active: false`).
- **Récompense déjà attribuée :** elle garde son **instantané** (nom, type, valeur, devise, prestation). Une modification ultérieure ne change rien pour la cliente.
- **Prestation offerte absente** (supprimée, ou jamais renseignée sur une récompense historique) : la récompense est indisponible (`service_missing`).

## Attribution et utilisation

**États :** `issued` (points débités, récompense due) → `fulfilled` (appliquée lors d'une visite) ou `cancelled` (points rendus).

- **Attribution** (`redeemRewardAction`) :
  - le débit et l'enregistrement sont faits dans une seule transaction, sous le verrou de la fiche cliente ;
  - le solde est relu après toute dépense concurrente déjà validée ;
  - deux demandes simultanées ne dépensent jamais les mêmes points ;
  - idempotente par `requestId` : un nouvel essai, même concurrent, renvoie la même attribution.
- **Utilisation** (`fulfilRedemptionAction`) : la professionnelle constate l'application. Elle peut y joindre un rendez-vous de la **même** cliente. **Aucun paiement n'est encaissé ni réglé** : le produit n'a pas de caisse. Répéter l'action est sans effet.
- **Annulation** (`cancelRedemptionAction`) :
  - seulement depuis `issued` ;
  - rend les points par une écriture compensatoire liée au débit, une seule fois, même en cas de demandes concurrentes ;
  - une récompense utilisée est définitive : la corriger par un ajustement.
- **Ajustement manuel** (`adjustPointsAction`) :
  - crédit ou débit non nul (jusqu'à ±100 000), avec un motif obligatoire ;
  - idempotent par `requestId` ;
  - un débit ne peut pas faire passer le solde sous zéro.
- **Annulation d'un ajustement** (`reverseAdjustmentAction`) :
  - écriture compensatoire, une seule fois ;
  - annuler un crédit est un débit : c'est refusé (`insufficient_points`) si le solde passait sous zéro. Il faut d'abord annuler ce que ce crédit a payé ;
  - les gains et les attributions s'annulent par leur propre parcours.
- **Même `requestId` pour une autre cliente :** `idempotency_conflict`, même si les deux demandes sont simultanées.
- **(Dés)activation simultanée :** une attribution concurrente attend la fin de la (dés)activation du programme, puis s'y conforme.

## Server Actions (`src/features/loyalty/actions/loyalty.ts`)

Chaque action renvoie `ActionResult<T>` : `{ ok: true, data }` ou `{ ok: false, error: { code, message, fieldErrors? } }`. Les types sont dans `src/features/loyalty/types.ts`. Les instants sont en ISO 8601 UTC, les points et montants en entiers.

| Action                          | Entrée                                                                                       | Résultat                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `getLoyaltyProgramAction`       | —                                                                                            | `LoyaltyProgramDto`                                                          |
| `configureLoyaltyProgramAction` | `expectedVersion, active, accrualMode, pointsPerCompletedAppointment, pointsPerEuro?`        | `LoyaltyProgramDto`                                                          |
| `setLoyaltyServiceRuleAction`   | `serviceId, points` (`null` retire la règle)                                                 | `LoyaltyProgramDto`                                                          |
| `listRewardsAction`             | —                                                                                            | `RewardDto[]`                                                                |
| `createRewardAction`            | `requestId, name, description?, pointsRequired, rewardType, rewardValue, serviceId, active?` | `RewardDto`                                                                  |
| `updateRewardAction`            | `rewardId, rewardType, expectedVersion` + tous les champs modifiables                        | `RewardDto`                                                                  |
| `getClientLoyaltyAction`        | `clientId`                                                                                   | `ClientLoyaltySummaryDto` (solde, totaux, éligibilité de chaque récompense)  |
| `listClientLoyaltyLedgerAction` | `clientId, cursor?, limit?` (1 à 100)                                                        | `LoyaltyLedgerPageDto` (le plus récent d'abord, solde après chaque écriture) |
| `listLoyaltyBalancesAction`     | `clientIds?` (≤ 200)                                                                         | `LoyaltyBalanceDto[]` (clientes ayant au moins une écriture)                 |
| `listClientRedemptionsAction`   | `clientId`                                                                                   | `RedemptionDto[]`                                                            |
| `redeemRewardAction`            | `clientId, rewardId, requestId`                                                              | `RedemptionDto`                                                              |
| `fulfilRedemptionAction`        | `redemptionId, appointmentId?`                                                               | `RedemptionDto`                                                              |
| `cancelRedemptionAction`        | `redemptionId, reason?`                                                                      | `RedemptionDto`                                                              |
| `adjustPointsAction`            | `clientId, requestId, pointsDelta, reason`                                                   | `{ entryId }`                                                                |
| `reverseAdjustmentAction`       | `entryId, reason?`                                                                           | `{ entryId }`                                                                |

- **Éligibilité :** `eligible` est vrai si le programme est actif, la récompense active et disponible, et le solde suffisant. Sinon, `unavailableReason` vaut `program_inactive`, `inactive`, `service_missing` ou `currency_missing`, et `missingPoints` indique les points manquants, calculés sur le solde signé : `max(0, coût − solde)` (solde −10, coût 10 → 20). Un solde négatif n'autorise jamais un rachat.
- **Historique :** chaque écriture porte :
  - `reversesEntryId` / `reversedByEntryId` : afficher « annulé » sans recalcul ;
  - `awardGeneration` ;
  - `details` ;
  - `redemption` : l'instantané de l'attribution payée ou remboursée.
- **Timeline CRM existante :** elle affiche déjà ces écritures, sans changement de contrat.

## Erreurs

| Code                            | HTTP      | Cas                                                                |
| ------------------------------- | --------- | ------------------------------------------------------------------ |
| `unauthenticated` / `forbidden` | 401 / 403 | pas de session / pas membre de l'activité                          |
| `validation_error`              | 400       | entrée invalide ; `fieldErrors` nomme le champ                     |
| `client_not_found`              | 404       | cliente absente de cette activité                                  |
| `service_not_found`             | 404       | prestation absente de cette activité (règle, prestation offerte)   |
| `reward_not_found`              | 404       | récompense absente de cette activité                               |
| `redemption_not_found`          | 404       | attribution absente de cette activité                              |
| `loyalty_entry_not_found`       | 404       | écriture absente de cette activité                                 |
| `appointment_not_found`         | 404       | rendez-vous absent, ou d'une autre cliente (utilisation)           |
| `stale_loyalty_program`         | 409       | programme modifié depuis la lecture                                |
| `stale_reward`                  | 409       | récompense modifiée depuis la lecture                              |
| `idempotency_conflict`          | 409       | même `requestId`, autre commande                                   |
| `loyalty_program_inactive`      | 409       | attribution avec un programme inactif                              |
| `reward_unavailable`            | 409       | récompense désactivée ou prestation offerte supprimée              |
| `insufficient_points`           | 409       | solde insuffisant (attribution, débit manuel)                      |
| `invalid_redemption_transition` | 409       | utiliser une attribution annulée, annuler une attribution utilisée |
| `loyalty_entry_not_reversible`  | 409       | annuler par ajustement un gain, une attribution ou une correction  |

## Identité de la cliente et futur Client Hub

- La réservation publique ne vérifie pas la propriété de l'email saisi. Une fiche cliente peut donc regrouper des réservations faites par des personnes différentes avec le même email. Ce rattachement est un **indice**, pas une identité. Par conséquent :
  - aucune donnée de fidélité n'est exposée hors session professionnelle ;
  - les points ne naissent que d'un fait constaté par la professionnelle (le rendez-vous a eu lieu).
- `clients.loyalty_token_hash` existe depuis la fondation, mais **n'est lu par aucune fonction**. Ce n'est pas un moyen d'accès en V1.
- Le futur Client Hub devra :
  - prouver la possession de l'email (lien à usage unique) **avant** tout accès au solde ;
  - n'exposer qu'un DTO limité à la cliente concernée, par activité ;
  - ne jamais permettre à une cliente d'attribuer ou de dépenser des points sans validation de la professionnelle ;
  - traiter une fusion de fiches clientes en déplaçant les écritures par compensation (une écriture annulée sur l'ancienne fiche, une nouvelle sur la survivante), jamais en réécrivant `client_id`.

## Migration et données existantes

**Non destructive :**

- aucune écriture, récompense ni solde n'est modifié ;
- les gains historiques reçoivent la génération 1 ;
- les attributions historiques deviennent `fulfilled`, avec leur instantané ;
- les remises fixes historiques reçoivent la devise de l'activité (seule la nouvelle colonne est écrite).

**Valeurs historiques hors des nouvelles bornes** (description > 1 000 caractères, plus de 1 000 000 points, pourcentage > 100, remise > 10 000 000, programme hors bornes) : l'ancien schéma les acceptait. Elles sont **conservées intactes** (ni tronquées, ni plafonnées, ni supprimées), lisibles et utilisables. Les bornes s'appliquent par un trigger de garde (`rewards_bounds`, `loyalty_programs_bounds`) à toute valeur **nouvellement écrite** (insertion, ou colonne modifiée) ; une mise à jour qui laisse une valeur historique inchangée (activation, désactivation, action de clé étrangère) passe. Une contrainte `CHECK … NOT VALID` aurait rejeté toute mise à jour de ces lignes, y compris la migration elle-même. Les fonctions de modification suivent la même règle : renvoyer la valeur historique telle quelle est accepté, toute autre valeur hors bornes est refusée (`validation_error` sur le champ) ; normaliser est toujours possible. Les schémas zod de modification ne vérifient donc que la forme de ces valeurs ; PostgreSQL, qui connaît la valeur stockée, applique les bornes.

**Éligibilité des rendez-vous existants** (règle conservatrice, sans invention de faits) :

- un rendez-vous avec un gain historique est éligible ;
- un rendez-vous terminé sans aucun gain est non éligible (l'état du programme à sa complétion n'est pas prouvable) ;
- un rendez-vous terminé puis rouvert avant la migration sans gain ne laisse aucune trace (`completed_at` est effacé à la réouverture) : sa prochaine complétion est traitée comme la première.

**Changements de comportement :**

- **Opt-in :** les programmes créés actifs à l'inscription et jamais utilisés (aucune écriture) deviennent inactifs. Ceux qui ont un historique restent tels quels.
- **Écritures directes retirées :** les droits d'écriture directe des membres sur `loyalty_programs` et `rewards` (politiques RLS initiales) sont retirés au profit des fonctions validées.
- **Réouverture d'un rendez-vous terminé :** la règle « `completed` → `confirmed` refusé si des points ont été attribués » est remplacée par l'annulation compensatoire.

## Limites connues

- **Pagination et ajouts concurrents :** l'historique est paginé par curseur sur `ledger_seq` (une page = au plus 100 écritures ; la fonction SQL en renvoie au plus 101, la dernière ne servant qu'à savoir s'il existe une page suivante). Sur des données stables, aucune écriture n'est sautée ni répétée. Chaque page est une lecture distincte, pas un instantané commun : une écriture ajoutée pendant le parcours, plus récente, n'apparaît pas dans les pages suivantes mais en tête après rechargement. Une écriture dont le numéro a été attribué avant celui d'une écriture déjà affichée mais validée plus tard (transactions concurrentes) peut ne pas apparaître pendant ce parcours ; elle apparaît au rechargement.
- **Suppression d'un compte professionnel :** les écritures qu'il a créées sont conservées, sans auteur (`created_by` vidé), comme partout ailleurs dans le produit.
- **Numérotation des écritures historiques :** à la migration, elles sont numérotées dans l'ordre de leur date (`created_at`).

## Hors périmètre (V1)

- **Écrans :** aucun écran fidélité, aucun Client Hub, aucune authentification cliente.
- **Emails :** aucun email de fidélité. Les types `points_earned` et `reward_unlocked` de l'outbox restent inutilisés, et l'envoi n'est pas configuré.
- **Paiement et caisse :** aucune déduction automatique d'une remise au moment de la réservation.
- **Fonctionnalités de programme :** pas d'expiration des points, pas de niveaux, pas de limite d'utilisation par cliente.
