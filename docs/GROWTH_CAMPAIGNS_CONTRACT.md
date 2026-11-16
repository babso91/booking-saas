# Relances et réactivation : contrat servi (R4-01, tranche campagne)

Réponse de Cloud à `docs/GROWTH_CAMPAIGNS_PROPOSAL.md` (PR #68). Le contrat
`CampaignActions` est servi **tel que proposé**, avec les écarts listés en fin
de document. Il s'appuie sur le registre de consentement
(`docs/MARKETING_CONSENT_CONTRACT.md`, PR #95). Migration :
`supabase/migrations/20261115170000_growth_campaigns.sql`.

**Envois simulés uniquement.** Le seul transport marketing est
`SimulatedMarketingTransport`, donc aucun message réel ne peut partir.
`simulated` vaut toujours `true`. Le brancher sur un vrai fournisseur demande
plusieurs accords : le fournisseur et l'identité d'expéditeur, la validation
juridique de l'opt-in, et le budget.

## Actions (`src/features/growth-server/actions.ts`, owner et admin)

| Contrat UI | Action                   | Fonction SQL       |
| ---------- | ------------------------ | ------------------ |
| `estimate` | `estimateCampaignAction` | `growth_estimate`  |
| `schedule` | `scheduleCampaignAction` | `growth_schedule`  |
| `read`     | `readCampaignAction`     | `growth_read`      |
| `setState` | `setCampaignStateAction` | `growth_set_state` |

Formes `AudienceEstimate` et `CampaignDto` : celles de la proposition.

## Règles

- **Critères fermés.** Les critères `rebooking` et `reactivation` portent sur
  la date de début des visites `completed`. Les notes, réponses, images et
  autres champs sensibles ne sont jamais utilisés.
- **Motifs d'exclusion,** dans cet ordre :
  1. `future_appointment` : un rendez-vous confirmé à venir ;
  2. `last_visit_not_completed` : la dernière visite passée est annulée ou
     manquée ;
  3. `unreachable` : pas d'e-mail, ou pas de téléphone pour un SMS ;
  4. `no_consent` : le consentement marketing n'est pas `granted` pour ce
     canal ;
  5. `recent_contact` : un message marketing sur ce canal depuis moins de
     14 jours.
- **Estimation.** Elle ne renvoie que des nombres, jamais de nom, et reste
  valable 15 minutes. Une campagne consomme une estimation. Une estimation
  périmée ou déjà utilisée donne `estimate_stale`.
- **Unités.** Un e-mail vaut 1. Un SMS compte comme le réseau :
  - en alphabet GSM : 160 caractères pour une partie, 153 par partie au-delà ;
    `^ { } \ [ ~ ] | €` comptent pour deux ;
  - sinon (UCS-2) : 70 pour une partie, 67 par partie au-delà ; un emoji
    compte pour deux.

  Au-delà de 4 parties : `invalid_input`. **Le chiffre qui fait foi est
  `estimatedUnits`, renvoyé par le serveur.** L'aperçu `smsUnits` côté écran
  est une approximation.

- **Budget du mois** (fuseau de l'établissement), par canal. Simulé par
  défaut : 2000 e-mails et 500 SMS.
  - Planifier engage le plafond `maxUnits` : `quota_exceeded` s'il dépasse le
    reste du budget.
  - À la fin (terminée ou annulée), le plafond non utilisé revient au budget.
- **Planification.** L'audience est réévaluée au moment de planifier : une
  occurrence par cliente et par campagne, `planned` ou `suppressed`. Rejeu
  par `requestId`.

## Envoi (worker, `GET|POST /api/cron/growth`, `Bearer CRON_SECRET`)

- **File séparée** du transactionnel : un rappel de rendez-vous n'attend
  jamais une campagne.
- **Réclamation.** Le worker réclame des lots bornés (`skip locked`), avec un
  bail de 60 secondes et un jeton de garde. Un worker plus lent, dont le bail
  a expiré, voit sa vérification et son compte rendu refusés (`stale`).
- **Dernière vérification avant l'envoi,** sous le verrou de consentement de
  la cliente, puis de l'occurrence, puis de la campagne. Elle relit les
  critères, le rendez-vous à venir, la dernière visite, la coordonnée, le
  consentement, la cadence et les unités de la campagne. Un retrait validé
  avant cette vérification empêche l'envoi.
- **Envoi** hors transaction, avec une clé de livraison stable (l'id de
  l'occurrence).
  - E-mail : lien de désinscription dans le texte, et en-têtes
    `List-Unsubscribe` et `List-Unsubscribe-Post` (un clic, RFC 8058).
- **Résultats :**
  - `accepted` : pris en charge par le prestataire, ce qui ne prouve pas la
    réception. Les unités sont comptées.
  - `rejected` : échec définitif.
  - `transient` : rien n'est parti. L'occurrence est replanifiée, 3 essais au
    plus.
  - Réponse perdue : `uncertain`. Les unités restent réservées, et aucun
    nouvel essai n'a lieu avant le rapprochement par clé (`lookup`).
- **Reprise après un arrêt.** Une occurrence remise au transport dont le
  compte rendu n'est jamais arrivé (le worker s'est arrêté entre les deux)
  devient `uncertain` après 5 minutes. Elle est alors rapprochée par clé,
  jamais renvoyée à l'aveugle. Un passage du worker s'arrête de remettre des
  messages après 35 secondes : les réclamations restantes expirent et
  partiront au passage suivant.
- **Pause.** Les messages en attente attendent ; ceux déjà remis peuvent
  arriver. **Annulation** : les messages en attente ne partent jamais.
  Une campagne annulée affiche `pending: 0`. `version_conflict` en cas de
  version périmée, `campaign_closed` sur une campagne terminée ou annulée.
  Les unités d'un message incertain rapproché après la clôture reviennent au
  budget s'il n'est pas parti.
- **Réservations attribuées.** On compte les rendez-vous créés par une
  destinataire dans les 14 jours suivant l'acceptation de son message. C'est
  une fenêtre déclarée : aucune causalité n'est affichée.

## Refus

`estimate_stale`, `quota_exceeded`, `version_conflict`, `campaign_closed`,
`campaign_not_found` (404), `idempotency_conflict`, `forbidden` (praticienne
ou autre établissement) et `invalid_input` (critères hors V1, message vide ou
trop long).

## Écarts avec la proposition

1. **Deux motifs ajoutés** à `suppressedByReason`, uniquement au moment de
   l'envoi :
   - `no_longer_matching` : la cliente ne correspond plus aux critères (par
     exemple, elle est revenue entre-temps) ;
   - `budget_exhausted` : le plafond de la campagne est atteint.
2. **Attribution par fenêtre.** Les liens de réservation ne portent pas
   encore la référence de la campagne. L'attribution par référence viendra
   avec les vrais envois.
3. **SMS.** La mention STOP et le numéro court relèvent du fournisseur SMS,
   qui n'est pas encore choisi. Les unités sont calculées sur le message
   seul.
4. **Hors lot** : le réglage du budget par l'owner, la liste des campagnes,
   les cohortes de rétention et l'heure creuse.
