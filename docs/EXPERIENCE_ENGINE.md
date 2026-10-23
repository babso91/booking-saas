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

## 3. Core et Signature

Même moteur, mêmes univers, mêmes animations. La différence porte sur ce que le studio peut modifier (`plans.ts`).

| Possibilité                                     | Core | Signature |
| ----------------------------------------------- | ---- | --------- |
| Univers complets (Mila, Alma, Nail Lab…)        | oui  | oui       |
| Identité, textes, photos, prestations           | oui  | oui       |
| Palettes de l'univers et couleur d'accent       | oui  | oui       |
| Palette complète                                | non  | oui       |
| Variante de chaque scène, ordre des scènes      | non  | oui       |
| Typographie, traitement photo, mouvement, forme | non  | oui       |

Repasser en Core garde le contenu et les couleurs, et rend la composition d'origine de l'univers.

## 4. Garde-fous (`engine/harmony.ts`)

**Ils conseillent, sans jamais verrouiller.**

- **Harmonie artistique :** chaque variante déclare les tokens pour lesquels elle a été conçue. Exemple : la Cinétique est pensée pour une grotesque. Hors de cet accord, le studio explique pourquoi et propose « Appliquer », mais la professionnelle reste libre.
- **Lisibilité :** les contrastes sous 4,5:1 sont signalés comme un problème, avec un correctif en un tap. Ils concernent le texte sur fond nuit, le texte sur fond jour et le texte des boutons.
- **Bouton de réservation rapide :** il garde l'accent de la marque sur blanc, sauf s'il devient illisible.
- **Tests :**
  - toutes nos palettes passent 4,5:1 ;
  - nos univers d'origine ne déclenchent aucun conseil.

Le garde-fou a corrigé deux palettes d'Alma (boutons à 3,2:1 et 2,9:1).

## 5. Persistance proposée (pour une PR backend future)

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

- **La configuration complète est toujours conservée.**
- **Le forfait agit au rendu**, comme une lentille : `effective = plan === "core" ? toCore(config, univers) : config`.
- **Passer en Core :**
  - ne détruit rien ;
  - les réglages Signature restent en sommeil dans le brouillon ;
  - le studio l'indique (« conservés, ils reviendront si tu repasses en Signature ») ;
  - le site publié affiche la composition Core.
- **Repasser en Signature** les fait revenir à l'identique.

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

## 6. Performance (téléphone moyen, 4G)

- **Typographie :** ne charger que la paire de la professionnelle. Le labo charge les neuf familles, le produit non.
- **Photo d'ouverture :** chargée immédiatement. Les autres en différé, responsives.
- **Réservation :** elle n'attend jamais une animation.
- **Préférence d'accessibilité :** « réduire les animations » est respecté partout (`MotionConfig reducedMotion="user"`).
- **Budget :** LCP sous 2,5 s en 4G. Pas de bibliothèque 3D.

## 7. Prochaines étapes du laboratoire

- **Variantes à ajouter, une par une, soignées :** portrait de la professionnelle, témoignages, avant/après.
- **Point focal des photos** dans le studio.
- **Studio mobile :** prévisualisation du site publié par rapport au brouillon, et « annuler ».
- **Vérification avec de vraies professionnelles** avant tout choix de prix.
