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
| `public.site_assets`   | les photos de l'établissement : `pending` (envoyée, pas vérifiée), `ready` (vérifiée, déclinaisons produites), `revoked` (révoquée, définitif). Seules celles-ci peuvent être référencées par une configuration (§ 8)                     |

- **Brouillon :** privé, modifiable par les membres de l'établissement seulement. `draft_revision` est le jeton de comparaison : une écriture fondée sur une révision dépassée est refusée (`stale_site_draft`).
- **Publication :** copie atomique du brouillon dans une nouvelle version, et bascule de `published_version_id` dans la même transaction. Le public ne voit jamais d'état intermédiaire.
- **Historique et restauration :** les versions publiées forment l'historique. Restaurer copie une version ancienne **dans le brouillon**. Rien n'est réécrit, et publier ensuite crée une nouvelle version, avec `restored_from`.
- **Lecture publique :** uniquement la version publiée, par le slug de l'établissement. Un brouillon n'est jamais lisible publiquement, et un établissement sans publication n'a pas de site (`site_not_published`).

## 3. Forfaits Core et Signature

- **Source de vérité :** `sites.plan`, côté serveur. Il n'existe pas encore de facturation dans le SaaS. Le forfait n'est donc **modifiable que par le service** (`set_site_plan`, rôle `service_role`), jamais par la professionnelle ni par le navigateur.
- **Rien n'est jamais détruit ni réécrit par un changement de forfait :**
  - le brouillon peut contenir des réglages Signature en sommeil, même en Core ;
  - une version publiée garde sa configuration complète.
