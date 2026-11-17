# Équipe : contrat servi (lots 1 à 3)

Réponse de Cloud à `docs/TEAM_PROPOSAL.md` (PR #64). Les formes `TeamDto`
et `TeamMemberDto`, ainsi que les cinq actions, sont servies **telles que
proposées**. Les écarts sont listés en fin de document.

## Actions serveur

Fichier : `src/features/team/actions/team.ts`. Ensemble, elles forment l'objet
`TeamActions` de l'écran.

| Contrat UI     | Action serveur                                   | Fonction SQL                 |
| -------------- | ------------------------------------------------ | ---------------------------- |
| `read`         | `readTeamAction`                                 | `get_team`                   |
| `createStaff`  | `createStaffAction`                              | `create_staff_member`        |
| `updateStaff`  | `updateStaffAction`                              | `update_staff_member`        |
| `sendInvite`   | `sendInviteAction`                               | `send_team_invitation`       |
| `revokeAccess` | `revokeAccessAction`                             | `revoke_team_access`         |
| (nouveau)      | `acceptTeamInviteAction({ token? })`             | `accept_team_invitation`     |
| (nouveau)      | `completeTeamInviteAction({ password, token? })` | `accept_team_invitation_for` |

Réponse : `{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }`.
C'est un sur-ensemble de `TeamResult` : l'écran peut ignorer `message`.

## Garanties

- **Rejeu.** `operationId` rejoué avec la même commande : la réponse
  enregistrée est renvoyée telle quelle, rien n'est réappliqué. Avec une
  commande différente : `idempotency_conflict`. Un refus n'est pas enregistré :
  un nouvel essai avec le même `operationId` est rejoué normalement.
- **Révision.** Chaque écriture (y compris l'invitation et le retrait
  d'accès) incrémente `revision`. Une révision périmée donne `version_conflict`.
- **Verrou.** Toutes les écritures prennent le verrou `business_schedule` :
  une réservation et un changement d'équipe ne s'entrelacent jamais. Deux
  propriétaires qui se retirent mutuellement ne peuvent pas réussir toutes
  les deux.
- **404 opaque.** Un profil d'un autre établissement ou inexistant donne
  `not_found`. Un compte sans appartenance à l'établissement : `forbidden`
  (lecture comprise).
- La lecture ne contient jamais de jeton ni de lien. Seule l'empreinte
  SHA-256 du jeton est stockée.

## Rôles

| Action                            | owner | admin               |
| --------------------------------- | ----- | ------------------- |
| lire, créer, modifier un profil   | oui   | oui                 |
| inviter (rôle `admin`)            | oui   | `permission_denied` |
| retirer l'accès d'un autre compte | oui   | `permission_denied` |
| retirer son propre accès          | oui   | oui                 |

Ni `last_owner` ni l'attribution de `owner` par invitation ne sont possibles
(proposition validée).

## Refus

`version_conflict`, `last_owner`, `upcoming_appointments`,
`permission_denied` (codes proposés), et en plus :

| Code                                 | Quand                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `not_found`                          | profil introuvable ou d'un autre établissement                                              |
| `idempotency_conflict`               | même `operationId`, commande différente                                                     |
| `access_exists`                      | le profil a déjà un compte, ou l'adresse est déjà membre                                    |
| `team_limit_reached`                 | 100 profils                                                                                 |
| `validation_error`                   | nom vide ou > 80, service inconnu ou d'un autre établissement, e-mail                       |
| `invitation_invalid`                 | acceptation : jeton inconnu, remplacé, révoqué, expiré ou déjà utilisé                      |
| `invitation_email_mismatch`          | acceptation : compte connecté avec une autre adresse, ou non confirmée                      |
| `already_member`                     | acceptation : ce compte appartient déjà à un établissement                                  |
| `invitation_email_unavailable` (503) | invitation : aucun transport d'e-mail (rien n'est enregistré), ou e-mail refusé (réinviter) |
| `invitation_password_required`       | acceptation : session ouverte par un lien de récupération, mot de passe à choisir d'abord   |
| `beta_invitation_required`           | acceptation sans jeton, et aucun gardé sur l'appareil                                       |

## Rejoindre l'équipe (lot 2)

**E-mail.** `sendInviteAction` enregistre l'invitation puis envoie l'e-mail
directement par le transport configuré (comme le code du Hub : le lien n'est
jamais stocké). Sans transport, rien n'est enregistré
(`invitation_email_unavailable`). Si l'e-mail est refusé après
l'enregistrement, même code : réessayer avec le **même** `operationId`
renvoie l'e-mail avec un nouveau lien (l'ancien ne marche plus), tant que
l'invitation est en attente. Lien : `/equipe/invitation?token=team_…`, valable 7 jours.

**Le jeton passe dans les formulaires existants.** Le champ
`invitationToken` de `signUpAction` et `signInAction` accepte aussi un jeton
`team_…`. L'accès bêta n'est pas demandé pour l'adresse invitée dans
l'équipe.

| Situation de l'adresse invitée                    | Parcours                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aucun compte                                      | `signUpAction` → `confirmation_required`. Le lien de confirmation ramène sur `/equipe/invitation` (jeton gardé sur l'appareil, 2 h) → `acceptTeamInviteAction({})`                                                                                            |
| compte confirmé                                   | `signUpAction` → `email_taken`. Elle se connecte : `signInAction({ …, invitationToken })` → `invitation: "accepted"` (ou le code du refus, elle reste connectée)                                                                                              |
| compte non confirmé (peut-être créé par un tiers) | `signUpAction` → `confirmation_required`, mais c'est un lien de récupération qui part. Sur `/equipe/invitation`, `acceptTeamInviteAction` répond `invitation_password_required` : la page demande son mot de passe → `completeTeamInviteAction({ password })` |
| déjà connectée avec l'adresse                     | `/equipe/invitation?token=…` → `acceptTeamInviteAction({ token })`                                                                                                                                                                                            |

