# Offre, changement de formule et facturation : contrat servi (M7-R01 à R03, simulé)

Réponse de Cloud aux propositions :

- #60 (`docs/PLATFORM_OFFERS_PROPOSAL.md`) ;
- #76 (`PLAN_CHANGE_PROPOSAL.md`) ;
- #77 (`BILLING_SUMMARY_PROPOSAL.md`).

Migration : `supabase/migrations/20261116120000_platform_billing.sql`.

**Simulé.** Aucun prestataire de paiement n'est branché, rien n'est jamais
débité, et `simulated` vaut toujours `true`. **Aucun droit ne bouge sans
événement de paiement vérifié**, reçu par le webhook signé. En staging, un
changement confirmé reste donc `requested`.

## Réponses aux questions

1. **Qui porte l'offre ?** L'établissement, avec un abonnement par
   établissement. Le droit effectif reste celui du site (`sites.plan`,
   l'autorité du Studio) : un changement appliqué l'écrit là, et nulle part
   ailleurs. Un établissement sans site est en Core.
2. **TTC.** `displayTaxMode: "ttc"` sur chaque prix.
3. **`listOffers`** : l'action `listOffersAction()`, lisible aussi sans
   connexion (`platform_list_offers`), donc utilisable plus tard par la page
   publique des tarifs.

## Actions (`src/features/platform-billing/actions.ts`)

| Contrat UI            | Action                           | Qui                                         |
| --------------------- | -------------------------------- | ------------------------------------------- |
| `listOffers`          | `listOffersAction()`             | tout le monde                               |
| `summary` / `current` | `getBillingSummaryAction()`      | membres                                     |
| `quote`               | `quotePlanChangeAction(input)`   | owner                                       |
| `confirm`             | `confirmPlanChangeAction(input)` | owner                                       |
| `cancelScheduled`     | `cancelScheduledChangeAction`    | owner                                       |
| `requestCancellation` | `requestCancellationAction`      | owner                                       |
| `undoCancellation`    | `undoCancellationAction`         | owner                                       |
| `invoices`            | `listInvoicesAction()`           | owner                                       |
| `openPortal`          | `openBillingPortalAction()`      | `billing_unavailable` tant que c'est simulé |

- **Résumé** : `BillingSummaryDto` (proposition de #77), avec en plus
  `cadence` et `pending`, le changement en cours au format `PlanChangeDto`.
  Il sert aussi de `current` pour #76 : `{ plan, cadence, revision, pending }`.
- **Prix provisoires** : le modèle commercial n'est pas arrêté. Chaque offre
  porte `provisional: true`, et rien n'est jamais débité.
- **Composant par professionnelle réservable**, prévu sans être figé :
  - une version de prix peut porter `included_bookable_staff` (le nombre de
    professionnelles incluses) et `extra_staff_amount_minor` (le prix de
    chacune au-delà) ;
  - le montant récurrent vaut alors la base, plus chaque professionnelle
    réservable au-delà des incluses ;
  - un compte administratif non réservable ne compte jamais ;
  - **aucune version n'en a aujourd'hui** (`perBookableStaff: null`).
  - Le décompte passe par une seule fonction,
    `private.platform_bookable_staff_count`, qui vaut 1 tant que le lot Équipe
    n'est pas fusionné. À sa fusion, elle comptera les profils réservables.
- **Prix** : versions immuables (`price_version_id`). Au départ : Core
  2900/mois ou 29000/an, Signature 4900/mois ou 49000/an. Un nouveau prix
  passe par une nouvelle version, et un devis valide garde l'ancienne.
- **L'abonnement de départ** reprend l'état actuel : le plan du site, actif,
  « hérité » (rien n'a été payé).

## Devis et confirmation

- **Devis** : `BillingQuoteDto` de #76. Il est immuable, valable 15 minutes,
  et conservé côté serveur. La confirmation le désigne par `quoteId`, jamais
  par un montant.
- **Règles de prix :**
  - **Rien de payé encore** (état hérité, ou abonnement terminé), **ou
    changement de cadence** : le prix entier de la cible, et une nouvelle
    période qui commence au paiement vérifié.
  - **Même cadence, prix plus élevé** : maintenant, au prorata du reste de la
    période payée, 1 au minimum. Exemple : Core payé à mi-mois, puis
    Signature, donne `dueNowMinor` 1000, puis 4900 par mois.
  - **Même cadence, prix inférieur ou égal (une baisse)** : en fin de période,
    rien à payer maintenant. Elle ne s'applique qu'à un renouvellement payé au
    **nouveau** prix.
  - **Une hausse ne se programme jamais en fin de période.**
- **Refus du devis :** `billing_state_changed` si la révision est périmée (une
  révision nulle compte comme périmée), si un changement est déjà en cours,
  ou si la période est échue ou impayée (il faut renouveler d'abord).
- **Confirmation :**
  - Un changement immédiat devient `requested` : aucun droit avant le
    paiement vérifié. Il expire au bout d'une heure sans paiement.
  - Un changement en fin de période devient `scheduled`.
  - Les deux s'annulent par `cancelScheduledChangeAction`.
  - Un seul changement non résolu par établissement. Rejeu par `operationId`
    (même contenu et même auteur).

## Événements de paiement : `POST /api/billing/events`

- **Authentification** : HMAC du corps brut,
  `X-Billing-Signature: sha256=<hex>` avec `BILLING_WEBHOOK_SECRET` (32
  caractères au moins). Sans secret, tout est refusé (503).
- **Enregistrement** : un seul effet par `eventId`, avant l'acquittement. Une
  redistribution donne un doublon neutre.
- **Version** : `sourceVersion` ordonne les événements d'un même objet, et un
  événement plus ancien est ignoré. Un événement qui ne désigne rien de connu
  est mis de côté pour rapprochement (`staged`), jamais appliqué.
- **Les quatre types d'événements :**
  - `payment_succeeded` (`commandId`, `amountMinor`, `currency` facultatif,
    EUR par défaut). Le paiement d'un changement ouvert s'applique (les droits
    bougent) et émet une facture, seulement si trois conditions tiennent :
    - le montant est celui du devis ;
    - la devise est la sienne ;
    - pour un prorata, la période est toujours celle du calcul.

    Sinon, ou si le changement n'est plus ouvert (annulé, expiré, échoué),
    l'événement est **mis de côté pour rapprochement (`staged`), jamais
    appliqué**.

  - `payment_failed` : le changement échoue, les droits restent les mêmes.
  - `renewal_succeeded` (`businessId`, `amountMinor`) : nouvelle période d'un
    abonnement payant, à son prix, ou au nouveau prix de la baisse programmée
    pour cette échéance (qui s'applique alors). Tout autre montant est refusé
    (`rejected`). Un abonnement qui ne paie rien (hérité, terminé) donne
    `staged`.
  - `renewal_failed` : l'abonnement passe en `past_due`, les droits restent
    jusqu'à la fin de la grâce (7 jours par défaut, 30 au plus). Aucune
    mention publique de l'impayé.

## Résiliation et horloge (`GET|POST /api/cron/platform`, toutes les heures)

- **Résiliation** : à la fin de la période. Elle reste annulable jusque-là,
  et l'abonnement reste actif d'ici là.
- **À l'échéance** : une résiliation arrivée à son terme, ou une grâce
  expirée, termine l'abonnement (`ended`). La formule revient à Core, et les
  données sont gardées. Repartir se fait comme un premier paiement.
- **Commandes en attente** : une commande `requested` restée sans paiement
  expire.
- **Factures** : rattachées à l'établissement et à la période, avec un
  montant et une devise figés, et `simulated: true`.

## Refus

`quote_expired`, `billing_state_changed` (révision périmée, changement déjà
en cours), `billing_unavailable`, `promo_unavailable` (aucun code
promotionnel pour l'instant), `permission_denied` (une admin), `forbidden`,
`idempotency_conflict`.

## Écarts et hors lot

1. **Pas de code promo**, pas d'essai sans carte, pas de quotas par
   capacité : `getCapabilities` reste la lentille du Studio.
2. **Pas de prestataire** : pas de portail, pas d'action 3DS
   (`requires_action` n'est jamais produit), et pas de taxes calculées.
3. **Atelier (M7-R04)** : lot à part.
