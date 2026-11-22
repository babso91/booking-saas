# Séries de rendez-vous : contrat servi (M2-R07)

Réponse de Cloud à `docs/APPOINTMENT_SERIES_PROPOSAL.md` (PR #67). L'aperçu
et la confirmation sont servis **tels que proposés**, avec les écarts listés
en fin de document. Migration :
`supabase/migrations/20261115130000_appointment_series.sql`.

## Actions serveur

Fichier : `src/features/appointment-series/actions.ts` (`runBusinessAction`,
mêmes droits que l'agenda pro).

| Contrat UI | Action                | Fonction SQL                 |
| ---------- | --------------------- | ---------------------------- |
| aperçu     | `previewSeriesAction` | `preview_appointment_series` |
| confirmer  | `commitSeriesAction`  | `commit_appointment_series`  |

Entrées et sorties : `SeriesPreviewInput` / `SeriesPreview` et
`SeriesCommitInput` → `{ seriesId, appointmentIds }`, telles que proposées.
`firstLocalStart` est une heure murale `YYYY-MM-DDTHH:MM[:SS]` dans le fuseau
de l'établissement.

## Aperçu

- Il ne réserve rien. Il est conservé côté serveur une heure : son
  `previewVersion` est son identifiant, et la confirmation relit la règle,
  les choix et le prix **depuis le serveur**.
- Au plus **12** occurrences (`too_many_occurrences`, avec un nombre comme
  avec une date de fin). Répétition toutes les 1 à 52 semaines.
- **Heure civile gardée.** Chaque date est résolue par la même autorité que
  l'agenda (`private.resolve_local`) :
  - `ambiguous` (heure répétée en automne) : les deux instants, le plus tôt
    d'abord. Un choix explicite est obligatoire ;
  - `nonexistent` (heure sautée au printemps) : **un seul candidat, la même
    heure une heure plus tard**, à accepter explicitement ou à retirer
    (proposition de l'UI retenue) ;
  - `outside_horizon` : passée, ou à plus d'un an ;
  - `conflict` : chevauche un rendez-vous existant, tampon compris.
- Clé d'occurrence : `o1`, `o2`, … (rang dans la règle, stable pour un aperçu).

## Confirmation (tout ou rien)

- Sous le verrou du planning : le devis est recalculé (`quote_changed` s'il
  diffère de l'aperçu). Chaque date choisie doit venir de l'aperçu, avec l'un
  de ses candidats (`series_stale` sinon). Collisions contre l'agenda et
  entre les dates du lot : `calendar_conflict`.
- Chaque occurrence est créée par `agenda_create_appointment` : mêmes
  instantanés, mêmes règles et même contrainte d'exclusion qu'un rendez-vous
  seul. Elles sont rattachées à la série (`appointments.series_id`). Une seule
  en échec : **rien n'est créé**.
- **Rejeu** par `requestId` : même contenu et même auteur, même réponse.
  Sinon `idempotency_conflict`.
- Une occurrence est ensuite un rendez-vous ordinaire : l'annuler ou la
  déplacer depuis l'agenda (`agenda_set_appointment_status`,
  `agenda_update_appointment`) ne touche pas les autres, et elle reste
  rattachée à la série. Sa place libérée redevient disponible.
- E-mails : chaque date reçoit son propre rappel, comme un rendez-vous saisi
  par la professionnelle, et aucune confirmation groupée. Une date déplacée
  reçoit un nouveau rappel ; une date annulée n'en reçoit plus.
- Réservé au propriétaire et aux admins (`forbidden` pour une praticienne).

## Refus

| Code                                                          | Quand                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `too_many_occurrences`                                        | plus de 12 dates                                                            |
| `calendar_conflict`                                           | dates prises ; leurs clés dans `error.fieldErrors.keys`                     |
| `quote_changed`                                               | prix ou durée changés depuis l'aperçu                                       |
| `series_stale`                                                | aperçu inconnu, d'un autre compte ou de plus d'une heure ; date hors aperçu |
| `idempotency_conflict`                                        | même `requestId`, autre contenu                                             |
| `service_unavailable`, `client_not_found`, `validation_error` | entrées                                                                     |

## Écarts avec la proposition

1. **`calendar_conflict`** : les clés sont dans `error.fieldErrors.keys`
   (pas de champ `keys` à la racine de l'erreur).
2. **Horizon** : d'aujourd'hui à un an (pas l'horizon de la réservation
   publique : c'est la pro qui planifie). Les heures d'ouverture ne sont pas
   imposées, comme pour un rendez-vous créé par la pro.
3. **Aperçu périmé au bout d'une heure** (`series_stale`) : un nouvel aperçu
   suffit.