Réponse des deux actions d'acceptation : `{ businessId, next: "/app" }`.

**Garanties (même règle que la bêta).** L'invitation n'est jamais la preuve
qu'un compte est le sien. Elle n'est acceptée que par une session qui a
prouvé son mot de passe, par le compte que le serveur vient de créer avec son
mot de passe, ou après un lien de récupération suivi de son nouveau mot de
passe. Ses autres sessions sont fermées avant, une fois l'invitation vérifiée (un
mauvais lien ne ferme rien). « Une activité par compte » est vérifiée sous
le verrou du compte : deux invitations acceptées en même temps ne passent
pas toutes les deux. L'accès est ensuite lié à
cette session, ou aux sessions ouvertes après. Une session plus ancienne (un
tiers qui connaissait le compte) n'ouvre jamais l'établissement, même si sa
fermeture a échoué. Le compte d'un tiers n'est jamais modifié par
l'invitation : son mot de passe est remplacé seulement par celle qui prouve
la boîte mail.

**Page à créer côté UI : `/equipe/invitation`.** Tant qu'elle n'existe pas,
les liens de confirmation et de récupération arrivent sur une 404. Elle lit
`token` dans l'URL (ou rien après une confirmation). Recommandé : en-tête
`Referrer-Policy: no-referrer`, et retirer le jeton de l'URL affichée dès sa
lecture (`history.replaceState`).

- non connectée : formulaires d'inscription et de connexion avec
  `invitationToken` ;
- connectée : `acceptTeamInviteAction` ;
- sur `invitation_password_required` : champ mot de passe, puis
  `completeTeamInviteAction`.

## Rôle praticienne (lot 3)

L'owner invite avec `role: "practitioner"`. **Refus par défaut** :
`is_business_member`, qui porte toutes les règles RLS et la plupart des
portes, ne reconnaît que owner et admin. La praticienne n'obtient que ces
droits explicites :

| Elle peut                                                                                        | Comment                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lire son établissement, ses réglages, horaires, exceptions et catalogue                          | lecture directe (RLS)                                                                                                                                                                                                                                                          |
| lire son appartenance, les profils de l'équipe (noms) et ses préférences                         | lecture directe (RLS)                                                                                                                                                                                                                                                          |
| lire **ses** rendez-vous (`staff_id` = son profil), notes internes du rendez-vous comprises      | lecture directe                                                                                                                                                                                                                                                                |
| son agenda : ses rendez-vous avec nom, e-mail et téléphone de chaque cliente                     | `practitioner_agenda(businessId, from, to)`, 62 jours au plus                                                                                                                                                                                                                  |
| son agenda par jours locaux, avec l'horloge de l'établissement (`business_time` lui reste fermé) | `practitioner_agenda_days(businessId, fromDate?, days ≤ 62)` → `{ timezone, now, today, todayEndsAt, days: [{ date, startsAt, endsAt }], visits }` ; `fromDate` absent = aujourd'hui de l'établissement ; bornes des jours calculées par la base (changements d'heure compris) |
| marquer ses visites réalisées ou manquées, et les rouvrir                                        | `agenda_set_appointment_status` sur ses propres rendez-vous                                                                                                                                                                                                                    |

**Fermé pour elle** :

- les notes privées, la fidélité, les e-mails, le calendrier externe, le
  site, l'accès au Hub, les campagnes, les formulaires, le consentement ;
- l'équipe (`get_team`), le CRM (`crm_*`), le catalogue en écriture ;
- toute autre écriture d'agenda : création, déplacement, annulation.
- Le rendez-vous d'une collègue répond `appointment_not_found`.

Les portes qui lisaient l'appartenance directement exigent désormais owner ou
admin (agenda, site, connexion du calendrier).

**Fiches clientes** : elle ne lit aucune ligne `clients` directement, car
une fiche porte des colonnes privées (anciennes notes internes, jeton de
fidélité). L'agenda pro joint `clients` : pour une praticienne, il faut
utiliser `practitioner_agenda` à la place. **Quitter l'établissement** : une
praticienne ne peut pas retirer son propre accès, c'est l'owner qui le fait.

**Pour l'écran** : `SessionState.business.role` et `BusinessContext.role`
donnent le rôle. Pour une praticienne, il faut afficher l'agenda (ses
rendez-vous) et la sortie de session, et masquer le reste, que le serveur
refuse de toute façon.

## Écarts avec la proposition

1. **`practitioner`** : attribuable depuis le lot 3 (voir « Rôle
   praticienne »). `role_unavailable` ne sert plus.
2. **E-mail d'invitation** : servi au lot 2 (voir « Rejoindre l'équipe »).
   En staging, tant qu'aucun transport n'est configuré, inviter répond
   `invitation_email_unavailable`.
3. **Agenda unique.** Le profil, ses prestations et `bookable` sont
   enregistrés, et les rendez-vous portent un `staff_id`. En revanche, les
   créneaux publics ne sont pas encore calculés par personne : un seul agenda
   par établissement, comme aujourd'hui. Un nouveau rendez-vous est attribué
   au seul profil réservable s'il n'y en a qu'un, sinon il n'est pas attribué
   (jamais deviné). Le calcul par personne est un lot à part.
4. **Existant.** Chaque membre actuel reçoit un profil. La propriétaire la
   plus ancienne est réservable pour toutes ses prestations, et ses
   rendez-vous lui sont rattachés. Tant qu'elle est seule, une nouvelle
   prestation lui est attribuée automatiquement.
