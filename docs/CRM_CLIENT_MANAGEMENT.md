# Contrat — gestion des clientes et notes privées (CRM V1, étape 3)

Backend uniquement. Les écrans CRM de l'étape 2 (PR #17) ne changent pas : ils n'utilisent pas encore ces actions.

- Migration : `supabase/migrations/20261014090000_crm_client_management_notes.sql`.
- Actions serveur : `src/features/crm/actions/client-management.ts` et `src/features/crm/actions/client-notes.ts`.
- Types : `src/features/crm/types.ts` (sections « Customer management » et « Private notes »).

## Décisions d'architecture

- **Une seule entité cliente.** La cliente reste `public.clients`, avec les règles d'identité de l'étape 1 ([`CRM_CUSTOMER_CONTRACT.md`](CRM_CUSTOMER_CONTRACT.md)). Pas de seconde table, pas de second système d'identité ni d'autorisation.
- **Une seule normalisation de l'email.** C'est `private.canonical_email`, appliquée par le trigger de `clients` sur toute écriture. Les fonctions de cette étape l'appellent via `public.crm_canonical_email`, une enveloppe sans logique propre.
- **Mêmes règles de saisie que l'agenda.** Les champs de contact sont définis une fois (`src/features/crm/schemas/contact.ts`) et partagés par la création de rendez-vous de l'agenda et par le CRM. PostgreSQL applique les mêmes règles et reste l'autorité.
- **Mêmes motifs que les rendez-vous.**
  - Concurrence optimiste par `version`, incrémentée par `private.bump_version` à chaque mise à jour.
  - Idempotence par `creation_request_id`, avec une empreinte (`creation_request_fingerprint`) liée à la commande canonique.
- **RLS reste l'autorité.** Toutes les fonctions sont `SECURITY INVOKER` : la RLS de `clients`, `client_notes`, `appointments` et `email_events` s'applique à chaque lecture et à chaque écriture. Chaque fonction vérifie aussi l'appartenance au business (`crm_assert_member`, erreur `forbidden`) et filtre chaque requête par `p_business_id`. Le business vient toujours de la session (`runBusinessAction`), jamais de l'entrée.
- **Une table dédiée aux notes datées** (`public.client_notes`). Le champ libre `clients.internal_notes` n'est ni migré, ni modifié (voir « Notes héritées »).

## Interface serveur

| Action                   | Entrée                                                                | Résultat                                                        |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `getClientRecordAction`  | `{ clientId }`                                                        | `ClientRecordDto`                                               |
| `createClientAction`     | `{ firstName, lastName?, email?, phone?, requestId }`                 | `{ client: ClientRecordDto, created }`                          |
| `updateClientAction`     | `{ clientId, expectedVersion, firstName, lastName?, email?, phone? }` | `{ client: ClientRecordDto, changed, retained }`                |
| `listClientNotesAction`  | `{ clientId, limit? (20, ≤ 100), cursor? }`                           | `{ timezone, legacyNotes, notes: ClientNoteDto[], nextCursor }` |
| `createClientNoteAction` | `{ clientId, content, requestId }`                                    | `{ note: ClientNoteDto, created }`                              |
| `updateClientNoteAction` | `{ clientId, noteId, expectedVersion, content }`                      | `{ note: ClientNoteDto, changed }`                              |
| `deleteClientNoteAction` | `{ clientId, noteId, expectedVersion }`                               | `{ noteId, deleted }`                                           |

Chaque action renvoie un `ActionResult`. Nouveaux codes d'erreur :

| Code                    | Statut | Quand                                                                                                                 |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `client_email_conflict` | 409    | L'email est celui d'une autre cliente du business. `error.conflict = { clientId, displayName }`, `fieldErrors.email`. |
| `stale_client`          | 409    | La fiche a changé depuis `expectedVersion`.                                                                           |
| `note_not_found`        | 404    | Aucune note de cet identifiant pour cette cliente de ce business.                                                     |
| `stale_note`            | 409    | La note a changé depuis `expectedVersion`.                                                                            |

Codes existants réutilisés :

- `validation_error`, avec le champ dans `fieldErrors` ;
- `client_not_found` ;
- `idempotency_conflict`, sur `requestId` ;
- `unauthenticated`, `no_business`, `forbidden`.

## Clientes

### Saisie

Les règles sont les mêmes qu'à la réservation et dans l'agenda :

- prénom obligatoire, 1 à 120 caractères ;
- nom de famille optionnel, 120 caractères au plus ;
- email optionnel, canonique, 254 caractères au plus ;
- téléphone optionnel : chiffres, espaces, `().-` et un `+` initial, 6 à 30 caractères.

Le texte est normalisé en Unicode NFC, puis rogné. Un champ optionnel vide vaut `null`.

