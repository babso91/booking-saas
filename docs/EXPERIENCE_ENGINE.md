# Moteur d'expériences : laboratoire (branche `proto/experience-engine`)

Prototype jouable, sur données fictives, servi uniquement en développement (`/labo/mila`, `/labo/alma`, `/labo/nail-lab`).

Rien ici ne touche :

- la réservation réelle ;
- le Client Hub ;
- le staging ;
- le backend.

Ce document décrit l'architecture retenue et propose la future persistance.

## 1. Parcours

1. **Arrivée :** lien direct de la professionnelle (Instagram, SMS) vers son mini-site.
2. **Découverte :** réalisations et prestations.
3. **Réservation sans compte :** prestation, créneau, prénom et email, puis confirmation par email.
4. **Réservation rapide :** toujours à un tap. Elle s'efface quand les prestations sont à l'écran, puisque chacune y mène déjà.

Le Client Hub reste facultatif et hors du mini-site.

## 2. Architecture : des scènes d'art, un moteur qui compose

Un site est une `SiteConfig` (`engine/config.ts`) :

- **Contenu :** identité et photos. **Pas les prestations** : elles sont une donnée métier, à part (section 2 bis).
- **Tokens :**
  - palette ;
  - paire typographique ;
  - traitement photo ;
  - langage de mouvement ;
  - formes.
- **Scènes :** une liste ordonnée, chacune nommant une **variante**.

| Scène        | Variantes                           |
| ------------ | ----------------------------------- |
| Ouverture    | Coupe Didone · Éclosion · Cinétique |
| Manifeste    | Manifeste · Lignes                  |
| Réalisations | Lookbook · Arches · Pellicule       |
| Portrait     | Éditorial · Arche                   |
| Prestations  | Index de prix · Étagère · Tuiles    |

**Sections affichées :** c'est son contenu, donc chaque formule le garde, y compris en changeant d'univers. Elle peut masquer le manifeste, les réalisations ou le portrait. L'ouverture (son nom) et les prestations (la réservation) restent toujours affichées. L'ordre et les variantes relèvent de Signature.

**Principe :**

- Les variantes sont des compositions dessinées à la main (`scenes/*`), pas des blocs génériques.
- Le moteur les compose et leur fournit tokens, contenu et actions (réserver).
- Le langage de mouvement change la façon dont chaque variante se révèle (coupe, respiration, impulsion), sans toucher à sa composition.

Le moteur s'adapte à l'ambition artistique, pas l'inverse. Ajouter un univers, c'est de la configuration. Ajouter une façon de raconter, c'est une nouvelle variante, réutilisable par toutes.

**Univers :**

- **Mila et Alma** sont des configurations.
- **Nail Lab n'a aucun code propre.** Ses variantes nouvelles (Cinétique, Pellicule, Tuiles) enrichissent la bibliothèque commune.

## 2 bis. Le catalogue : une donnée métier, jamais une donnée de design

Le catalogue (`catalog/model.ts`) contient les catégories, les prestations et leurs options. Il ne vit **pas** dans la `SiteConfig`, et aucun univers ne le possède :

- **Changer d'univers ne le touche pas.** Mila, Alma et Nail Lab décident seulement de la façon de le montrer.
- **Le moteur ne reçoit qu'une projection publique**, `showcase()` :
  - les catégories visibles, dans son ordre ;
  - leurs prestations actives et nommées ;
  - une catégorie vide ou masquée n'atteint jamais une scène ;
  - les prestations sans catégorie viennent en dernier, sans titre.
- **Aucun métier n'est codé :** aucune catégorie n'est obligatoire ni prédéfinie. Les trois catalogues fictifs du labo (`catalog/pros.ts`) le prouvent : cils, henné, épilation, à ouvrir dans chaque univers via `/labo/<univers>?pro=cils|henne|epilation`.
- **Robustesse des scènes :**
  - de 2 à 15 catégories ; à partir de 4, une rangée de raccourcis vers chaque catégorie ;
  - d'une prestation à plusieurs dizaines (les tuiles se resserrent au-delà de 10) ;
  - les intitulés longs passent à une taille plus petite avec césure française ;
  - « Offert » plutôt que « 0 € », « 12,50 € » plutôt que « 12,5 € » ;
  - catalogue vide : la scène garde sa place et dit « Bientôt », et aucun bouton « Réserver » ne mène nulle part.
