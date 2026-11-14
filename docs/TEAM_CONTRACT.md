# Équipe : contrat servi (lot 1)

Réponse de Cloud à `docs/TEAM_PROPOSAL.md` (PR #64). Les formes `TeamDto`
et `TeamMemberDto`, ainsi que les cinq actions, sont servies **telles que
proposées**. Les écarts sont listés en fin de document.

## Actions serveur

Fichier : `src/features/team/actions/team.ts`. Ensemble, elles forment l'objet
`TeamActions` de l'écran.

| Contrat UI     | Action serveur                      | Fonction SQL             |
| -------------- | ----------------------------------- | ------------------------ |
| `read`         | `readTeamAction`                    | `get_team`               |
| `createStaff`  | `createStaffAction`                 | `create_staff_member`    |
| `updateStaff`  | `updateStaffAction`                 | `update_staff_member`    |
| `sendInvite`   | `sendInviteAction`                  | `send_team_invitation`   |
| `revokeAccess` | `revokeAccessAction`                | `revoke_team_access`     |
| (nouveau)      | `acceptTeamInviteAction({ token })` | `accept_team_invitation` |

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

| Code                        | Quand                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| `not_found`                 | profil introuvable ou d'un autre établissement                         |
| `idempotency_conflict`      | même `operationId`, commande différente                                |
| `role_unavailable`          | invitation avec `role: "practitioner"` (voir « Écarts »)               |
| `access_exists`             | le profil a déjà un compte, ou l'adresse est déjà membre               |
| `team_limit_reached`        | 100 profils                                                            |
| `validation_error`          | nom vide ou > 80, service inconnu ou d'un autre établissement, e-mail  |
| `invitation_invalid`        | acceptation : jeton inconnu, remplacé, révoqué, expiré ou déjà utilisé |
| `invitation_email_mismatch` | acceptation : compte connecté avec une autre adresse, ou non confirmée |
| `already_member`            | acceptation : ce compte appartient déjà à un établissement             |

## Écarts avec la proposition

1. **`practitioner` n'est pas encore attribuable** (`role_unavailable`).
   Toutes les règles RLS écrites jusqu'ici ouvrent l'établissement entier à
   n'importe quel membre. Un compte « praticienne » verrait donc tout ce que
   voit une administratrice (fichier clientes, CRM, réglages). Il faut un lot
   « capacités » qui restreint ces règles avant d'ouvrir ce rôle. D'ici là,
   l'écran doit proposer `admin` seulement, ou griser `practitioner`.
2. **E-mail d'invitation.** L'invitation est enregistrée et le jeton est
   généré côté serveur, mais l'e-mail ne part pas encore : aucun transport
   n'est validé (`EMAIL_TRANSPORT` vide en staging). Il sera branché avec
   l'adaptateur SMTP de la Mission 1. Validité : 7 jours. Le lien prévu est
   `/equipe/invitation?token=team_…`. La page appelle
   `acceptTeamInviteAction` une fois la personne connectée avec l'adresse
   invitée (page à faire côté UI).
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
