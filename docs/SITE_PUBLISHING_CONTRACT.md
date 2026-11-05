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
- **Photos :** jamais une URL. Une photo est `{ "asset": "<uuid>" }`, une photo de `site_assets` **de cet établissement** et prête (`ready`), vérifiée par la base à chaque enregistrement. Les points focaux sont indexés par l'identifiant de l'asset, `x` et `y` de 0 à 100.
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

**Lecture publique** (sans session) : `getPublishedSite(slug)` pour le rendu serveur, ou `GET /api/public/businesses/[slug]/site`. Elle renvoie `{ versionId, number, publishedAt, plan, schemaVersion, config }` ; `site_not_published` (404) sans publication.

## 7. Garanties de concurrence

- **Écritures du brouillon :** comparaison sur `draft_revision`, sous verrou de ligne du site. Deux studios ouverts : l'un gagne, l'autre reçoit `stale_site_draft` et recharge.
- **Publication :** sous verrou de ligne du site. Elle prend le brouillon **à la révision attendue**, insère la version (numéro suivant, unique par site) et bascule `published_version_id` dans la même transaction. Deux publications simultanées sont sérialisées, sans numéro perdu ni dupliqué.
- **Lecture publique :** une seule requête, sur la version pointée. Une publication en cours n'est visible qu'une fois validée.

## 8. Photos (PR 2)

**Décision (4 novembre 2026) : bucket privé et proxy du SaaS**, avec vérification de la version publiée et cache maîtrisé. Pas d'URL signée exposée au public.

- **Stockage :** bucket Supabase Storage **privé** `site-photos`, sous `<business_id>/<asset_id>/…`.
  - Aucune politique pour les rôles de l'API : le navigateur n'écrit qu'avec une URL d'envoi signée, émise par le serveur après vérification de l'appartenance.
  - Seul le service lit.