- **Les droits sont une lentille appliquée au rendu** (`renderedFor(config, plan)` et `coreLens(config)` de `src/features/sites/universes.ts`, l'`effective` du laboratoire, en une seule copie partagée par le serveur, le moteur et le rendu public), côté serveur, sur la version publiée et avec le forfait **actuel** : repasser en Core cesse immédiatement de rendre les réglages Signature, et repasser en Signature les rend sans republier. La lecture publique renvoie la configuration publiée **et** le forfait actuel. Le rendu (Claude UI, composant serveur) applique la lentille, puis le filet de lisibilité `ensureReadable`.

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
- **Photos :** jamais une URL. Une photo est `{ "asset": "<uuid>" }`, une photo de `site_assets` **de cet établissement**, prête (`ready`) ou révoquée (`revoked`, dessinée sans photo : c'est le cas d'une ancienne version restaurée), vérifiée par la base à chaque enregistrement. Une photo en attente, inconnue ou d'un autre établissement est refusée (`site_asset_unavailable`). Les points focaux sont indexés par l'identifiant de l'asset, `x` et `y` de 0 à 100.
- **Œuvres :** de 0 à 24.
- **Taille :** 256 Kio au plus pour le document.
- **Évolution :** `schema_version` est stocké avec chaque brouillon et chaque version. Une version 2 viendra avec des fonctions de migration pures (1 → 2) appliquées à la lecture, sans réécrire l'historique.

## 5. Lisibilité (« l'art est libre, la lisibilité ne l'est pas »)

- **Le studio** applique `ensureReadable` avant de publier, et montre les corrections (comportement du laboratoire).
- **Le serveur vérifie à la publication**, sans jamais corriger en silence, les couples de texte de la palette au contraste WCAG d'au moins 4,5:1 :
  - encre sur fond nuit ;
  - encre sur fond jour ;
  - texte sur accent ;
  - secondaire sur fond nuit.
- **Pour les deux rendus possibles** : la palette enregistrée (Signature) **et** la palette vue par la lentille Core (`coreLens`, `src/features/sites/universes.ts` : la palette conçue de l'univers, avec l'accent de la professionnelle). Le forfait peut changer sans republication, donc une version publiée doit se lire sous les deux forfaits. Sinon, refus `site_unreadable` (422), avec chaque couple en défaut et le forfait concerné (« Core — Le texte des boutons sur l'accent : 2,1:1 »).
- **Le bouton de réservation** (`cta`) n'a pas besoin de contrôle : son texte est calculé (noir ou blanc), et toute couleur atteint au moins 4,58:1 avec l'un des deux.
- **Le brouillon** peut rester illisible : l'expérimentation est libre, seule la publication est bloquée.
- **Le rendu public** applique quand même `ensureReadable`. Les couples dérivés (secondaire sur fond jour, cartes) sont calculés par le moteur et garantis par `ensureReadable`.

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

**Photos** (§ 8) :

| Action                                                   | Réponse                                                                 | Erreurs propres                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `createSitePhotoUploadAction({ contentType, byteSize })` | `{ assetId, path, token, signedUrl }` : où envoyer l'original           | `validation_error` (type, taille), `rate_limited`                                                                                       |
| `confirmSitePhotoAction({ assetId })`                    | `SitePhotoDto` prête (type réel, dimensions redressées)                 | `site_photo_not_found` (pas encore reçue), `site_photo_unsupported`, `site_photo_too_large`, `site_photo_invalid`, `site_photo_revoked` |
| `listSitePhotosAction()`                                 | `SitePhotoDto[]` (en attente, prêtes, révoquées ; plus récente d'abord) | —                                                                                                                                       |
| `deleteSitePhotoAction({ assetId })`                     | `{ deleted }` (`false` : photo déjà révoquée, rien à supprimer)         | `site_asset_in_use`, `site_photo_not_found`                                                                                             |
| `revokeSitePhotoAction({ assetId })`                     | rien : révoquée, fichiers supprimés                                     | `site_photo_not_found`                                                                                                                  |

**Lecture publique** (sans session) : `getPublishedSite(slug)` pour le rendu serveur, ou `GET /api/public/businesses/[slug]/site`. Elle renvoie `{ versionId, number, publishedAt, plan, schemaVersion, config, unavailableAssets }` ; `site_not_published` (404) sans publication. `unavailableAssets` : les photos de `config` révoquées depuis la publication, que le rendu dessine **sans photo**.

## 7. Garanties de concurrence

- **Écritures du brouillon :** comparaison sur `draft_revision`, sous verrou de ligne du site. Deux studios ouverts : l'un gagne, l'autre reçoit `stale_site_draft` et recharge.
- **Publication :** sous verrou de ligne du site. Elle prend le brouillon **à la révision attendue**, insère la version (numéro suivant, unique par site) et bascule `published_version_id` dans la même transaction. Deux publications simultanées sont sérialisées, sans numéro perdu ni dupliqué.
- **Lecture publique :** une seule requête, sur la version pointée. Une publication en cours n'est visible qu'une fois validée.

## 8. Photos (PR 2)

**Décisions (4 et 5 novembre 2026) : bucket privé et proxy du SaaS**, WebP seul, cache CDN court, révocation explicite. Pas d'URL signée exposée au public.

### Stockage

- Bucket Supabase Storage **privé** `site-photos` (10 Mo au plus par fichier ; JPEG, PNG, WebP, AVIF), sous `<business_id>/<asset_id>/` : `original` le temps de la vérification, puis `w480.webp`, `w828.webp`, `w1200.webp`.
- **Aucune politique** pour les rôles de l'API : ni le public ni une professionnelle connectée ne lit, ne liste ni n'écrit le bucket directement (testé). Le navigateur n'écrit qu'avec une URL d'envoi signée, pour **un seul chemin**, sans écrasement, émise par le serveur après vérification de l'appartenance. Seul le service lit et supprime.
- **L'original n'est pas conservé** : il porte les métadonnées de l'appareil (EXIF, GPS). Il est supprimé dès que les déclinaisons existent. Si un autre format est voulu plus tard (AVIF), il faudra conserver un maître nettoyé (sans métadonnées) : décision à prendre à ce moment-là.

### Envoi et conversion

1. `createSitePhotoUploadAction({ contentType, byteSize })` crée l'asset `pending` et l'URL d'envoi signée. Au plus 20 envois en attente par établissement sur 24 h (`rate_limited`).
2. Le navigateur envoie l'original : `storage.from("site-photos").uploadToSignedUrl(path, token, file)`.
3. `confirmSitePhotoAction({ assetId })` relit le fichier côté serveur (`sharp` 0.35 / libvips 8.18, `src/features/sites/photos/process.ts`) :
   - **type réel par décodage**, jamais l'extension ni le type déclaré (un PNG déclaré JPEG est enregistré PNG ; SVG, GIF, HTML, fichier tronqué : refusés) ;
   - taille (10 Mo), **bombe de décompression** refusée à la lecture de l'en-tête (plus de 50 Mpx), côté court d'au moins 320 px, rapport d'au plus 4:1 ;
   - **orientation EXIF appliquée** (pixels redressés, testé sur le contenu), conversion sRGB, **aucune métadonnée conservée** (EXIF, GPS, XMP, ICC, commentaires), première image seulement pour une image animée ;
   - déclinaisons **WebP 480, 828 et 1200 px** (jamais agrandies), puis `ready`.

   Un fichier refusé est oublié (asset et fichiers). Confirmer avant l'arrivée du fichier répond `site_photo_not_found` et laisse l'asset en attente. Confirmer une photo prête renvoie la même réponse.

**iPhone et HEIC (vérifié dans l'environnement cible, 5 novembre 2026) :** le `sharp` précompilé (le même binaire Linux x64 en local, en CI et sur l'hébergement) lit l'AVIF mais **ne décode pas le HEIC** (HEVC, brevets). Le serveur refuse donc `image/heic` et `image/heif` dès la création, avec un message qui guide vers la photothèque.

- **Le studio doit** déclarer `accept="image/jpeg,image/png,image/webp"` sur son sélecteur de fichier : iOS convertit alors la photo HEIC en JPEG au moment du choix.
- **À vérifier sur un vrai iPhone** avant la mise en production (pas possible ici) : sélection depuis la photothèque et depuis l'appareil photo, photo en portrait (orientation), Live Photo, mode HDR. Le serveur, lui, est testé sur un JPEG d'appareil photo tourné avec GPS.

### Diffusion publique

`GET /api/public/businesses/[slug]/site/photos/[assetId]/[width]` (`width` : 480, 828 ou 1200).

- **À chaque exécution** (chaque absence du cache), la base vérifie : la photo est `ready` (pas révoquée), de cet établissement, et **référencée par sa version publiée**. Sinon 404, même pour une photo existante du brouillon, d'une ancienne version ou d'un autre établissement. Le bucket ne décide jamais : un fichier remis par erreur sous le chemin d'une photo révoquée n'est pas servi (testé).
- **Cache :** `Cache-Control: public, max-age=0, s-maxage=300`.
  - CDN : **5 minutes au plus** ; pas de `stale-while-revalidate`.
  - Navigateur : aucune copie fraîche prolongée (`max-age=0`).
  - 404, 503 et toute erreur : `no-store`, jamais mis en cache.
  - Les URL sont naturellement versionnées : une photo ne change jamais, une nouvelle photo est un nouvel asset.
- En-têtes : `Content-Type: image/webp`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Vercel-Cache-Tag: site-photo-<assetId>`.

### Aperçu du studio (membres)

`GET /api/sites/photos/[assetId]/[width]` : les mêmes déclinaisons des photos `ready` de **son** établissement, publiées ou non.

- Session obligatoire ; l'établissement vient de la session, jamais de la requête.
- `Cache-Control: private, max-age=300` : le cache de son navigateur seulement, **jamais un cache partagé**. Refus, absence de session et 404 : `no-store`.

### Suppression et révocation

- **Supprimer** (`deleteSitePhotoAction`) : seulement une photo que rien ne référence, ni le brouillon ni **aucune** version (photo ou point focal) ; sinon `site_asset_in_use`. L'asset et ses fichiers disparaissent.
- **Révoquer** (`revokeSitePhotoAction`), quelles que soient ses références : **définitif et idempotent**.
  1. La base passe l'asset à `revoked` (date, motif) : dès cet instant, les deux proxys refusent la photo.
  2. Ses fichiers (original et déclinaisons) sont supprimés. Une nouvelle tentative supprime ce qui resterait.
  - **L'historique n'est jamais réécrit** : les versions publiées gardent la référence. Le rendu dessine son emplacement sans photo (`unavailableAssets`).
  - **Pas de résurrection** : restaurer puis republier une ancienne version la réaffiche sans photo (testé) ; une photo révoquée ne redevient jamais prête, ni ne peut être confirmée, ni supprimée pour être recréée. Renvoyer la même image crée un nouvel asset.
  - Une révocation pendant la conversion gagne : les déclinaisons écrites entre-temps sont supprimées (testé).
- **Demande de confidentialité** (personne photographiée, demande d'effacement) : `revokeSitePhotoForPrivacy(service, businessId, assetId)` par le service, sans membre, motif `privacy`. Même effet. Le premier motif reste.
- **Délai réel :** le serveur ne sert plus la photo dès la révocation. Une copie déjà dans un cache CDN peut encore être servie **jusqu'à 5 minutes** ; aucun navigateur n'en garde de copie fraîche. **Aucune suppression instantanée n'est promise** tant que la purge n'est pas testée.

### Purge ciblée et durées plus longues (étude, rien de branché)

- **Possible sur l'hébergement :** chaque réponse publique porte `Vercel-Cache-Tag: site-photo-<assetId>`. La révocation pourrait appeler `dangerouslyDeleteByTag` (`@vercel/functions`) ou l'API `POST /v1/edge-cache/dangerously-delete-by-tags`. Attention : `invalidateByTag` **sert encore la copie périmée** pendant le rafraîchissement, il ne convient donc pas à une révocation.
- **Avant d'allonger le cache CDN,** il faudra : tester la purge sur un déploiement de prévisualisation (révoquer, puis mesurer le délai de disparition dans plusieurs régions) ; décider du comportement si la purge échoue (réessai, alerte) ; et garder une durée de secours bornée.
- Le versionnement des URL ne règle pas la révocation : l'URL d'une photo révoquée reste la même ; c'est la base qui la refuse.

### Hors périmètre de la PR 2

- Photos en attente jamais confirmées : leurs originaux restent jusqu'à un nettoyage périodique, à ajouter (tâche planifiée).
- Fichiers d'un établissement supprimé : même nettoyage.
- Photos de démonstration des univers : jamais enregistrées ni publiées (§ 10).

### Étude de performance et de coût (mesures du 4 novembre 2026)

Mesures avec `sharp` 0.35 / libvips 8.18, sur 4 cœurs, pour une photo de 12 Mpx (3000 × 4000) :

| Déclinaisons (480, 828, 1200 px) | Photo bruitée (cas pessimiste) | Photo lisse | Poids total |
| -------------------------------- | ------------------------------ | ----------- | ----------- |
| WebP, qualité 72                 | 0,66 s                         | 0,37 s      | 29 à 322 Ko |
| AVIF, effort 0                   | —                              | 0,48 s      | 28 Ko       |
| AVIF, effort 4                   | 19,6 s                         | 2,9 s       | 20 à 300 Ko |

- **Formats :** WebP seul en V1 (décision du 5 novembre 2026), qualité 80. L'AVIF de qualité coûte jusqu'à 30 fois plus de calcul : trop pour une action serveur.
- **Pas de transformation à la volée** : les déclinaisons sont calculées une seule fois, à l'envoi.
- **Coût par vue :** avec 5 minutes de CDN, le proxy s'exécute au plus une fois par photo, par taille, par région et par tranche de 5 minutes de trafic. Chaque exécution fait une requête SQL et une lecture du stockage. À mesurer sur l'hébergement réel avant tout réglage.
- **Stockage :** 30 à 320 Ko de déclinaisons par photo (l'original n'est pas conservé).

## 9. Découpage

| PR               | Contenu                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** (celle-ci) | `sites`, `site_versions`, `site_assets` (métadonnées). Brouillon avec révision, publication atomique, historique immuable, restauration, lecture publique de la version publiée, forfait côté serveur, validation (schéma, registre, textes, couleurs, appartenance des photos, lisibilité). Tests multi-tenant, concurrence, publication, restauration. |
| **2**            | Photos réelles : bucket privé, envoi signé, vérification du type réel, déclinaisons WebP, aperçu des membres, diffusion publique limitée à la version publiée (cache CDN de 5 min), suppression, révocation, CI avec `storage-api`.                                                                                                                      |
| **UI**           | Studio branché sur les actions ; rendu public : lentille du forfait, `ensureReadable`, catalogue et réservation existants.                                                                                                                                                                                                                               |

## 10. Décisions produit (validées le 4 novembre 2026)

- **Forfait :** `sites.plan` reste la source serveur de Core et Signature jusqu'à la facturation. Les professionnelles ne le modifient jamais directement.
- **Photos publiques :** proxy du SaaS sur bucket privé, avec vérification de la version publiée et cache maîtrisé (§ 8).
- **Publier un brouillon inchangé** ne crée pas de nouvelle version.
- **Lisibilité :** les corrections se font dans le studio (`ensureReadable`), et la vérification à la publication, côté serveur, est obligatoire.

Validées le 5 novembre 2026 :

- **Photos de démonstration :** elles servent uniquement à montrer l'allure des univers dans le studio. Jamais enregistrées dans la configuration d'une professionnelle, jamais publiées. Les compositions artistiques sont préservées, avec des états « sans photo » élégants.
- **Formats :** WebP seul en V1 (480, 828, 1200 px, produits à l'envoi), pas d'AVIF.
- **Cache public :** CDN 5 minutes au plus, `max-age=0`, pas de `stale-while-revalidate`, aucun cache partagé des aperçus, des refus ni des 404, vérification serveur à chaque absence du cache. Pas d'allongement avant une étude de purge testée (§ 8).
- **Révocation :** mécanisme explicite, définitif, sans réécrire l'historique ; une version restaurée affiche un état sans photo (§ 8).

## 11. Validation du contrat par Claude UI

**État : validé des deux côtés (5 novembre 2026)**, après deux ajustements demandés par Claude UI. La décision produit sur les photos de démonstration est prise (§ 10).

Claude UI a vérifié la conversion de la `SiteConfig` du laboratoire champ par champ : elle est sans perte. Le champ `design` du studio devient `config.universe`. Le catalogue, les saisies de montants et le forfait figé ne sont volontairement pas publiés. Seules les photos de démonstration (identifiants Unsplash) ne sont pas des `{ asset }`.

| Point                                                  | Réponse de Claude UI                                                                                                                                 | Suite                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1. Format `schema_version` 1                           | accepté                                                                                                                                              | photos de démonstration : décision produit ci-dessous                                                    |
| 2. Brouillon séparé, historique immuable, restauration | accepté (annuler et rétablir restent locaux ; sauvegarde automatique avec `expectedRevision` ; sur `stale_site_draft`, rechargement et écart montré) | —                                                                                                        |
| 3. Lentille du forfait au rendu                        | accepté, à condition que les palettes conçues soient dans un module partagé                                                                          | fait : `src/features/sites/universes.ts` (`universeDesigns`, `coreLens`, `renderedFor`), une seule copie |
| 4. Lisibilité                                          | contesté : le serveur ne vérifiait que la palette enregistrée, pas le rendu Core                                                                     | corrigé : vérification sous les deux forfaits, forfait indiqué dans `site_unreadable` (§ 5)              |
| 5. Actions et codes du § 6                             | accepté                                                                                                                                              | —                                                                                                        |
| 6. Photos                                              | contesté : aucun moyen d'afficher dans le studio les photos du brouillon                                                                             | accepté : route réservée aux membres, sans cache partagé (§ 8), livrée avec la PR 2                      |
| 7. Catalogue et réservation par leurs routes           | accepté (PR UI #39 et #42 déjà conformes)                                                                                                            | —                                                                                                        |

**Photos de démonstration des univers : décidé (5 novembre 2026).** Elles ne servent qu'à l'aperçu dans le studio, ne sont jamais enregistrées ni publiées, et les scènes ont un vrai état « sans photo ». Claude UI peut brancher le studio sur les actions.
