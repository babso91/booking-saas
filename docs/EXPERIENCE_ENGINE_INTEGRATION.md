# Experience Engine : intégration au SaaS

Le laboratoire (`proto/experience-engine`, `docs/EXPERIENCE_ENGINE.md` sur cette branche) devient le produit. On réutilise ses univers (Mila, Alma, Nail Lab), ses scènes et son studio Simple / Créatif ; on ne les reconstruit pas. Le catalogue est celui de `main` (`docs/CATALOG_CONTRACT.md`) : une donnée métier, une seule source de vérité, enregistrée dès qu'elle est validée. Seul le design du mini-site aura un brouillon et une publication.

## Découpage

De petites PR, chacune auditable seule, dans cet ordre. L'ordre suit le § 10 du contrat : **aucun éditeur d'options n'est montré aux professionnelles avant que la réservation publique sache les réserver.** Sinon, une option obligatoire rendrait sa prestation impossible à réserver en ligne.

| PR                                              | Contenu                                                                                                                                                                                                                                                                                                                                       | Pourquoi à ce rang                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Le catalogue dans Prestations** (ce jalon) | Lecture unique (`getCatalogAction`). Catégories : créer, renommer, masquer en ligne, réordonner, supprimer explicitement. Catégorie d'une prestation. Projection publique pure, prouvée identique au serveur : le point de raccordement du labo.                                                                                              | Sans risque pour la réservation : une catégorie masquée ne fait que retirer des prestations en ligne, et le parcours public actuel le respecte déjà. |
| 2. Réservation publique avec options            | `/b/[slug]` lit `catalog`. Groupes affichés, première réponse préselectionnée pour un groupe obligatoire. Créneaux relus à chaque réponse ; `quote` du serveur affiché. `optionChoiceIds` et `expected*` envoyés ; `options_required`, `option_choice_unavailable` et `quote_changed` traités. Un e2e réel va de la page publique à l'agenda. | Conditions 1 à 5 du § 10.                                                                                                                            |
| 3. Éditeur d'options dans Prestations           | Questions, réponses, suppléments, durées, obligatoire / facultatif. Suppressions explicites (`deletedOptionIds`, `deletedChoiceIds`). `options_incomplete` et `stale_service` traités sans perte de saisie.                                                                                                                                   | Seulement après la PR 2.                                                                                                                             |
| 4. L'agenda avec options                        | Réponses à la création et à la modification (`optionChoiceIds`). L'instantané est affiché dans la fiche et dans Carnet.                                                                                                                                                                                                                       | Réutilise l'éditeur et la règle de prix du serveur.                                                                                                  |
| 5. Les univers du labo sur le vrai catalogue    | Moteur, scènes et univers importés tels quels. Ils ne reçoivent que la projection publique (`PublicCatalog`), en lecture. Aucune persistance de design.                                                                                                                                                                                       | Le catalogue est déjà la seule source.                                                                                                               |
| 6+. Design du mini-site                         | `sites` / `site_versions` (brouillon, publication, forfait appliqué au rendu ; contrat backend à valider avec Cloud), puis le studio Simple / Créatif dans le dashboard.                                                                                                                                                                      | Le seul brouillon du produit.                                                                                                                        |

## PR 1 : ce qui est livré

- **Une lecture, une vérité.** L'écran Prestations lit tout le catalogue en un document (`getCatalogAction`), comme le contrat le demande. L'ancienne lecture `listServicesAction` n'y sert plus. Les écritures restent celles du serveur : rien n'est appliqué avant sa réponse.
- **Ses catégories, aucune imposée.**
  - Créer : idempotent par `requestId`. Une réponse perdue est renvoyée avec le même identifiant ; `idempotency_conflict` et `category_deleted` sont expliqués, avec un choix.
  - Renommer, afficher ou masquer en ligne : seulement ce qui change, sur la version lue. `stale_category` lit la version actuelle, la montre champ par champ et n'envoie rien avant son choix (« Garder ma saisie », « Reprendre la version actuelle »). `category_not_found` est dit.
  - Réordonner : toutes, une fois (`reorderCategoriesAction`). Une liste changée ailleurs est relue.
  - Supprimer : explicite, jamais par omission. Elle sait avant combien de prestations restent, sans catégorie, avec leurs prix et leurs rendez-vous. Une suppression déjà faite ailleurs vaut succès.
- **Ses prestations rangées.** Une section par catégorie, dans son ordre, même vide ou masquée ; puis « Sans catégorie ». Sans aucune catégorie, la liste est exactement celle d'avant.
  - La catégorie se choisit dans le formulaire. Elle est préselectionnée quand la prestation est ajoutée depuis une catégorie.
  - Elle entre dans la comparaison des versions (`stale_service`) et elle est dite par son nom. Un brouillon gardé d'avant les catégories conserve celle de la prestation.
  - Monter et descendre restent à l'intérieur de la section, et la liste complète est envoyée (`reorderServicesAction`).