- **Envoi :**
  1. `createSitePhotoUploadAction({ contentType, byteSize })` crée l'asset `pending` et une URL d'envoi signée (JPEG, PNG, WebP ou HEIC/HEIF, 10 Mo au plus). Le nombre d'envois en attente par établissement est plafonné.
  2. Le navigateur envoie l'original.
  3. `confirmSitePhotoAction({ assetId })` relit le fichier côté serveur et vérifie le type réel (décodage, pas l'extension), la taille et les dimensions. Il produit les déclinaisons puis passe l'asset à `ready`. Un fichier refusé est supprimé.
- **Déclinaisons, produites une fois à l'envoi :** WebP en 480, 828 et 1200 px de large, orientation corrigée, métadonnées (EXIF, GPS) retirées.
- **Proxy public :** `GET /api/public/businesses/[slug]/site/photos/[assetId]/[width]`.
  - Une requête par photo et par taille. La base vérifie que la photo est **référencée par la version publiée** de cet établissement ; sinon 404, même pour une photo existante du brouillon.
  - Cache : `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`. Les URL sont stables, car une photo ne change jamais : une nouvelle photo, c'est un nouvel asset.
- **Suppression :** refusée tant que la photo est référencée par le brouillon ou par **n'importe quelle** version de l'historique, pour que la restauration reste possible. Sinon, l'asset et ses fichiers sont supprimés.
- **Aperçu du studio (membres) :** `GET /api/sites/photos/[assetId]/[width]` sert les mêmes déclinaisons des photos de **son** établissement, qu'elles soient publiées ou non.
  - Session obligatoire, asset `ready` de l'établissement de la session.
  - `Cache-Control: private, max-age=300` : jamais de cache CDN, aucune URL signée exposée.
- **CI :** `storage-api` est démarré (aujourd'hui exclu).

### Étude de performance et de coût (mesures du 4 novembre 2026)

Mesures avec `sharp` 0.35 / libvips 8.18, sur 4 cœurs, pour une photo de 12 Mpx (3000 × 4000) :

| Déclinaisons (480, 828, 1200 px) | Photo bruitée (cas pessimiste) | Photo lisse | Poids total |
| -------------------------------- | ------------------------------ | ----------- | ----------- |
| WebP, qualité 72                 | 0,66 s                         | 0,37 s      | 29 à 322 Ko |
| AVIF, effort 0                   | —                              | 0,48 s      | 28 Ko       |
| AVIF, effort 4                   | 19,6 s                         | 2,9 s       | 20 à 300 Ko |

- **Formats :** WebP seul en V1. Il est lisible par tous les navigateurs visés, et son poids est proche de l'AVIF à effort raisonnable. L'AVIF de qualité coûte jusqu'à 30 fois plus de calcul (près de 20 s par photo dans le cas pessimiste) : trop pour une action serveur, qui risque le dépassement de délai. Il pourra être ajouté plus tard par un traitement en arrière-plan, sans changer les URL.
- **Pas de transformation à la volée** (imgproxy, optimiseur d'images de la plateforme) : les déclinaisons sont calculées une seule fois, à l'envoi, et le coût par vue est nul.
- **Coût par vue :**
  - avec le cache CDN, le proxy (une fonction) ne s'exécute qu'en cas d'absence du cache : environ une fois par photo, par taille et par région CDN et par jour, puis en revalidation ;
  - chaque exécution fait une lecture de la base (référence publiée) et une lecture du stockage ;
  - le transfert est celui de la photo servie (25 à 210 Ko selon la taille).
- **Performance :**
  - **succès de cache** : le temps du CDN, sans exécution ;
  - **absence de cache** : démarrage de fonction, une requête SQL et une lecture du stockage. On peut estimer 0,2 à 0,6 s, à mesurer sur l'hébergement réel ;
  - **photo d'ouverture** (élément LCP) : elle peut être préchauffée juste après une publication, par une requête de fond sur ses trois tailles.
- **Confidentialité contre cache :**
  - une photo retirée de la version publiée reste servie par le CDN au plus 24 h, puis le temps d'une revalidation qui répond 404 ;
  - un navigateur la garde au plus 1 h ;
  - pour un retrait immédiat (demande légale), il faudra une purge manuelle du CDN, hors V1.
- **Stockage :** l'original (jusqu'à 10 Mo) plus environ 30 à 320 Ko de déclinaisons par photo. L'original est conservé, pour pouvoir produire d'autres formats plus tard.

## 9. Découpage

| PR               | Contenu                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** (celle-ci) | `sites`, `site_versions`, `site_assets` (métadonnées). Brouillon avec révision, publication atomique, historique immuable, restauration, lecture publique de la version publiée, forfait côté serveur, validation (schéma, registre, textes, couleurs, appartenance des photos, lisibilité). Tests multi-tenant, concurrence, publication, restauration. |
| **2**            | Photos réelles : Storage, politiques, envoi signé, vérification du type, déclinaisons, accès public limité à la version publiée, CI avec `storage-api`.                                                                                                                                                                                                  |
| **UI**           | Studio branché sur les actions ; rendu public : lentille du forfait, `ensureReadable`, catalogue et réservation existants.                                                                                                                                                                                                                               |

## 10. Décisions produit (validées le 4 novembre 2026)

- **Forfait :** `sites.plan` reste la source serveur de Core et Signature jusqu'à la facturation. Les professionnelles ne le modifient jamais directement.
- **Photos publiques :** proxy du SaaS sur bucket privé, avec vérification de la version publiée et cache maîtrisé (§ 8).
- **Publier un brouillon inchangé** ne crée pas de nouvelle version.
- **Lisibilité :** les corrections se font dans le studio (`ensureReadable`), et la vérification à la publication, côté serveur, est obligatoire.

## 11. Validation du contrat par Claude UI

**État : validé des deux côtés (5 novembre 2026)**, après deux ajustements demandés par Claude UI. Une décision produit reste ouverte (photos de démonstration).

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

**Décision produit ouverte, les photos de démonstration des univers :**

- **Recommandation (Claude UI, et backend d'accord) :** ne jamais les enregistrer ni les publier en V1. Elles servent seulement d'aperçu dans le studio, et les scènes ont un vrai état « sans photo ».
- **Autre option :** un registre fermé `{ stock: "<id>" }` de photos sous licence. Cela demande une extension du format et des droits d'usage.

Claude UI ne branche le studio sur les actions qu'une fois cette décision prise.
