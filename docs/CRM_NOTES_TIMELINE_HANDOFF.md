# Passation UI — notes privées dans la timeline (PR #19)

Ce document est le contrat que la phase 2 (UI) de la PR #19 doit respecter. La phase 1 (backend) est livrée sur la branche de la PR. Elle n'ajoute aucun écran.

- **Branche partagée :** `feat/crm-client-management-ui`, créée depuis `main` à `37ae3d8818aa23b98282a37f2dc35b98532fd722` (PR #18 fusionnée). Le SHA du commit de la phase 1 figure dans la description de la PR #19.
- **Migration :** `supabase/migrations/20261015090000_crm_timeline_notes.sql`. Elle remplace seulement `public.crm_client_timeline` (même signature, mêmes droits), avec une nouvelle branche pour `public.client_notes`.
- **Code :** `src/features/crm/types.ts` (`NoteTimelineEvent`), `src/features/crm/data/timeline.ts` (lecture), `src/features/crm/data/cursor.ts` (`note:` accepté dans le curseur).
- **Contrats amont :** [`CRM_RELATIONSHIP_READ_MODEL.md`](CRM_RELATIONSHIP_READ_MODEL.md) (timeline, pagination, instants) et [`CRM_CLIENT_MANAGEMENT.md`](CRM_CLIENT_MANAGEMENT.md) (notes, écritures, confidentialité).

**Fusion :** la PR #19 ne doit **pas** être fusionnée avant le rendu des notes. L'UI publiée (PR #17) ignore `kind: "note"` (`default: return null` dans `TimelineEntry`), mais `groupTimeline` grouperait quand même la note par jour : le jour s'afficherait vide. Il n'y a ni drapeau de fonctionnalité ni chemin transitoire.

## 1. Événement

`listClientTimelineAction({ clientId, limit?, cursor? })` renvoie, en plus des rendez-vous, de la fidélité et des emails, un événement par note privée existante de la cliente.

```ts
// src/features/crm/types.ts
export type NoteTimelineEvent = {
  /** `note:<uuid de la note>` : stable, sans collision avec les autres sources. */
  id: string;
  kind: "note"; // discriminant exact
  /** = note.createdAt : jamais modifié par une édition. */
  occurredAt: BusinessInstantDto;
  note: ClientNoteDto;
};

export type ClientTimelineEvent =
  | AppointmentTimelineEvent
  | LoyaltyTimelineEvent
  | EmailTimelineEvent
  | NoteTimelineEvent;

export type ClientNoteDto = {
  id: string; // uuid de la note (sans préfixe)
  clientId: string;
  content: string; // contenu ACTUEL : NFC, sans espaces aux extrémités, 1 à 5 000 caractères
  version: number; // à renvoyer comme expectedVersion pour modifier ou supprimer
  edited: boolean; // version > 1
  createdAt: BusinessInstantDto; // écriture de la note : sa date
  updatedAt: BusinessInstantDto; // dernier changement du contenu (= createdAt si jamais modifiée)
  createdBy: string | null; // id (profiles.id) de l'autrice ; null si ce compte a été supprimé
  updatedBy: string | null; // id de la dernière éditrice ; null si jamais modifiée (ou compte supprimé)
};

export type BusinessInstantDto = {
  at: string; // instant UTC ISO
  local: string; // heure murale YYYY-MM-DDTHH:MM dans le fuseau du business
  occurrence: "first" | "second" | null; // heure répétée d'automne
};
```

Invariants garantis par le backend, et testés :

- `event.id` vaut `"note:" + event.note.id`.
- `event.occurredAt` a les mêmes valeurs que `event.note.createdAt`.
- `event.note` est **exactement** le `ClientNoteDto` que `listClientNotesAction` renvoie pour la même note au même moment. Les mêmes composants et les mêmes actions servent dans les deux vues.
- Le contenu est celui **de la lecture** : il n'y a pas d'historique de versions, et une édition ne crée aucun événement.
- Une note supprimée n'est plus renvoyée. Il n'existe aucun événement « note supprimée » ni « note modifiée ».
- `edited`, `updatedAt` et `updatedBy` sont les seules traces d'une édition. L'UI ne doit rien inventer d'autre (pas de « modifiée par X » si `updatedBy` est `null`).

### Schéma zod côté serveur

Le serveur valide chaque ligne de PostgreSQL avant de construire le DTO (`src/features/crm/data/timeline.ts`, schéma partagé `noteSchema` de `src/features/crm/data/client-notes.ts`) :

```ts
export const noteSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  version: z.number().int().min(1),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.string(), // instant PostgreSQL, converti en BusinessInstantDto
  updatedAt: z.string(),
});
// Branche de l'union des lignes de la timeline :
z.object({ kind: z.literal("note"), data: noteSchema });
```

Une ligne inattendue donne `internal`, jamais un événement partiel. L'UI reçoit le DTO TypeScript déjà validé et n'a pas à le revalider.

## 2. Dates et fuseau

- **Regroupement :** le regroupement existant (`occurredAt.local.slice(0, 10)`, `src/features/crm/client/timeline.ts`) s'applique tel quel. Une note se range au jour local de son écriture.
- **Format :** utiliser les formateurs existants de `src/features/crm/client/format.ts` (`timeLabel`, `dayAndTime`, `longDate`…). Ils lisent `local` et `occurrence` (heure répétée d'automne). Ne **jamais** formater `at` avec le fuseau du navigateur.
- **Fuseau d'une réponse :** les heures d'une réponse sont celles de **son** `timezone`. Une note lue dans la timeline s'affiche avec le `timezone` de la page de timeline, et une note lue dans `listClientNotesAction` avec celui de cette réponse.
- **Cas testés :**
  - Europe/Paris, heure répétée du 25 octobre 2026 : 00:30Z et 01:30Z donnent `02:30` `first` et `second`.
  - Minuit : 2026-03-28T23:00Z donne `2026-03-29T00:00`.
  - America/Vancouver, 1er novembre 2026 : `01:30` `first` et `second`.

## 3. Auteur

`createdBy` et `updatedBy` sont des **identifiants de compte** (`profiles.id`), pas des noms. Ce contrat ne résout aucun nom.

- **Ne jamais afficher un UUID.**
- En V1, un business n'a qu'une professionnelle : l'UI peut omettre l'auteur, ou n'afficher « modifiée » que d'après `edited` et `updatedAt`.
- Afficher un nom d'autrice demanderait une lecture backend supplémentaire. Elle sort du périmètre de la phase 2 et doit être demandée avant d'être construite.
- `null` signifie « compte supprimé » pour `createdBy`, et « jamais modifiée ou compte supprimé » pour `updatedBy`. Afficher l'absence, sans rien inventer.

## 4. Pagination

Un seul curseur, celui de la timeline. Il n'existe **pas** de curseur de notes séparé dans la timeline.

- **Ordre :** `occurredAt` décroissant, puis `id` décroissant octet par octet. Les notes s'intercalent parmi les autres événements à leur date.
  - À instant identique, l'ordre est total et stable. Par l'octet du préfixe, `note:` passe avant `loyalty:`, puis `email:`, puis `appointment:`.
  - L'UI ne doit pas trier elle-même : elle garde l'ordre du serveur.
- **Données inchangées :** ni doublon, ni saut, mêmes pages à chaque relecture, à toute taille de page de 1 à 100. C'est testé de 1 à 5 sur un historique mixte, avec des égalités d'instant.
- **Édition pendant la lecture :** la note **ne bouge pas**. Les pages suivantes ne sont pas décalées, mais une page déjà affichée garde l'ancien contenu jusqu'à ce que l'UI le remplace.
- **Suppression pendant la lecture :** la note disparaît des lectures suivantes. Un curseur arrêté sur cette note reste valide : la page suivante commence juste après sa position, sans saut ni doublon. C'est testé.
- **Note créée pendant la lecture :** elle est plus récente que toutes les pages et n'apparaît qu'en repartant de la première page.
- **Curseur invalide :** `validation_error` avec `fieldErrors.cursor`. Repartir de la première page.

## 5. Écritures : Server Actions existantes (PR #18)

`src/features/crm/actions/client-notes.ts`. Chaque action renvoie un `ActionResult<T>` et ne lève jamais d'exception vers l'UI. Le business vient de la session, et aucun identifiant de business n'est accepté.

| Action                   | Entrée                                           | `data`                                                              |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------- |
| `listClientNotesAction`  | `{ clientId, limit? (1–100, 20), cursor? }`      | `ClientNotesPageDto` `{ timezone, legacyNotes, notes, nextCursor }` |
| `createClientNoteAction` | `{ clientId, content, requestId }`               | `{ note: ClientNoteDto, created: boolean }`                         |
| `updateClientNoteAction` | `{ clientId, noteId, expectedVersion, content }` | `{ note: ClientNoteDto, changed: boolean }`                         |
| `deleteClientNoteAction` | `{ clientId, noteId, expectedVersion }`          | `{ noteId, deleted: boolean }`                                      |

- **`noteId`** est `event.note.id`, **jamais** `event.id` (qui porte le préfixe `note:`). `expectedVersion` est `event.note.version`.
- **`requestId`** : un UUID généré **une fois par formulaire** (`crypto.randomUUID()` à l'ouverture), réutilisé à chaque nouvel essai du même envoi. Un nouvel envoi après succès utilise un nouveau `requestId`.
- **`content`** : le serveur le normalise (NFC, puis retrait des espaces aux extrémités ; les retours à la ligne intérieurs sont gardés) et vérifie 1 à 5 000 caractères (`MAX_NOTE_LENGTH`). Les messages de validation sont dans `fieldErrors.content`.
- **`changed: false`** : le contenu était déjà identique. Rien n'est écrit et la version ne bouge pas.
- **`deleted: false`** : la note n'existait plus. Rien n'est fait. Traiter comme un succès et la retirer de l'affichage.
- **`created: false`** : rejeu du même `requestId`. La note renvoyée est l'actuelle.

Après une écriture réussie, **recharger la timeline depuis la première page** (sans curseur), comme le fait déjà la reprise de l'écran. C'est la seule façon de voir une nouvelle note, qui est plus récente que toutes les pages. Une mise à jour locale optimiste reste possible pour l'édition et la suppression (même `id`, même position), mais la relecture fait foi.

## 6. Erreurs à gérer

| Code                   | HTTP | Quand                                                               | Conduite UI                                                                   |
| ---------------------- | ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `validation_error`     | 400  | entrée invalide (`fieldErrors.content`, `…requestId`, `…cursor`)    | afficher sous le champ ; pour `cursor`, repartir de la première page          |
| `unauthenticated`      | 401  | pas de session                                                      | flux de reconnexion existant (`CrmError`)                                     |
| `no_business`          | 403  | compte sans activité                                                | flux existant                                                                 |
| `client_not_found`     | 404  | cliente inconnue ou d'une autre activité                            | écran « fiche introuvable » existant                                          |
| `note_not_found`       | 404  | édition d'une note supprimée entre-temps                            | retirer la note et recharger la timeline                                      |
| `stale_note`           | 409  | la note a changé depuis la lecture (édition ou suppression)         | « Recharger » : relire, puis laisser refaire l'action sur la version actuelle |
| `idempotency_conflict` | 409  | `requestId` déjà utilisé pour une autre cliente ou un autre contenu | régénérer un `requestId` (nouveau formulaire) ; ne pas renvoyer en boucle     |
| `note_deleted`         | 410  | rejeu d'un `requestId` dont la note a été supprimée depuis          | ne pas recréer ; informer, fermer le formulaire, recharger                    |
| `internal`             | 500  | inattendu                                                           | message générique, nouvel essai                                               |

`error.message` est un texte français affichable. Le code est le contrat. Aucune réponse n'expose de message PostgreSQL.

## 7. Exigences de rendu (phase 2)

- **Ajouter `case "note"`** à `TimelineEntry` (`src/features/crm/components/timeline.tsx`), et garder le repli `default` pour un futur `kind`. Une fois les notes rendues, aucun jour ne peut plus apparaître vide à cause d'elles.
- **Contenu en texte brut :** pas de HTML ni de Markdown interprétés. Garder les retours à la ligne (`whitespace-pre-wrap`) et couper les mots longs (`break-words`). Une note peut faire 5 000 caractères : prévoir un repli (« Afficher plus ») sans tronquer les données.
- **Indiquer `edited`** (« modifiée le … » avec `updatedAt.local`). Rien d'autre.
- **Mention « privée » :** la note n'est visible que des membres du business ; le signaler visuellement.
- **Notes héritées :** `legacyNotes` vient de `listClientNotesAction`, pas de la timeline. L'afficher à part, en lecture seule (« Notes précédentes »), jamais comme un événement daté.
- **État vide :** le texte actuel (« Ses rendez-vous passés apparaîtront ici. ») peut mentionner les notes, sans rien promettre d'autre.
- **Confidentialité :**
  - ne jamais journaliser le contenu d'une note (console, analytics, rapports d'erreur), ni le mettre dans une URL, un titre de page ou une notification ;
  - aucun composant public (réservation, emails clientes) ne doit lire ces types.

Tests attendus en phase 2 :

- rendu d'une note entre deux autres types d'événements, au bon jour ;
- note modifiée (badge) ;
- note longue, avec retours à la ligne ;
- suppression puis relecture (la note disparaît) ;
- `stale_note` et `note_deleted` ;
- aucun jour vide sur une page faite uniquement de notes ;
- aucune date formatée avec le fuseau du navigateur.

## 8. Garanties de confidentialité (backend)

- **Sécurité de la fonction :** `crm_client_timeline` est `SECURITY INVOKER`, `STABLE`, et exécutable par `authenticated` seulement (jamais `anon`). La RLS de `client_notes` (membres du business) reste l'autorité, en plus de `crm_assert_member` et du filtre par business et par cliente.
- **Isolation testée :** cliente voisine, autre business (par l'action et par appel direct au RPC), cliente d'un autre business, `anon`.
- **Aucune exposition publique :** aucune fonction publique, aucun DTO de réservation ni aucun email ne lit `client_notes`. Un test vérifie que seules les quatre fonctions de notes et `crm_client_timeline` la mentionnent.
- **Protections de la PR #18 inchangées :** trigger d'immuabilité, privilèges par colonne, registre privé des requêtes, aucune note ressuscitée.
