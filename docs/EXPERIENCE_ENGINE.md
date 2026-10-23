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

- **Contenu :** identité, photos, prestations.
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
| Prestations  | Index de prix · Étagère · Tuiles    |

**Principe :**

- Les variantes sont des compositions dessinées à la main (`scenes/*`), pas des blocs génériques.
- Le moteur les compose et leur fournit tokens, contenu et actions (réserver).
- Le langage de mouvement change la façon dont chaque variante se révèle (coupe, respiration, impulsion), sans toucher à sa composition.

Le moteur s'adapte à l'ambition artistique, pas l'inverse. Ajouter un univers, c'est de la configuration. Ajouter une façon de raconter, c'est une nouvelle variante, réutilisable par toutes.

**Univers :**

- **Mila et Alma** sont des configurations.
- **Nail Lab n'a aucun code propre.** Ses variantes nouvelles (Cinétique, Pellicule, Tuiles) enrichissent la bibliothèque commune.

## 3. Core (« Simple ») et Signature (« Créatif ») : un seul éditeur

Même moteur, mêmes univers, mêmes animations, et le même studio en deux modes. Ce qui change, c'est ce que le studio peut modifier (`plans.ts`).

| Possibilité                                       | Simple (Core) | Créatif (Signature) |
| ------------------------------------------------- | ------------- | ------------------- |
| Univers complets, changer d'univers               | oui           | oui                 |
| Photos (point focal compris), textes, prestations | oui           | oui                 |
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
  - Changer d'univers garde son nom, ses textes, ses photos et ses prestations.
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

- **Typographie :** ne charger que la paire de la professionnelle. Le labo charge les neuf familles, le produit non.
- **Photo d'ouverture :** chargée immédiatement. Les autres en différé, responsives.
- **Réservation :** elle n'attend jamais une animation.
- **Préférence d'accessibilité :** « réduire les animations » est respecté partout (`MotionConfig reducedMotion="user"`).
- **Budget :** LCP sous 2,5 s en 4G. Pas de bibliothèque 3D.

## 8. Prochaines étapes du laboratoire

- **Variantes à ajouter, une par une, soignées :** portrait de la professionnelle, témoignages, avant/après.
- **Point focal des photos** dans le studio.
- **Studio mobile :** prévisualisation du site publié par rapport au brouillon, et « annuler ».
- **Vérification avec de vraies professionnelles** avant tout choix de prix.
