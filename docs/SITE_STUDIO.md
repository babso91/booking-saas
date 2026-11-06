# Studio de personnalisation du site (PR B)

Le studio où la professionnelle compose son mini-site (`/app/site`) est le
studio du laboratoire (`proto/experience-engine`), branché sur le contrat
de publication de Cloud (`docs/SITE_PUBLISHING_CONTRACT.md`). Ce document
décrit la base de la PR, ses prérequis, ce que le studio garantit, comment
c'est vérifié et ce qui reste ouvert.

## 1. Base et prérequis

La PR est empilée sur une seule base technique, qui contient `main`
(`6328836`) et toutes les PR dont elle dépend. Les deux lignées se
rejoignent dans #44 :

| PR  | Branche                            | HEAD inclus | Apport utilisé ici                                                                                                                                       |
| --- | ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #39 | `feat/catalog-pro` (Claude UI)     | via #42     | catégories dans Prestations                                                                                                                              |
| #42 | `feat/booking-options` (Claude UI) | `de5ae72`   | réservation publique sur le catalogue avec options : devis serveur, prix et durée                                                                        |
| #40 | `feat/site-publishing` (Cloud)     | via #43     | `sites`, `site_versions`, brouillon et révision, `stale_site_draft`, publication atomique, restauration, `plan` côté serveur, `renderedFor`              |
| #43 | `feat/site-photos` (Cloud)         | `4ef106e`   | bucket privé `site-photos`, `createSitePhotoUploadAction`, `confirmSitePhotoAction`, `/api/sites/photos/[assetId]/[width]`, `site_photo_cleanup_pending` |
| #44 | `feat/minisite-render` (Claude UI) | `18092e5`   | moteur et scènes Mila, Alma et Nail Lab, `MiniSite`, rendu public `/b/[slug]`, `useLessMotion`, et #42 fusionnée                                         |
| B   | `feat/site-studio`                 | cette PR    | le studio                                                                                                                                                |