### Identité et conflits

- **L'email canonique est la seule identité dans un business.** Le même email dans un autre business est une autre cliente.
- **Un nom ou un téléphone n'est jamais une identité.** Deux homonymes, ou deux fiches avec le même téléphone, restent deux fiches. Une fiche sans email n'est jamais rapprochée d'une autre.
- **Jamais de fusion, jamais de complément.** À la différence de la réservation (`private.resolve_client`, qui réutilise la fiche existante et complète ses champs manquants), la gestion manuelle ne touche jamais une autre fiche. Si l'email appartient déjà à une autre cliente, l'action répond `client_email_conflict` et n'écrit rien. La réponse nomme cette cliente : l'UI peut proposer de l'ouvrir.

### Création idempotente

`requestId` est généré une fois par formulaire.

- **Même `requestId`, même commande** (champs normalisés) : la cliente déjà créée est renvoyée, avec `created: false`. C'est le cas d'un nouvel essai ou d'un double envoi.
- **Même `requestId`, autre commande** : `idempotency_conflict`.
- **Créations concurrentes** du même `requestId` ou du même email : elles sont arbitrées par les contraintes uniques (`INSERT … ON CONFLICT DO NOTHING`). Une seule fiche est créée. Les autres appels attendent sa validation, puis répondent à partir d'elle (`created: false` ou `client_email_conflict`).

### Édition

`updateClientAction` remplace le prénom, le nom, l'email et le téléphone. Un champ optionnel absent est effacé.

- **Version périmée.** Une édition basée sur une `version` dépassée échoue avec `stale_client`. Toute écriture de la fiche incrémente la version, y compris une réservation qui complète un téléphone.
- **Pas de mise à jour perdue.** La ligne est verrouillée (`FOR UPDATE`) avant la comparaison de version.
- **Nouvel essai.** Si la fiche a déjà exactement ces valeurs, la réponse est `changed: false`, sans écriture, quelle que soit la version.
- **Conflit d'email.** L'email d'une autre cliente donne `client_email_conflict` ; la fiche n'est pas modifiée.

### L'historique garde son contact

Une édition modifie la fiche, et seulement elle :

- les instantanés de contact des rendez-vous (`client_*_snapshot`) restent ceux de la réservation : leur trigger refuse toute réécriture ;
- un email déjà en file (`email_events.recipient_email`) garde son destinataire. Une confirmation ou un rappel n'est jamais réacheminé en silence ;
- la timeline continue d'afficher le contact de chaque rendez-vous à l'époque.

Ce qui garde l'ancienne adresse est indiqué dans `retained` :

- `upcomingAppointmentsWithOtherEmail` : les rendez-vous confirmés à venir réservés avec un autre email ;
- `queuedEmailsToOtherAddress` : les emails `pending` ou `processing` adressés à un autre email.

L'UI peut ainsi le dire à la professionnelle.

> Règle pour un futur producteur de rappels : il doit utiliser l'instantané du rendez-vous (`client_email_snapshot`), pas la fiche actuelle. Aucun producteur de rappels n'existe aujourd'hui.

### Google Calendar

Rien ne change. Le trigger existant (`clients_record_calendar_mirrors`) rend les miroirs dus quand le prénom (le titre de l'événement) change, et seulement dans ce cas. Le job périodique les applique.

## Notes privées

### Modèle : `public.client_notes`

| Colonne                                               | Rôle                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `business_id`, `client_id`                            | Clé étrangère composite vers `clients (id, business_id)` : une note ne peut appartenir qu'à une cliente de son business. Elle est supprimée avec la cliente. |
| `content`                                             | NFC, rogné (mêmes caractères que `String.prototype.trim`), 1 à 5 000 caractères, sauts de ligne internes conservés.                                          |
| `created_at`                                          | Date de la note, fixée par la base, jamais par l'appelant. Elle ne change pas à l'édition.                                                                   |
| `updated_at`, `updated_by`, `version`                 | Suivent uniquement les changements de contenu.                                                                                                               |
| `created_by`                                          | L'utilisatrice de la session (`auth.uid()`), imposée par la base. `null` si le compte est supprimé.                                                          |
| `creation_request_id`, `creation_request_fingerprint` | Idempotence, comme pour les clientes.                                                                                                                        |

Le trigger `client_notes_guard` garantit ces règles quel que soit le chemin d'écriture (fonctions, DML d'un membre, `service_role`). Une note ne peut changer ni de business, ni de cliente, ni de date, ni d'auteur, ni de clé de requête (`client_note_immutable`).

### Lecture et pagination