- **Options :**
  - une question, des réponses ; la première est la réponse par défaut ;
  - chaque réponse a un supplément (≥ 0) et une durée en plus, **0 sauf si la professionnelle la règle** : jamais supposée ;
  - dans la réservation, une étape « Options » apparaît seulement si la prestation en a, et le prix et la durée se mettent à jour à chaque choix.

### Contrat backend proposé (non construit ici)

La source de vérité unique reste la table `services` (`name` 1–120, `description` ≤ 1000, `duration_minutes` 5–720, `price_cents` ≥ 0, `active`, `display_order`). Le labo en reprend exactement les limites (`limits`, `validate()`). Ajouts proposés pour une PR backend :

- **`service_categories`** : `id`, `business_id`, `name` (1–60), `visible`, `display_order`.
- **`services.category_id`** : nullable, `on delete set null`. Supprimer une catégorie demande à la professionnelle de garder ses prestations ou de les supprimer.
- **`service_options`** : `id`, `service_id`, `question` (1–120), `display_order`.
- **`service_option_choices`** : `id`, `option_id`, `label` (1–60), `price_delta_cents` (≥ 0), `duration_delta_minutes` (0–240), `display_order`. La première est le défaut.
- **Réservation :**
  - `POST /api/bookings` reçoit les réponses choisies ;
  - **le serveur recalcule** prix et durée, sans jamais faire confiance au total envoyé ;
  - la durée totale (prestation et options) entre dans le calcul des disponibilités, et ne dépasse jamais 720 min ;
  - le rendez-vous garde un instantané des réponses et du prix, pour qu'une modification ultérieure du catalogue ne réécrive pas l'historique.
- **Retrait d'une prestation :** une prestation déjà réservée ne se supprime pas physiquement. Elle passe inactive (archivée), car les rendez-vous la référencent.
- **À trancher : brouillon ou effet immédiat ?** Dans le labo, le catalogue suit « Publier » comme le design. En production, on peut soit enregistrer chaque modification tout de suite (simple, mais un prix à moitié tapé serait réservable), soit tenir un brouillon côté serveur. Ma recommandation : brouillon côté serveur, publié avec le site.

## 3. Core (« Simple ») et Signature (« Créatif ») : un seul éditeur

Même moteur, mêmes univers, mêmes animations, et le même studio en deux modes. Ce qui change, c'est ce que le studio peut modifier (`plans.ts`).

| Possibilité                                       | Simple (Core) | Créatif (Signature) |
| ------------------------------------------------- | ------------- | ------------------- |
| Univers complets, changer d'univers               | oui           | oui                 |
| Photos (point focal compris), textes, prestations | oui           | oui                 |
| Catalogue : catégories, prix, durées, options     | oui           | oui                 |
| Couleur du bouton « Réserver »                    | oui           | oui                 |
| Palettes de l'univers et couleur d'accent         | oui           | oui                 |
| Palette complète                                  | non           | oui                 |
| Variante de chaque scène, ordre des scènes        | non           | oui                 |
| Typographie, traitement photo, mouvement, forme   | non           | oui                 |

### Trois couches à ne jamais confondre

1. **La configuration sauvegardée** : tout ce que la professionnelle a réglé. Elle n'est jamais détruite par un changement de forfait.
2. **Les droits du forfait** : une lentille appliquée au rendu (`effective(config, plan, univers)`).
   - En Core, la lentille garde le contenu, une palette de l'univers (avec son accent) et la composition de l'univers.
   - En Signature, la lentille est transparente.
