# Équipe — contrat proposé (M6-R01)

Statut : **proposé par l'UI, non implémenté**. L'écran existe
(`src/features/team/`) et ne tourne que dans `/apercu/equipe`, contre un
serveur en mémoire. Aucune page réelle ne montre d'équipe tant que ce contrat
n'est pas servi. Le backend (tables, RLS, RPC, e-mails) reste celui de Cloud ;
ce document dit seulement ce que l'écran attend.

## Principe

Deux choses toujours séparées :

- **Réservable** : ses clientes peuvent réserver cette personne, pour les
  prestations qui lui sont attribuées. Aucun compte ni e-mail requis.
- **Accès au logiciel** : un compte lié au profil, avec un rôle
  (`owner`, `admin`, `practitioner`), obtenu par invitation.

## Lecture

`read() → TeamDto`

```ts
TeamDto = {
  members: TeamMemberDto[];
  services: { id: string; name: string }[]; // son catalogue, pour l'attribution
};
TeamMemberDto = {
  id: string;
  revision: number;            // verrou optimiste
  displayName: string;
  bookable: boolean;
  serviceIds: string[];
  access: { role: TeamRole; email: string } | null;
  invite: {
    status: "pending" | "accepted" | "expired" | "revoked";
    email: string;
    role: TeamRole;
    expiresAt: string | null;
  } | null;                    // jamais de jeton ni de lien dans la lecture
  upcomingAppointments: number;
};
```

## Écritures

Toutes portent un `operationId` (UUID). **Rejouer le même `operationId`
renvoie la même réponse sans réappliquer** : l'écran le réutilise après une
réponse perdue. Toutes sauf la création portent `expectedRevision`.

| Action         | Entrée                                                           | Effet                                                                                       |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `createStaff`  | `displayName, bookable, serviceIds`                              | Profil sans compte                                                                          |
| `updateStaff`  | `staffId, expectedRevision, displayName, bookable, serviceIds`   | —                                                                                           |
| `sendInvite`   | `staffId, expectedRevision, email, role ∈ {admin, practitioner}` | Nouvelle invitation ; **la précédente devient inutilisable**                                |
| `revokeAccess` | `staffId, expectedRevision`                                      | Retire le compte (et annule l'invitation en attente) ; le profil et ses rendez-vous restent |

Réponse : `{ ok: true, data: TeamMemberDto } | { ok: false, error: { code } }`.

## Refus nommés

| Code                    | Quand                                                           | Ce que l'écran fait                                                               |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `version_conflict`      | `expectedRevision` périmée                                      | Garde la saisie, relit l'équipe ; le prochain envoi part sur la nouvelle révision |
| `last_owner`            | Retirer l'accès de la seule propriétaire                        | Le dit                                                                            |
| `upcoming_appointments` | Rendre non réservable une personne avec des rendez-vous à venir | Le dit (et prévient avant l'envoi)                                                |
| `permission_denied`     | Rôle insuffisant                                                | Le dit                                                                            |
| autre / réseau          | —                                                               | Message générique, réessai avec le même `operationId`                             |

## À trancher par Cloud

- Rôle `owner` : jamais attribuable par invitation (proposé). Transfert de
  propriété : hors périmètre de ce lot.
- Une personne retirée de la réservation : ses créneaux futurs disparaissent
  de la réservation publique ; ses rendez-vous existants ne sont jamais
  réassignés en silence.
- Liens agenda et CRM : l'écran suivra les capacités renvoyées par la session
  (pas de garde côté interface seule).
- Durée de validité et envoi de l'e-mail d'invitation : côté serveur.
