# Mini-sites : persistance et publication

Le laboratoire Experience Engine (`proto/experience-engine`, `docs/EXPERIENCE_ENGINE.md` § 3, § 4, § 6) devient un constructeur de mini-sites publiables. Ce document est le contrat entre le backend et Claude UI (studio, rendu public). Il confronte les propositions du laboratoire au SaaS actuel et dit ce qui est livré, PR par PR.

## 1. Ce que le site est, et ce qu'il n'est pas

- **Le site est la présentation** d'un établissement : univers, textes de vitrine, photos et leurs points focaux, tokens artistiques, scènes et leurs variantes, mode de réservation (page ou feuille), réservation rapide (barre ou pastille).
- **Il ne contient jamais :**
  - le catalogue (prestations, prix, durées, options), qui vient de `get_public_catalog` (`docs/CATALOG_CONTRACT.md`) ;
  - les disponibilités ni la réservation, qui passent par les routes publiques existantes (`docs/PUBLIC_BOOKING_CONTRACT.md`).

  Aucun second catalogue, aucun second moteur de réservation. Changer d'univers ou de composition ne touche jamais le catalogue.

- **Un seul site par établissement.**

## 2. Modèle (écart assumé avec le laboratoire)

Le laboratoire proposait une ligne `draft` parmi les versions. Le SaaS sépare plus nettement **le brouillon, modifiable**, et **l'historique, immuable** :

| Table                  | Rôle                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.sites`         | une ligne par établissement : `plan` (`core` \| `signature`), le brouillon (`draft_config`, `draft_schema_version`, `draft_revision`), `published_version_id`                                                                             |
| `public.site_versions` | une ligne par **publication** : `number` (1, 2, 3… par site), `schema_version`, `config` figée, auteur, date, `restored_from` (la version d'origine quand une restauration a été publiée). **Jamais modifiée ni supprimée** (déclencheur) |
| `public.site_assets`   | les photos de l'établissement (métadonnées) : seules celles-ci peuvent être référencées par une configuration                                                                                                                             |

- **Brouillon :** privé, modifiable par les membres de l'établissement seulement. `draft_revision` est le jeton de comparaison : une écriture fondée sur une révision dépassée est refusée (`stale_site_draft`).
- **Publication :** copie atomique du brouillon dans une nouvelle version, et bascule de `published_version_id` dans la même transaction. Le public ne voit jamais d'état intermédiaire.
- **Historique et restauration :** les versions publiées forment l'historique. Restaurer copie une version ancienne **dans le brouillon**. Rien n'est réécrit, et publier ensuite crée une nouvelle version, avec `restored_from`.
- **Lecture publique :** uniquement la version publiée, par le slug de l'établissement. Un brouillon n'est jamais lisible publiquement, et un établissement sans publication n'a pas de site (`site_not_published`).

## 3. Forfaits Core et Signature

- **Source de vérité :** `sites.plan`, côté serveur. Il n'existe pas encore de facturation dans le SaaS. Le forfait n'est donc **modifiable que par le service** (`set_site_plan`, rôle `service_role`), jamais par la professionnelle ni par le navigateur.
- **Rien n'est jamais détruit ni réécrit par un changement de forfait :**
  - le brouillon peut contenir des réglages Signature en sommeil, même en Core ;
  - une version publiée garde sa configuration complète.
- **Les droits sont une lentille appliquée au rendu** (`effective(config, plan, univers)` du laboratoire), côté serveur, sur la version publiée et avec le forfait **actuel** : repasser en Core cesse immédiatement de rendre les réglages Signature, et repasser en Signature les rend sans republier. La lecture publique renvoie la configuration publiée **et** le forfait actuel. Le rendu (Claude UI, composant serveur) applique la lentille, puis le filet de lisibilité `ensureReadable`.

## 4. Format de configuration (`schema_version` 1)

C'est la `SiteConfig` du laboratoire (`engine/config.ts`), avec ces règles serveur (Zod strict, `src/features/sites/config.ts`) :

- **Registre fermé :**
  - `universe` : `mila`, `alma`, `nail-lab` ;
  - `type` : `didone`, `soft-serif`, `condensed`, `neutral` ;
  - `grade` : `silver`, `warm`, `natural`, `chrome` ;
  - `motion` : `cut`, `settle`, `snap` ;
  - `shape` : `sharp`, `soft`, `round` ;
  - scènes et variantes :
    - `opening` : `didone-cut`, `bloom`, `kinetic` ;
    - `intro` : `statement`, `lines` ;
    - `work` : `lookbook`, `arches`, `filmstrip` ;
    - `portrait` : `editorial`, `arch` ;
    - `services` : `index`, `shelf`, `tiles` ;
  - `booking` : `page` ou `sheet` ; `quickBook` : `bar` ou `pill`.

  Une valeur inconnue est refusée. Ajouter une variante, c'est l'ajouter au registre, avec une PR.

- **Scènes :** une liste ordonnée sans doublon. `opening` et `services` sont toujours présentes et ne peuvent pas être masquées (`hidden`).
- **Textes :** texte brut uniquement, sans HTML ni caractère de contrôle, avec des longueurs bornées (nom 80, activité 80, lieu 80, introduction 600, titre d'œuvre 80, note 300, portrait : nom 80, rôle 80, texte 1 200).
- **Couleurs :** `#rrggbb`.
- **Photos :** jamais une URL. Une photo est `{ "asset": "<uuid>" }`, une photo de `site_assets` **de cet établissement** et prête (`ready`), vérifiée par la base à chaque enregistrement. Les points focaux sont indexés par l'identifiant de l'asset, `x` et `y` de 0 à 100.
- **Œuvres :** de 0 à 24.
- **Taille :** 256 Kio au plus pour le document.
- **Évolution :** `schema_version` est stocké avec chaque brouillon et chaque version. Une version 2 viendra avec des fonctions de migration pures (1 → 2) appliquées à la lecture, sans réécrire l'historique.