3. **Le rendu public** : la dernière version **publiée**, vue à travers la lentille du forfait **actuel**, puis à travers le filet de lisibilité (`ensureReadable`).

### Conséquences

- **Signature → Core :** les réglages Créatif restent en sommeil dans la configuration sauvegardée. Le studio le dit (« tes réglages Créatif sont conservés »).
  - Le **site public** passe immédiatement à une présentation Core : la lentille s'applique au rendu de la version publiée, sans la réécrire. Une formule résiliée n'est donc jamais rendue.
- **Core → Signature :** les réglages reviennent à l'identique, sans republier.
- **Ce qui reste figé :** une version publiée ne change jamais de contenu. Seuls les droits appliqués au rendu suivent le forfait en cours.

Testé :

- la lentille ne modifie jamais la configuration sauvegardée ;
- le retour en Signature restitue tout ;
- l'accent est conservé en Core, mais pas une palette libre.

## 4. Garde-fous : l'art est libre, la lisibilité ne l'est pas

Deux familles, traitées différemment (`engine/harmony.ts`).

### Conseils d'harmonie (non bloquants)

Chaque variante déclare les tokens pour lesquels elle a été conçue. Exemple : la Cinétique est pensée pour une grotesque.

Hors de cet accord, le studio explique et propose « Appliquer ». La professionnelle peut garder une composition expérimentale, y compris en ligne.

### Exigences de lisibilité (jamais publiées en défaut)

Elles portent sur le texte sur fond nuit, sur fond jour, et sur les boutons : 4,5:1 minimum.

- **Dans le brouillon :** le studio les signale en rouge, avec « Corriger ». L'expérimentation reste possible.
- **À la publication :** elles sont corrigées automatiquement. Le studio indique combien de corrections ont été appliquées.
- **Au rendu public :** le filet `ensureReadable` s'applique de toute façon. Une configuration enregistrée autrement ne peut pas produire un site illisible.
- **Ce que le filet laisse tranquille :** compositions, typographies, mouvement. Il ne touche que des couleurs.

### Autres garanties