- **Options : lues, pas éditées.** Une prestation qui en a dit combien (« · 2 options »). Leur éditeur arrive en PR 3 (§ 10).
- **Raccordement au labo.** `showcase()` (`src/features/catalog/client/catalog-view.ts`) calcule depuis la lecture de la professionnelle exactement ce que voient ses clientes (`get_public_catalog`), sous la forme que le labo donnait à ses scènes. C'est prouvé sur PostgreSQL (`tests/integration/catalog-showcase.test.ts`). L'aperçu du studio et les univers liront cette projection, jamais une copie du catalogue.
- **Styles préservés.** L'écran garde ses composants partagés : Classique, Studio, Écrin et Carnet l'habillent comme avant.

## Vérifications

- Composants (`services-manager.test.tsx`) :
  - les tests existants inchangés dans leurs exigences (versions, brouillons, identité) ;
  - 12 nouveaux sur les catégories (sections, création idempotente, masquage, `stale_category`, suppression explicite ou déjà faite, ordre, déplacement dans une section, préselection, catégorie supprimée entre-temps, options non éditées).
- Modèle (`catalog-view.test.ts`, `service-form.test.ts`).
- PostgreSQL (`catalog-showcase.test.ts`) : projection identique au serveur. Elle couvre catégories masquées, vides ou seulement inactives, son ordre, des options, l'absence de catégorie et le catalogue vide.
- e2e réel (`catalog-browser.test.ts`) à 1280, 390 et 320 px, en Classique, Carnet et Studio sombre. Il crée une catégorie, y range une prestation, la masque, puis la supprime ; chaque étape est relue en base et dans l'API publique. Il vérifie aussi axe, l'absence de défilement horizontal et les captures.

## Limites de la PR 1

- Pas d'éditeur d'options, volontairement (§ 10).
- Le transfert pro-config ignore toujours catégories et options (§ 11 du contrat).
- L'aperçu du mini-site dans le studio n'existe pas encore : `showcase()` est prête, son écran arrive avec la PR 5.

## PR 2 : réservation publique avec options

Empilée sur la PR 1. Même moteur de réservation (`useBookingFlow`, routes publiques de `main`), étendu, jamais remplacé.

- **Le catalogue réel.** `/b/[slug]` lit `get_public_catalog` : ses catégories visibles dans son ordre, puis les prestations sans catégorie, sans titre. Une prestation dont des options peuvent augmenter le prix ou la durée affiche « dès » (ses réponses obligatoires les moins chères). C'est un affichage de liste ; le prix réservé est toujours celui du serveur.
- **Étape « Options »**, seulement pour une prestation qui en a (5 étapes au lieu de 4).
  - Groupe obligatoire : sa première réponse est préselectionnée par l'interface. Le serveur n'en choisit jamais une.
  - Groupe facultatif : il part de « Sans ».
  - Chaque réponse affiche ce qu'elle ajoute (« +15,00 € · +30 min », ou « Inclus »).
- **Le devis du serveur, à chaque réponse.** Chaque changement relit les créneaux et le devis en une seule lecture (`get_public_availability`). Prix et durée affichés sont ceux du `quote`, jamais une somme faite dans le navigateur. Les tests le prouvent avec un serveur simulé qui renvoie volontairement autre chose que la somme locale.
- **La réservation envoie** `optionChoiceIds`, `expectedPriceCents` et `expectedDurationMinutes` (le devis du créneau choisi).
  - Sans options, le corps est exactement celui d'avant : même empreinte d'idempotence.
  - Une réservation non confirmée garde ses réponses et se renvoie à l'identique.
- **Refus traités, rien n'est réservé dans aucun de ces cas :**

  | Code                                            | Ce qui se passe                                                                                                                                                                                               |
  | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `options_required`, `option_choice_unavailable` | Le catalogue est relu et ses réponses encore valides sont gardées. Elle revient aux options, avec « Les options ont changé ».                                                                                 |
  | `quote_changed`                                 | Le devis est relu pour le même jour et les mêmes réponses. Si le même créneau existe encore, le récapitulatif montre le nouveau prix avant qu'elle confirme à nouveau ; sinon, elle choisit un autre créneau. |
  | `slot_unavailable`                              | Inchangé : retour aux créneaux du jour, relus, ses réponses gardées.                                                                                                                                          |

- **Récapitulatif et confirmation** : ses réponses, telles que le serveur les a tarifées puis enregistrées (`options`).

Les conditions 1 à 5 du § 10 de `CATALOG_CONTRACT.md` sont remplies. L'éditeur d'options (PR 3) peut suivre.

### Vérifications de la PR 2

- Composants (`public-booking.test.tsx`) : les tests existants inchangés dans leurs exigences, plus 8 nouveaux. Ils couvrent catégories et « dès », préselection, devis du serveur, relecture à chaque réponse, corps envoyé, `quote_changed`, `option_choice_unavailable`, `options_required`, et le corps inchangé sans options.
- e2e réel (`booking-options-browser.test.ts`) à 390, 320 et 1280 px :
  - réservation d'une prestation à option obligatoire et facultative ;
  - en base : prix 85 €, durée 120 min, créneau de 120 min, réponses gardées ;
  - le rendez-vous s'ouvre dans l'agenda de la professionnelle avec ses totaux ;
  - axe, pas de défilement horizontal, captures.