## 5. Lisibilité (« l'art est libre, la lisibilité ne l'est pas »)

- **Le studio** applique `ensureReadable` avant de publier, et montre les corrections (comportement du laboratoire).
- **Le serveur vérifie à la publication**, sans corriger en silence, les couples de texte de la palette, au contraste WCAG d'au moins 4,5:1 :
  - encre sur fond nuit ;
  - encre sur fond jour ;
  - texte sur accent ;
  - secondaire sur fond nuit.

  Sinon, refus `site_unreadable` (422), avec la liste des couples en défaut. Le bouton de réservation (`cta`) n'a pas besoin de contrôle : son texte est calculé (noir ou blanc), et toute couleur atteint au moins 4,58:1 avec l'un des deux.

- **Le brouillon** peut rester illisible : l'expérimentation est libre, seule la publication est bloquée.
- **Le rendu public** applique quand même `ensureReadable` : une configuration enregistrée autrement ne peut pas produire un site illisible. Les couples dérivés (secondaire sur fond jour, cartes) sont calculés par le moteur, et garantis par `ensureReadable`.

## 6. Interface (Server Actions, membres de l'établissement)

| Action                                                      | Réponse                                                                           | Erreurs propres                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `getSiteAction()`                                           | `SiteDto` (brouillon, révision, forfait, version publiée) ou `null` si aucun site | —                                                                |
| `saveSiteDraftAction({ expectedRevision, config })`         | `{ revision }`                                                                    | `stale_site_draft`, `validation_error`, `site_asset_unavailable` |
| `publishSiteAction({ expectedRevision })`                   | `{ versionId, number, publishedAt }`                                              | `stale_site_draft`, `site_unreadable`, `site_not_found`          |
| `listSiteVersionsAction()`                                  | `SiteVersionSummary[]` (plus récente d'abord)                                     | —                                                                |
| `getSiteVersionAction({ versionId })`                       | `SiteVersionDto` (sa configuration)                                               | `site_version_not_found`                                         |
| `restoreSiteVersionAction({ versionId, expectedRevision })` | `{ revision }` : le brouillon est maintenant cette version                        | `stale_site_draft`, `site_version_not_found`                     |

- **Premier enregistrement :** `expectedRevision: 0` crée le site, puis les révisions avancent de 1 à chaque écriture.
- **Nouvelle tentative :** une écriture identique à l'état courant, depuis une révision dépassée, renvoie l'état courant sans rien écrire.
- **Publier** sans modification depuis la dernière publication ne crée pas de nouvelle version : la réponse est la version publiée actuelle.

**Lecture publique** (sans session) : `getPublishedSite(slug)` pour le rendu serveur, ou `GET /api/public/businesses/[slug]/site`. Elle renvoie `{ versionId, number, publishedAt, plan, schemaVersion, config }` ; `site_not_published` (404) sans publication.

## 7. Garanties de concurrence

- **Écritures du brouillon :** comparaison sur `draft_revision`, sous verrou de ligne du site. Deux studios ouverts : l'un gagne, l'autre reçoit `stale_site_draft` et recharge.
- **Publication :** sous verrou de ligne du site. Elle prend le brouillon **à la révision attendue**, insère la version (numéro suivant, unique par site) et bascule `published_version_id` dans la même transaction. Deux publications simultanées sont sérialisées, sans numéro perdu ni dupliqué.
- **Lecture publique :** une seule requête, sur la version pointée. Une publication en cours n'est visible qu'une fois validée.

## 8. Photos (PR 2, contrat fixé ici)

- **Stockage :**
  - bucket Supabase Storage **privé** `site-photos` ;
  - chemin `<business_id>/<asset_id>` ;
  - politiques Storage : écriture limitée aux membres de cet établissement, dans son dossier.
- **Envoi :**
  1. `createSitePhotoUploadAction({ contentType, byteSize })` crée l'asset `pending` et une URL d'envoi signée (JPEG, PNG, WebP ou AVIF, 10 Mo au plus) ;
  2. le navigateur envoie le fichier ;
  3. `confirmSitePhotoAction({ assetId })` vérifie en serveur le type réel (signature binaire), la taille et les dimensions, puis passe l'asset à `ready` ;
  4. les déclinaisons (480, 828, 1200 px, AVIF et WebP) sont produites à la demande par la transformation d'images.
- **Lecture publique :** une photo n'est servie au public que si elle est référencée par la **version publiée**. Le rendu reçoit des URL signées de courte durée, ou passe par un proxy du SaaS. Une photo du seul brouillon n'est jamais publique.
- **Suppression :** une photo référencée par le brouillon ou par **n'importe quelle** version de l'historique n'est pas supprimée (la restauration doit rester possible).
- **CI :** il faudra démarrer `storage-api`, aujourd'hui exclu du démarrage local et de la CI.

## 9. Découpage

| PR               | Contenu                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** (celle-ci) | `sites`, `site_versions`, `site_assets` (métadonnées). Brouillon avec révision, publication atomique, historique immuable, restauration, lecture publique de la version publiée, forfait côté serveur, validation (schéma, registre, textes, couleurs, appartenance des photos, lisibilité). Tests multi-tenant, concurrence, publication, restauration. |
| **2**            | Photos réelles : Storage, politiques, envoi signé, vérification du type, déclinaisons, accès public limité à la version publiée, CI avec `storage-api`.                                                                                                                                                                                                  |
| **UI**           | Studio branché sur les actions ; rendu public : lentille du forfait, `ensureReadable`, catalogue et réservation existants.                                                                                                                                                                                                                               |

## 10. Arbitrages produit à confirmer

- **Source du forfait :** un champ `sites.plan` modifiable par le service seulement, en attendant la facturation. Il faudra choisir, à l'arrivée de la facturation, si elle écrit ce champ ou si elle devient la source.
- **Accès public aux photos :** URL signées de courte durée (recommandé, contrôle total), ou proxy du SaaS (cache CDN plus simple). À trancher pour la PR 2.
- **Publier sans modification :** ne crée pas de version (pas de doublon dans l'historique). À confirmer.