- **Bouton de réservation rapide :** il garde l'accent de la marque sur blanc, sauf s'il devient illisible.
- **Nos palettes :** testées à 4,5:1 (le garde-fou a corrigé deux palettes d'Alma, à 3,2:1 et 2,9:1).

### Dans le produit

Le serveur appliquera la même règle à la publication. Le navigateur n'est pas une garantie.

## 5. Studio : pensé pour une professionnelle sur son téléphone

- **« Prestations » d'abord :** c'est le premier onglet, séparé des réglages artistiques par un filet. Il gère son activité, pas son style.
  - **Une liste par catégorie, dans son ordre.** Toucher une prestation l'ouvre ; toucher l'en-tête d'une catégorie ouvre la catégorie.
  - **Édition :** nom, description, prix tapé comme elle le dit (« 25 », « 12,50 »), durée en heures et minutes (sélecteurs natifs, des roues sur téléphone), réservable ou hors ligne, catégorie, position, options.
  - **Déplacer :** « Monter » et « Descendre », plus un choix de catégorie. C'est fiable au pouce dans une feuille qui défile, au clavier et au lecteur d'écran. Le glisser-déposer viendra en complément, jamais à la place.
  - **Retirer :** un geste, annulé par le toast « Annuler » ou par ↶. L'annulation est commune au design et au catalogue.
  - **Ce que le backend refuserait** est signalé à l'endroit concerné, et « Publier » devient « À compléter (n) ».
  - **L'aperçu suit :** une prestation modifiée vient se placer sous l'en-tête du site, entourée ; la toucher dans l'aperçu l'ouvre dans l'éditeur.
- **L'aperçu est l'éditeur :** en mode édition, toucher une photo du site l'ouvre dans l'éditeur de photo.
- **Point focal au doigt :**
  - la photo entière s'affiche, avec une cible à glisser et une grille des tiers ;
  - trois vignettes en direct (Portrait, Arche, Bandeau) montrent le recadrage dans les compositions ;
  - le réglage fonctionne aussi aux flèches du clavier.
- **Ses propres photos :** « Depuis mon téléphone ». Dans le labo, la photo reste en mémoire et rien n'est envoyé.
- **Annuler / rétablir :** un geste (glisser, taper un nom) compte comme un seul pas. Au clavier : ⌘Z et ⇧⌘Z.
- **Brouillon / En ligne :**
  - l'aperçu bascule entre ce qu'elle prépare et ce que voient ses clientes ;
  - un point signale les modifications non publiées ;
  - « Publier » fige une nouvelle version.
- **Mode Simple :** Univers, Photos, Textes, Couleurs.
  - Changer d'univers garde son nom, ses textes et ses photos. Le catalogue n'est pas concerné : il n'appartient à aucun univers.
  - **Couleurs → Bouton « Réserver » :** celle de l'univers, l'accent, l'encre, le blanc ou une couleur libre. Le texte est toujours calculé pour rester lisible, et un liseré apparaît si la couleur se confond avec le fond.
  - Un onglet « Créatif ✦ » présente ce que Signature ouvre, sans l'imposer.
- **Ergonomie :** feuille basse de 64 % de l'écran sur téléphone, cibles de 44 px. Un bandeau « mode édition » est toujours visible, et le studio ne recouvre jamais la réservation.

## 6. Persistance proposée (pour une PR backend future)

### Modèle

- **`sites`** : une ligne par établissement.
  - Champs : `business_id`, `universe`, `published_version_id`.
  - Lecture publique limitée à la version publiée.
- **`site_versions`** : versions de la configuration.
  - Champs : `id`, `site_id`, `schema_version`, `config` (JSONB), `status` (`draft` | `published` | `archived`), auteur et dates.
  - Une seule version `draft` par site, modifiable par les membres seulement (RLS). Les autres versions sont immuables.

### Brouillon et publication

- **Brouillon :**
  - le studio enregistre le brouillon automatiquement ;
  - un numéro de version optimiste refuse les écritures concurrentes (même patron que les fiches CRM).
- **Publication :**
  - publier copie le brouillon dans une nouvelle version `published` ;
  - `sites.published_version_id` est basculé dans la même transaction ;
  - le site public ne voit jamais un état intermédiaire.
- **Historique :**
  - les versions publiées forment l'historique ;
  - restaurer copie une version ancienne dans le brouillon, sans jamais réécrire l'historique.

### Changement de formule

Voir § 3 :

- **En base :** la configuration complète est conservée dans `site_versions`.
- **Les droits** du forfait courant s'appliquent au rendu, côté serveur, sur la version publiée.
- **Rien n'est réécrit** lors d'un changement de formule.
- **Le studio** montre les réglages en sommeil.

### Mises à jour de nos univers

- **Brouillon Core :** il stocke l'univers et les seuls réglages de la professionnelle. Nos améliorations d'un univers lui profitent donc.
- **Version publiée :** c'est toujours la configuration résolue complète, figée. Le site d'une professionnelle ne change jamais sans qu'elle publie.
- **Nouvelle version d'un univers :** le studio peut proposer « une nouvelle version de ton univers est disponible ».

### Validation côté serveur (jamais confiance au navigateur)

- **Schéma :** zod sur toute la `SiteConfig`, avec `schema_version` et des fonctions de migration pures d'une version à la suivante.
- **Registre :** variantes et tokens doivent exister dans le registre ; une variante inconnue est refusée.
- **Droits :** les droits du forfait sont vérifiés côté serveur. Un brouillon Core peut contenir des réglages Signature en sommeil, mais ils ne sont jamais rendus.
- **Textes :**
  - texte brut uniquement, aucun HTML ;
  - longueurs bornées ;
  - couleurs en `#rrggbb`.
- **Photos :** des identifiants d'assets de l'établissement, jamais des URL libres.
- **Ce que la configuration ne touche pas :** elle ne porte que la présentation. Prestations, prix, disponibilités et réservation viennent toujours du backend sécurisé existant.

### Photos

- **Envoi :** stockage par établissement.
- **Déclinaisons :** générées en AVIF et WebP (480, 828, 1200 px).
- **Point focal :** un point d'intérêt par photo, pour que chaque variante (portrait, arche, carte inclinée) recadre correctement des photos que la professionnelle n'a pas composées pour elle.

## 7. Performance (téléphone moyen, 4G)

- **Typographie :** ne charger que la paire de la professionnelle. Le labo déclare les neuf familles (le studio change d'univers en direct) mais n'en précharge aucune : une page ne télécharge que les fichiers qu'elle affiche, 6 ou 7 au lieu de 14.
- **Studio chargé à la demande :** tant que « Personnaliser » n'a pas été utilisé, la page n'affiche qu'un lanceur, en police système. Le code du Studio, ses éditeurs et sa police ne sont téléchargés qu'à la première ouverture ; le survol ou le focus du lanceur les préchauffe. Dans le produit, le Studio vivra dans le dashboard.
- **Ouvertures visibles sans attendre le JavaScript :** les entrées des ouvertures (cadre, photo, nom, ligne d'activité, sceau) sont des animations CSS (`scenes/opening.module.css`) : mêmes courbes, durées et délais que le langage de mouvement. Elles démarrent au premier affichage, et non après l'hydratation. Le parallaxe et les gestes restent pilotés par motion.
- **Photo d'ouverture :** chargée immédiatement. Les autres en différé, responsives.
- **Réservation :** elle n'attend jamais une animation.
- **Préférence d'accessibilité :** « réduire les animations » est respecté partout (`MotionConfig reducedMotion="user"`).
- **Budget :** LCP sous 2,5 s en 4G. Pas de bibliothèque 3D.
- **Mesuré** avec `tests/experience-lab/perf.mjs` : build de production, Chromium, 390 × 844 en DPR 1, cache vide, 1,6 Mbit/s, 150 ms de latence, processeur ×4, trois passes par page (médiane). Ce sont les conditions de l'audit indépendant. Ce sont des mesures CDP, pas un téléphone physique.

  | Univers  | LCP avant (`c494f82`) | LCP après | Élément LCP          |
  | -------- | --------------------- | --------- | -------------------- |
  | Mila     | 1,00 s                | 0,99 s    | le nom               |
  | Alma     | 3,14 s                | 1,70 s    | « Maison », 1er mot  |
  | Nail Lab | 2,83 s                | 1,09 s    | la photo d'ouverture |

  Premier affichage vers 1,0 s, CLS de 0,025 au plus. Par page : 29 Ko de polices et 15 Ko de JavaScript en moins (le Studio et sa police). Les images d'ouverture n'ont pas été dégradées.

- **Révélation « coupe » corrigée :** elle utilisait `clip-path`. Or Chromium considère hors du viewport un élément entièrement coupé par son propre `clip-path` : la révélation pouvait ne jamais démarrer, et le contenu de Mila restait invisible. Elle passe par un masque animé, au rendu identique.

## 7 bis. Retours de la première professionnelle (et ce qui en a été fait)

- **« Remplacer Sourcils par Mixte, ajuster durées et tarifs » :** pas de valeur remplacée en dur. Le catalogue entier est à elle (section 2 bis).
- **« Petites typographies trop robotiques » :** les capitales monospace font l'identité de Mila et de Nail Lab ; elles restent pour ce qui **indexe** (numéros, « Prix TTC », titres de catégorie, prix dans l'index). Tout ce qui **informe** (durées, notes d'options, intitulés de la réservation : « Jour », « Heure », « Prénom », étapes « changer ») passe dans la typographie de texte, en minuscules (`Note`). Les capitales passent de 11,5 px à 12 px, avec un interlettrage un peu plus serré.
- **« Contrôler la couleur du bouton Réserver » :** fait, en Core, avec la lisibilité garantie.
- **Réservation directe sans compte et photos personnelles :** inchangées. Ce sont les points qu'elle a le plus aimés.

## 7 ter. Partage

- **Studio → Partager :** son lien, « Copier le lien », le partage natif du téléphone et son QR code, à télécharger en PNG ou en SVG.
- **Le QR est dessiné dans le navigateur** (`share/qr.ts` : encodeur maison, sans dépendance) : rien n'est envoyé. Chaque version (1 à 10, ASCII et UTF-8) a été vérifiée une fois avec le lecteur QR du système (CoreImage). Un code de référence, relu ainsi, est figé dans les tests.
- **Les couleurs du QR** sont celles de son site seulement si elles se scannent bien (foncé sur clair, contraste d'au moins 7:1). Sinon, noir sur blanc.
- **Le lien partagé** est celui de la démo de l'univers affiché (avec son métier), jamais une clé d'accès présente dans l'URL.
- **Dans le labo, c'est une démonstration temporaire, et le panneau le dit :** le lien ouvre la démo avec son contenu de départ, les personnalisations de l'onglet ne sont pas transmises, et aucune réservation ni aucun email réels n'en découlent. La publication (« Publié dans cet onglet ») et la confirmation de réservation (« Simulation du laboratoire ») le disent aussi. Aucune persistance n'a été ajoutée : la vraie publication se conçoit avec le SaaS.

## 7 quater. Stabilisation (audit `c494f82`) et suites reproductibles

- **Suites versionnées** (`tests/experience-lab/`), à lancer contre un serveur du labo (`LAB_URL`), avec Chromium (`CHROMIUM`) et `playwright-core` (`PLAYWRIGHT`, sinon `node_modules`) :
  - `journeys.mjs` : un cas par constat de l'audit (I1 à I8, mineurs 1 à 4), en vraies interactions ;
  - `catalog.mjs` : catalogue, univers, publication, réservation avec option, trois métiers × trois univers, catalogue vidé, garde-fous, couleur du bouton ;
  - `scenes.mjs` : portrait, sections, partage, réservation modale ;
  - `a11y.mjs` : axe (WCAG 2.1 AA) sur 28 écrans, avec `AXE`, le chemin d'`axe.min.js` ;
  - `perf.mjs` : mesures ci-dessus.
- **Modales** (`engine/modal.tsx`) : la réservation et la galerie partagent un portail au-dessus de toutes les couches du Studio. Il porte les tokens et les polices de l'univers. Le reste de la page devient inerte, le défilement est verrouillé, le focus est confiné, Échap ferme, et le focus revient à l'élément d'origine.
- **Saisie invalide** : un montant tapé de travers (« -12 », vide, lettres, plus de 99 999,99 €) est gardé dans le brouillon comme invalide (NaN), jamais remplacé par l'ancienne valeur. Il bloque la publication en nommant la prestation et le champ, et la prestation n'est plus proposée dans l'aperçu. Le texte tapé est réaffiché tel quel.
- **Forfait** : le rendu « En ligne » applique le forfait courant à la version publiée (`online()` dans `plans.ts`). Ce qui a été publié n'est jamais réécrit : en repassant en Créatif, tout revient sans republier.
- **Lisibilité** : une liste unique de couples texte/fond rendus (`renderedTextPairs`), y compris le secondaire nuit et le secondaire jour (calculé, plus d'opacités sur le texte). Elle est vérifiée sur les palettes conçues et sur 400 palettes aléatoires.
- **Photos locales** : libérées dès que rien ne peut plus les afficher (brouillon, étapes annuler/rétablir, version publiée).

## 8. Prochaines étapes du laboratoire

- **Variantes à ajouter, une par une, soignées :** témoignages (explicitement fictifs dans le labo), avant/après au toucher.
- **Catalogue :** glisser-déposer en complément de « Monter / Descendre » ; options à choix multiples, si un métier en a besoin.
- **Vérification avec de vraies professionnelles** avant tout choix de prix.