- **Ordre.** Du plus récent au plus ancien : `created_at desc`, puis `id desc`.
- **Pagination par clé.** Le curseur est opaque et porte la dernière note lue, sa date à la microseconde et son `id`. Il est validé strictement, comme ceux de l'étape 2, et lié à la cliente.
- **Données inchangées.** Les pages sont déterministes : pas de doublon, pas de saut, égalités de date comprises.
- **Note ajoutée pendant la pagination.** Elle est plus récente que toutes les pages : elle n'apparaît qu'en repartant de la première page.
- **Fuseau.** Les dates suivent le format `BusinessInstantDto` de la timeline : un instant UTC et son heure murale dans le fuseau du business, lue par `public.business_time`.

### Écriture

- **Création** : idempotente par `requestId`. Un nouvel essai donne `created: false` ; une clé réutilisée pour une autre cliente ou un autre texte donne `idempotency_conflict`.
- **Édition** : elle porte la `version` lue (`stale_note` sinon), avec verrou de ligne. Le même contenu donne `changed: false`, sans écriture.
- **Suppression** : elle porte la `version` lue (`stale_note` si la note a changé entre-temps). Supprimer une note absente répond `deleted: false` : supprimer deux fois revient au même. La réponse ne dit pas si la note a existé.
- **Désignation complète.** Une note est toujours désignée par sa cliente et par son identifiant. Une note visée via une autre cliente est introuvable et reste intacte.

### Confidentialité

- **RLS.** Lecture, création, modification et suppression sont réservées aux membres du business (`is_business_member`).
- **`anon`.** Aucun privilège sur la table, ni sur aucune de ces fonctions.
- **Réservation publique.** Aucune fonction publique ne lit la table. Un test vérifie que seules les quatre fonctions de notes du CRM la mentionnent, et qu'aucune n'est exécutable par `anon`.
- **Données personnelles.** Aucun contenu de note, email ou téléphone n'est journalisé.

### Notes héritées (`clients.internal_notes`)

Ce champ libre (dont le texte des fiches fusionnées par l'étape 1) est **conservé tel quel**. Il n'est ni migré, ni modifié, ni effacé par cette étape. Il est renvoyé en lecture seule dans `legacyNotes` (`null` s'il est vide).

Pourquoi aucune migration automatique :

- ce texte n'a pas de date fiable : `updated_at` date la fiche, pas la note ;
- il peut réunir plusieurs notes concaténées ;
- le transformer en une note datée inventerait une date et un auteur.

Stratégie proposée pour l'étape 4 :

1. l'UI affiche `legacyNotes` à part (« Notes précédentes »), en lecture seule ;
2. une action explicite, cliente par cliente, crée une note datée du jour avec ce texte et vide le champ, dans une seule transaction ;
3. un recensement des fiches concernées précède toute décision de migration globale.

## Timeline : décision de compatibilité

Les notes **n'apparaissent pas encore** dans `listClientTimelineAction`.

L'UI de la PR #17 ignore un `kind` inconnu, mais elle grouperait l'événement par jour sans l'afficher. Les jours apparaîtraient vides, et une page entière de notes paraîtrait vide. Le parseur serveur (`src/features/crm/data/timeline.ts`) rejette aussi un `kind` inconnu. Exposer `note` maintenant dégraderait donc l'écran publié.

Le modèle est prêt pour l'intégration à l'étape 4 (PR #19), livrée avec l'UI :

- **Événement.** `event_id = 'note:' || id`, `occurred_at = created_at`. La date est immuable, donc la position dans la timeline ne bouge jamais.
- **Index.** `client_notes_client_idx (business_id, client_id, created_at desc, id desc)` sert la branche de l'`union all`, au même ordre que les autres sources.
- **Changements à faire.**
  - Ajouter une branche à `crm_client_timeline`.
  - Ajouter `note` à `EVENT_ID` dans `cursor.ts`.
  - Ajouter un schéma et un adaptateur à `timeline.ts`.
  - Ajouter `NoteTimelineEvent` (`content`, `edited`, `createdBy`) à `ClientTimelineEvent`.
  - Ajouter son rendu dans `timeline.tsx`, dans la même PR.

## Travail restant (étape 4, PR #19)

- **Écrans.** Créer et modifier une cliente, avec conflit d'email (« Ouvrir la fiche existante »), version périmée (« Recharger ») et message `retained`.
- **Notes dans la fiche.** Liste, saisie, édition, suppression, plus les notes héritées en lecture seule.
- **Intégration des notes à la timeline**, et rendu dans l'UI (voir ci-dessus).
- **Conversion explicite des notes héritées**, si elle est validée.
- **Mise à jour de Google plus rapide (optionnel).** Après un changement de prénom, déclencher le traitement des miroirs comme le font les écritures de l'agenda (`kickCalendarOutbound`). Aujourd'hui, le job périodique s'en charge.
