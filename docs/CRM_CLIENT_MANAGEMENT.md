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
  - Idempotence par `creation_request_id`, avec une empreinte liée à la commande canonique. Pour les notes, la trace d'une requête traitée survit à la note (voir « Requêtes de création traitées »).
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
| `note_deleted`          | 410    | Rejeu d'une création déjà traitée dont la note a été supprimée depuis : rien n'est recréé (`fieldErrors.requestId`).  |

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

| Colonne                               | Rôle                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business_id`, `client_id`            | Clé étrangère composite vers `clients (id, business_id)` : une note ne peut appartenir qu'à une cliente de son business. Elle est supprimée avec la cliente.    |
| `content`                             | Forme canonique, par la base, quel que soit le chemin (voir « Contenu canonique »), 1 à 5 000 caractères une fois canonique, sauts de ligne internes conservés. |
| `created_at`                          | Date de la note, fixée par la base, jamais par l'appelant. Elle ne change pas à l'édition.                                                                      |
| `updated_at`, `updated_by`, `version` | Suivent uniquement les changements de contenu.                                                                                                                  |
| `created_by`                          | L'utilisatrice de la session (`auth.uid()`), imposée par la base. `null` seulement si ce profil est réellement supprimé.                                        |
| `creation_request_id`                 | La requête de création qui l'a écrite (voir « Requêtes de création traitées »).                                                                                 |

### Contenu canonique

La base fixe la forme du contenu, quel que soit le chemin d'écriture : action serveur, fonction SQL, ou insertion et édition directes d'un membre.

- **Une seule implémentation.** C'est `public.crm_canonical_note_content` : Unicode NFC, puis retrait des espaces périphériques. Le trigger `client_notes_guard` l'appelle avant tout, à l'insertion comme à l'édition, et les fonctions de notes l'appellent aussi.
- **Ordre d'application :**
  1. canonicaliser ;
  2. valider (1 à 5 000 caractères une fois canonique, `invalid_input` sur `content` sinon) ;
  3. enregistrer ;
  4. calculer l'empreinte de la requête sur le texte enregistré (trigger `AFTER INSERT`).
- **Mêmes caractères que le navigateur.** Les espaces retirés sont exactement ceux de `String.prototype.trim`, la règle de l'action serveur. C'est vérifié sur tout le plan Unicode de base, NFC compris. Les espaces internes, les sauts de ligne et les caractères que `trim` garde (U+200B, U+0085…) sont conservés.
- **Conséquences.**
  - Une même requête, envoyée en NFD par un chemin puis en NFC ou avec d'autres espaces par un autre, est une seule commande : une seule note et la même empreinte.
  - Une édition qui ne change que la forme Unicode ou les espaces périphériques n'est pas un changement : la version ne bouge pas.

### Attribution : contrôlée par la base

- **Privilèges par colonne.** Un membre peut insérer `business_id`, `client_id`, `content` et `creation_request_id`, puis modifier `content`, et rien d'autre. Il n'existe aucun droit `UPDATE` sur toute la table : il passerait outre les droits par colonne. Toute tentative directe sur l'auteur, la date ou la version est refusée (`42501`).
- **Trigger `client_notes_guard`**, quel que soit le rôle (fonctions, DML d'un membre, `service_role`). Une note ne peut changer ni de business, ni de cliente, ni de date, ni d'auteur, ni de clé de requête (`client_note_immutable`). Une référence d'auteur (`created_by`, `updated_by`) ne devient `null` que si ce profil n'existe plus : c'est le `ON DELETE SET NULL` de sa clé étrangère, à la suppression réelle du compte. Le profil est cherché avec les droits du propriétaire, jamais déduit de ce que la RLS laisse voir à l'appelant.
- **Version.** Elle ne bouge qu'avec le contenu. La suppression d'un auteur ne change ni la version, ni `updated_at`.

### Lecture et pagination

- **Ordre.** Du plus récent au plus ancien : `created_at desc`, puis `id desc`.
- **Pagination par clé.** Le curseur est opaque et porte la dernière note lue, sa date à la microseconde et son `id`. Il est validé strictement, comme ceux de l'étape 2, et lié à la cliente.
- **Données inchangées.** Les pages sont déterministes : pas de doublon, pas de saut, égalités de date comprises.
- **Note ajoutée pendant la pagination.** Elle est plus récente que toutes les pages : elle n'apparaît qu'en repartant de la première page.
- **Fuseau.** Les dates suivent le format `BusinessInstantDto` de la timeline : un instant UTC et son heure murale dans le fuseau du business, lue par `public.business_time`.

### Écriture

- **Création** : idempotente par `requestId`, une fois pour toutes (voir ci-dessous).
- **Édition** : elle porte la `version` lue (`stale_note` sinon), avec verrou de ligne. Le même contenu donne `changed: false`, sans écriture.
- **Suppression** : elle porte la `version` lue (`stale_note` si la note a changé entre-temps). Supprimer une note absente répond `deleted: false` : supprimer deux fois revient au même. La réponse ne dit pas si la note a existé.
- **Désignation complète.** Une note est toujours désignée par sa cliente et par son identifiant. Une note visée via une autre cliente est introuvable et reste intacte.

### Requêtes de création traitées : `private.client_note_requests`

Une requête de création traitée le reste, même après la suppression de sa note. Le registre garde une ligne par requête :

- `request_id`, unique dans le business ;
- `client_id` ;
- une empreinte SHA-256 de la commande canonique (cliente et contenu canonique) ;
- `note_id`, la note écrite ;
- `created_at`.

Il ne garde **aucun contenu**.

- **Écriture atomique.** Le trigger `client_notes_record_request` enregistre la requête dans la transaction de l'insertion, quel que soit le chemin.
- **Pierre tombale atomique.** À la suppression de la note, par n'importe quel chemin (action, DML d'un membre, cascade), sa clé étrangère met `note_id` à `null` dans la même transaction.
- **Concurrence.** La clé primaire fait attendre un second insert de la même requête jusqu'à la validation du premier. La ligne existante est ensuite verrouillée : une suppression en cours se termine avant la lecture.

| Rejeu de `requestId`                  | Réponse                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Même commande, note toujours présente | La note actuelle (contenu modifié compris), `created: false`. Aucun doublon. |
| Même commande, note supprimée depuis  | `note_deleted` (410). Rien n'est écrit, aucun ancien contenu n'est restauré. |
| Autre cliente ou autre contenu        | `idempotency_conflict`, que la note existe encore ou non.                    |
| Nouveau `requestId`                   | Une nouvelle note, même avec le même texte.                                  |

Confidentialité et durée de vie :

- **Accès.** Le registre est dans le schéma `private` : aucun rôle d'API ne le lit ni ne l'écrit, et aucune fonction ne renvoie l'empreinte.
- **Empreinte.** Elle est traitée comme une donnée sensible : elle permettrait de confirmer une hypothèse sur le texte d'une note supprimée.
- **Suppression.** Les lignes partent avec la cliente, donc avec le business.
- **Oracle résiduel.** Un rejeu permet de confirmer un texte supposé (`note_deleted` ou `idempotency_conflict`). Mais il faut connaître le `requestId`, que seul le formulaire d'origine connaît : aucune réponse ne l'expose.

### Confidentialité

- **RLS.** Lecture, création, modification et suppression sont réservées aux membres du business (`is_business_member`).
- **`anon`.** Aucun privilège sur la table, ni sur aucune de ces fonctions.
- **Réservation publique.** Aucune fonction publique ne lit la table. Un test vérifie que seules les quatre fonctions de notes du CRM et la timeline (`crm_client_timeline`) la mentionnent, et qu'aucune n'est exécutable par `anon`.
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

## Timeline : les notes y entrent avec leur rendu

Depuis la migration `20261015090000_crm_timeline_notes.sql` (PR #19, phase 1), les notes sont des événements `kind: "note"` de `listClientTimelineAction`. Voir [`CRM_RELATIONSHIP_READ_MODEL.md`](CRM_RELATIONSHIP_READ_MODEL.md), « Notes privées ».

- **Événement.** `event_id = 'note:' || id`, `occurred_at = created_at`. La date est immuable, donc la position dans la timeline ne bouge jamais.
- **Contenu.** `note` est le `ClientNoteDto` actuel, identique à celui de `listClientNotesAction`.
- **Index.** `client_notes_client_idx (business_id, client_id, created_at desc, id desc)` sert la branche de l'`union all`, au même ordre que les autres sources.

**Compatibilité.** L'UI de la PR #17 ignore un `kind` inconnu (`default: return null`), mais elle grouperait l'événement par jour sans l'afficher. Les jours apparaîtraient vides, et une page entière de notes paraîtrait vide. Le backend est donc livré sur la branche de la PR #19 et **ne doit pas être fusionné sans le rendu** de la phase 2. Il n'y a ni drapeau de fonctionnalité ni chemin transitoire. Le contrat de passation est dans [`CRM_NOTES_TIMELINE_HANDOFF.md`](CRM_NOTES_TIMELINE_HANDOFF.md).

## Travail restant (étape 4, PR #19, phase 2 : UI)

- **Écrans.** Créer et modifier une cliente, avec conflit d'email (« Ouvrir la fiche existante »), version périmée (« Recharger ») et message `retained`.
- **Notes dans la fiche.** Liste, saisie, édition, suppression, plus les notes héritées en lecture seule.
- **Rendu des notes dans la timeline** ([`CRM_NOTES_TIMELINE_HANDOFF.md`](CRM_NOTES_TIMELINE_HANDOFF.md)). Le backend est livré en phase 1.
- **Conversion explicite des notes héritées**, si elle est validée.
- **Mise à jour de Google plus rapide (optionnel).** Après un changement de prénom, déclencher le traitement des miroirs comme le font les écritures de l'agenda (`kickCalendarOutbound`). Aujourd'hui, le job périodique s'en charge.
