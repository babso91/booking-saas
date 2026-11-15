# Liste d'attente : contrat servi (M2-R06)

Réponse de Cloud à `docs/WAITLIST_PROPOSAL.md` (PR #61). Inscription et
offre sont servies **telles que proposées**, avec les écarts listés en fin de
document. Migration : `supabase/migrations/20261115140000_waitlist.sql`.

## Principe

- **Aucun créneau n'est mis de côté.** Quand un rendez-vous est annulé ou
  déplacé (par n'importe qui), l'intervalle libéré est inscrit
  (`private.capacity_releases`, PR #90). Le traitement planifié relit le
  moteur de créneaux public et propose le premier horaire devenu possible à
  la **plus ancienne** demande admissible (FIFO), pendant **20 minutes** au
  plus (moins si le délai minimal de réservation l'impose). La réservation
  publique reste ouverte : le premier qui réserve gagne.
- **L'établissement l'active** : `business_settings.waitlist_enabled`
  (action `setWaitlistEnabledAction`, owner/admin). La fermer arrête les
  offres en cours.
- **Double opt-in.** Une demande commence `pending_confirmation`. Rien n'est
  proposé tant que la cliente n'a pas confirmé depuis l'e-mail reçu (24 h).

## Routes

| Route                                 | Entrée                                                                       | Réponse                      |
| ------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `POST /api/waitlist/requests`         | corps de la proposition                                                      | `{ id, state, activeUntil }` |
| `POST /api/waitlist/requests/confirm` | `{ token }`                                                                  | `{ id, state, activeUntil }` |
| `GET /api/waitlist/offers/:id`        | en-tête `X-Waitlist-Token`                                                   | `Offer`                      |
| `POST /api/waitlist/offers/:id/claim` | `X-Waitlist-Token` + `{ requestId, expectedVersion, expectedQuoteRevision }` | `Offer` (`booked`)           |
| `GET/POST /api/cron/waitlist`         | `Authorization: Bearer CRON_SECRET`                                          | `{ signals, offers, sent }`  |

`POST /requests` et `…/claim` passent par la même identité d'entrée que la
réservation publique (proxy de confiance).

## Liens et jetons (« accès à l'offre »)

- Lien de confirmation : `/liste-attente/confirmer#t=<jeton>`.
- Lien d'offre : `/liste-attente/offre/<offerId>#t=<jeton>`.
- Le jeton est dans le **fragment** (après `#`) : le navigateur ne l'envoie
  jamais au serveur et ne le met pas dans le referrer. La page le lit et
  l'envoie à l'API (corps pour la confirmation, en-tête `X-Waitlist-Token`
  pour l'offre). Seule son empreinte SHA-256 est stockée. Un jeton d'offre
  ne donne accès qu'à cette offre (ni Hub ni fiche CRM).
- Pages à créer côté UI : `/liste-attente/confirmer` et
  `/liste-attente/offre/[offerId]`.

## Garanties

- **Fenêtres** : 1 à 5, jours civils de l'établissement, entre aujourd'hui et
  `min(14 jours, horizon de l'établissement)` ; `startMinute < endMinute`,
  0 à 1440. `anyTime` : toute la période, sans fenêtres. La visite entière
  tient dans la fenêtre (le tampon est vérifié par le moteur).
- **Une offre ouverte au plus par demande**, et jamais deux offres ouvertes
  sur le même temps. Deux traitements simultanés ne prennent pas le même
  signal (bail et `skip locked`).
- **Revendication** : verrou du planning, puis demande, puis offre. Devis
  vérifié (`quoteRevision`), puis réservation par
  `private.create_public_booking_at` (mêmes contrôles, limites d'abus et
  contrainte d'exclusion qu'une réservation publique). Créneau pris
  entre-temps : l'offre passe `unavailable` **durablement**, la demande reste
  active, réponse `offer_unavailable`. Réussite : offre `booked`, demande
  consommée, autres offres sur ce temps `unavailable`. Rejeu avec le même
  `requestId` : même réponse.
- **Abus** : 10 demandes par heure et par réseau, 3 demandes ouvertes par
  adresse et par établissement (`rate_limited`).
- **E-mails** : envoyés directement par le transport configuré (comme le code
  du Hub). **Sans transport, aucune offre n'est créée** (une offre invisible
  bloquerait la demande suivante). La demande est enregistrée, mais ne peut
  pas être confirmée tant qu'aucun e-mail ne part.

## Refus

| Code                                                                 | Quand                                             |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| `waitlist_unavailable` (409)                                         | l'établissement n'a pas ouvert sa liste           |
| `service_not_found` (404)                                            | prestation absente ou non réservable publiquement |
| `validation_error` (400)                                             | fenêtres, prénom, e-mail                          |
| `rate_limited` (429)                                                 | limites ci-dessus                                 |
| `idempotency_conflict`                                               | même `requestId`, autre contenu                   |
| `waitlist_request_not_found`                                         | lien de confirmation inconnu ou expiré            |
| `waitlist_offer_not_found`                                           | offre inconnue ou mauvais jeton (même réponse)    |
| `offer_expired`, `offer_unavailable`, `stale_offer`, `quote_changed` | comme la proposition                              |

## Écarts avec la proposition

1. **`waitlist_unavailable`** : nouveau code quand la liste n'est pas
   ouverte (le bouton ne devrait pas s'afficher dans ce cas).
2. **Pages de lien** : le jeton passe par le fragment de l'URL (voir
   ci-dessus).
3. **Hors lot** : vue de la professionnelle, désinscription depuis l'e-mail,
   liste d'attente dans le Hub, mode « plusieurs destinataires ». Mesures
   (places libérées, remplies, délais) : à construire avec des données
   réelles.
