# Export du fichier clientes — contrat (points 146 et 182)

Serveur de l'écran proposé par l'UI dans la PR #74 (`docs/CRM_EXPORT_PROPOSAL.md`, R3-03). Les formes `ExportJobDto` et `CrmExportActions` sont reprises telles quelles.

## Une différence avec la proposition : aucun fichier stocké

Un export est une **autorisation courte (24 h)**, avec sa portée et son nombre de lignes. Le CSV est construit **à chaque téléchargement**, depuis la session de la propriétaire et sous RLS. Aucune donnée de cliente n'attend dans un stockage. Un export retiré ou expiré ne donne plus rien.

Conséquences pour l'écran :

- `request` répond `ready` tout de suite. `requested` (« en préparation ») n'apparaît pas aujourd'hui. Le statut et le refus `export_in_progress` restent dans le contrat, pour le jour où un gros fichier devrait être préparé en différé.
- Le fichier reflète le fichier clientes **au moment du téléchargement**. `rowCount` est le nombre de lignes au moment de la demande.
- `failed` n'est pas produit (rien n'est préparé en différé).

## Actions (`src/features/crm/export/actions.ts`)

| `CrmExportActions` | Server Action                                  | Effet                                                                                                           |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list`             | `listCrmExportsAction()`                       | Les 20 derniers exports, récent d'abord ; `expired` est calculé (prêt et `expiresAt` passé)                     |
| `request`          | `requestCrmExportAction({ scope, requestId })` | Prêt pour 24 h. Même `requestId` : même export ; autre portée sous le même `requestId` : `idempotency_conflict` |
| `download`         | `downloadCrmExportAction(jobId)`               | `{ url: "/api/crm-export/<jobId>" }` si l'export est encore à elle et prêt ; sinon `export_expired`             |
| `revoke`           | `revokeCrmExportAction(jobId)`                 | `revoked`, `expiresAt` à null, tout de suite. Idempotent. Inconnu : `not_found`                                 |

Refus : `permission_denied` (pas propriétaire : une admin ou une praticienne est refusée), `unauthenticated`, `export_expired`, `export_in_progress`, `idempotency_conflict`, `not_found`.

## Téléchargement : `GET /api/crm-export/:jobId`

- Même origine, session par cookie : le lien ne donne rien à une autre session (401 sans session, 403 pour une admin, 404 pour une autre activité).
- La base revérifie le rôle et l'export à chaque ouverture (`crm_export_rows`), puis compte et date le téléchargement (`download_count`, `last_downloaded_at`), jamais son contenu.
- Réponse : `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="clientes-<slug>-<date>.csv"` (ou `clientes-et-visites-…`), `Cache-Control: no-store`. Erreur : JSON `{ error }` avec le statut du code (410 pour `export_expired`).

## Fichier

- CSV UTF-8 avec BOM, séparateur `;` et fins de ligne CRLF, pour un tableur réglé en français.
- Une cellule qu'un tableur pourrait exécuter (`=`, `@`, tabulation, retour chariot, ou `+`/`-` suivis d'autre chose qu'un nombre) est précédée d'une apostrophe. Un numéro comme « +33 6 12 34 56 78 » reste tel quel.
- Heures murales de l'activité (`YYYY-MM-DD HH:MM`), prix au format français (`65,50`), devise dans l'en-tête.
- **`contacts`** : Prénom, Nom, E-mail, Téléphone, Fiche créée le, Visites passées, Dernière visite, Prochain rendez-vous. Une ligne par fiche.
- **`contacts_and_visits`** : Prénom, Nom, E-mail, Téléphone, Rendez-vous, Prestation, Durée (min), Prix, Statut (À venir, Passé, Terminé, Annulé, Absente). Une ligne par rendez-vous ; une fiche sans rendez-vous garde sa ligne.
- Tri par nom (le prénom à défaut), puis prénom. Les fiches effacées (point 205) ne sont jamais exportées, ni leurs rendez-vous.
- Pas de note, de réponse de formulaire, d'image ni de consentement dans la V1.

## Base (`20261123010000_crm_export.sql`)

- Table `public.crm_export_jobs` : RLS réservée à la propriétaire (`has_business_role(…, ['owner'])`) en lecture, insertion et mise à jour ; aucune suppression.
- Fonctions `public.crm_export_*` en SECURITY INVOKER, comme tout le CRM (`crm-read-model.test.ts`).
- Empilée sur #129 (`erased_at`).