La base GitHub de la PR est `feat/minisite-render`. Les branches de Cloud
(#40, #43) n'ont pas été modifiées.

**#44 sur #42.** #42 a fait passer `PublicBooking` au catalogue public
(catégories, prestations, options) ; #44 lui donnait encore une liste de
prestations. #42 est fusionnée dans #44 (`18092e5`), avec l'adaptation de
`/b/[slug]`, `MiniSite`, `SiteBooking` et `PublicBooking` :

- `/b/[slug]` lit `get_public_catalog` une fois pour les deux pages : la
  page de réservation sans mini-site (comme avant), le mini-site avec.
- La réservation du mini-site est celle de la page :
  `{ business, catalog }`, devis et prix du serveur. Une prestation touchée
  sur le site s'ouvre sur ses options quand elle en a.
- Le mini-site et le Studio disent le prix comme la page de réservation :
  le minimum des réponses obligatoires, « dès » quand une réponse peut
  l'augmenter (`startingAt`).

Ce qui n'est pas utilisé :

- Aucune migration, aucune RPC, aucune règle RLS ni Server Action.
- Aucun stockage parallèle.
- Aucune dépendance npm ajoutée.

Le studio appelle uniquement les Server Actions du contrat (§ 6) et l'envoi
de photo du § 8, regroupés dans `src/features/experience/studio/actions.ts`.

## 2. Ce que le studio garantit

**Moteur.** L'aperçu du studio est le vrai `MiniSite`, avec les scènes de
#44, sans reconstruction ni simplification. Il ne prend jamais de
réservation (`booking={null}`).

**Brouillon.** Le brouillon s'enregistre tout seul 900 ms après la dernière
modification (`draft-sync.ts`) :

- Chaque sauvegarde porte la révision lue (`expectedRevision`), avec une
  seule sauvegarde en vol à la fois.
- Si la page est quittée avant l'enregistrement, le navigateur demande
  confirmation (`beforeunload`).
- Une coupure réseau est affichée. Les modifications restent à l'écran,
  avec un bouton « Réessayer ».

**Conflits.** Sur `stale_site_draft`, le studio relit le serveur et
n'écrase rien. Il affiche les deux choix et n'enregistre que celui qu'elle
fait :

- « Garder ma version » : sa version est réenregistrée sur la nouvelle
  révision.
- « Reprendre la version enregistrée » : la version du serveur remplace la
  sienne à l'écran.

**Comparaisons.** Les configurations sont comparées sous forme canonique
(`canonical.ts`), quel que soit l'ordre des clés. PostgreSQL (`jsonb`) et
zod rendent les clés dans leur propre ordre. Sans cela, un brouillon déjà
enregistré paraîtrait modifié, avec une sauvegarde inutile à chaque
ouverture et un bouton « Publier » allumé à tort.

**Publication.** Le studio enregistre d'abord le brouillon exactement tel
qu'il sera publié, corrections de lisibilité (`ensureReadable`) comprises,
puis appelle `publishSiteAction` sur cette révision. Les messages
`site_unreadable` et `stale_site_draft` disent que rien n'a été publié.

**Aperçu Brouillon / En ligne.** « En ligne » affiche la version publiée,
vue à travers son forfait, comme ses clientes la voient.

**Historique et restauration.** L'onglet « Historique » liste les versions
publiées. « Reprendre » demande confirmation (« Remplacer mon brouillon »),
puis remet la version dans le brouillon. Rien ne change en ligne avant
qu'elle publie.

**Photos.**

- Envoi : création côté serveur, puis `uploadToSignedUrl` vers le bucket
  privé, puis vérification et redimensionnement par le serveur.
- Formats acceptés : JPEG, PNG et WebP, 10 Mo au plus, vérifiés aussi
  avant l'envoi. Le HEIC n'est pas accepté : iOS le convertit.
- Recadrage par point focal, au doigt ou aux flèches du clavier.
- « Mes photos » réutilise une photo déjà envoyée.
- Chaque code d'erreur a son message (`photos.ts`), y compris
  `site_photo_cleanup_pending` (« c'est enregistré, réessaie »).
- Une photo révoquée disparaît de l'aperçu.

**Photos de démonstration.** Les photos des univers (ids `demo:…`) ne
servent qu'à habiller l'aperçu du studio ; une case permet de les retirer.
`savedConfigOf` les retire de tout ce qui est envoyé. Elles ne sont jamais
enregistrées ni publiées.

**Core / Signature.**

- Le forfait est celui du serveur (`sites.plan`). Le studio ne le modifie
  jamais.
- En Core, les réglages Signature sont masqués mais conservés dans le
  brouillon. Ils réapparaissent avec Signature (lentille `renderedFor` du
  serveur).

**Catalogue.** L'onglet « Prestations » affiche le catalogue du backend
(`get_public_catalog`) en lecture seule. Il ne dépend pas de la publication
du design ; on le modifie dans Prestations.

**Navigation.** « Mon site » apparaît dans les quatre navigations, à côté
d'« Apparence ». Le studio a un retour « ← » vers l'espace.

## 3. Aperçu de conception `/apercu/mon-site`

C'est le même studio, branché sur un serveur en mémoire
(`memory-actions.ts`) qui imite le contrat : révisions, `stale_site_draft`,
versions immuables, restauration et validation par `siteConfigSchema`.
Rien n'atteint une base, un bucket ou une page publique.

Paramètres :

- `?forfait=core|signature`
- `?publie=1` : une version en ligne
- `?conflit=1` : un autre onglet enregistre avant elle
- `?photo=<code>` : chaque envoi échoue avec ce code

Comme tout `/apercu`, la page renvoie une 404 en production, sauf avec
`DASHBOARD_PREVIEW=1` (`src/app/(apercu)/apercu/layout.tsx`). C'est aussi
le cas de `/apercu/mini-site`, qui ne prend aucune réservation.

## 4. Vérifications

**Tests unitaires** (`src/features/experience/studio`) :

- brouillon sauvegardé seul ;
- conflit, avec les deux choix ;
- reprise après coupure réseau ;
- démo jamais envoyée ;
- ordre des clés du serveur ;
- conversion sans perte ;
- annuler et rétablir.

**E2E sur la vraie pile** (`tests/e2e/site-studio-browser.test.ts` : Auth,
PostgreSQL, Storage), à 390 px, 320 px avec moins d'animations, et 1280 px :

- révision 0 → 1 → 2 ;
- aucune démo en base ;
- publication en version 1, visible sur `/b/[slug]` ;
- conflit provoqué par un autre onglet en SQL : rien d'écrasé, puis « Garder
  ma version » ;
- restauration avec `draft_restored_from` ;
- après rechargement, pas de sauvegarde superflue ;
- axe WCAG 2.1 AA ;
- aucun défilement horizontal ;
- aucune erreur console, y compris d'hydratation.

S'y ajoutent :

- une vraie photo JPEG envoyée, vérifiée (`site_assets.status = ready`),
  enregistrée par son id, publiée et servie par le proxy public ;
- Signature puis Core via `set_site_plan` : réglage conservé, onglet
  masqué, une modification en Core ne le perd pas.

**Navigateur, sur l'aperçu en mémoire** (320/390/1280, moins d'animations) :

- tous les parcours ci-dessus, plus les erreurs `site_photo_cleanup_pending`
  et `site_photo_unsupported` ;
- ordre de focus au clavier ;
- axe : 0 violation ;
- 0 erreur console.

## 5. Limites et suites

**Limites connues :**

- Pas testé sur un vrai iPhone : HEIC converti par le sélecteur, Live
  Photo.
- À 320 px, le panneau occupe beaucoup de hauteur (en-tête, statut,
  onglets). C'est utilisable, mais à affiner avec la direction artistique.
- Au clavier, l'aperçu du site vient avant le panneau du studio.

**Suites :**

- **#44 :** l'écart d'hydratation d'Alma en mode « moins d'animations » a
  été corrigé (`useLessMotion`, instantané serveur stable) et vérifié sans
  erreur console. L'e2e de #44 l'exige désormais pour Alma à 320 px.
- **Parcours complet avec options (fait, sur #44) :**
  `tests/e2e/mini-site-booking-browser.test.ts`. Une prestation a une
  option obligatoire et une facultative ; le site est publié ; une cliente
  réserve depuis le mini-site. Le test vérifie le devis serveur, la
  confirmation, puis le rendez-vous dans PostgreSQL (prix, durée, réponses,
  jour) et dans l'agenda avec ses totaux. Il tourne à 390 px (Mila), 320 px
  avec moins d'animations (Alma) et 1280 px (Nail Lab).
- **Ancien parcours sans mini-site :** couvert par
  `tests/e2e/booking-options-browser.test.ts` (#42), inchangé, et par le test
  de page `/b/[slug]`.
- **Contrat § 10 :** les options se modifient dans Prestations (#39/#42).
  Le Studio les affiche en lecture seule ; un éditeur d'options dans le
  Studio n'est pas prévu dans cette PR.
