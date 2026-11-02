# Corrections transversales

Issues du rapport final de Studio 2 et de l'audit d'Écrin. Elles sont traitées sur `fix/dashboard-consolidation`, PR Draft basée sur `feat/dashboard-ecrin`. Aucune règle métier, migration, RPC ou action serveur n'est modifiée.

## État

| Sujet                                 | État                                         |
| ------------------------------------- | -------------------------------------------- |
| 1. Noms accessibles (WCAG 2.5.3)      | Résolu                                       |
| 2. Focus du menu d'options            | Résolu, en Écrin et en Studio                |
| 3. Chevauchements                     | Résolu, en Écrin et en Studio                |
| 4. Année de `periodLabel`             | Résolu                                       |
| 5. Temps libre : les libellés         | Résolu                                       |
| 5 bis. Faisabilité dans le formulaire | Décision : pas de nouvel appel dans cette PR |

## 1. Noms accessibles

**Constat.** axe, avec la règle `label-content-name-mismatch` activée sur les aperçus Écrin et Studio (10 pages), a relevé 111 résultats.

| Élément                                            | Classement                                                                                 | Traitement |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| Monogramme `AM`                                    | Violation réelle                                                                           | Corrigé    |
| Perles et bande des jours (`26 LU`)                | Violation réelle                                                                           | Corrigé    |
| Têtes de jour de la semaine (`26 LUN 4 rdv`)       | Violation réelle                                                                           | Corrigé    |
| Rendez-vous de la semaine                          | Violation réelle : ordre différent, texte variable selon la largeur                        | Corrigé    |
| Rendez-vous du jour                                | Violation réelle : `dans 55 min`, `note`, `en ligne` absents du nom                        | Corrigé    |
| Lignes de temps libre                              | Violation réelle                                                                           | Corrigé    |
| Bouton `⋯` (résultat « incomplet », non violation) | Faux positif démontrable : un glyphe sans mot à prononcer, WCAG 2.5.3 ne vise que le texte | Conservé   |

**Correction.**

- **Monogramme** : texte fixe, donc `aria-label` exact, `AM, Atelier Maëlys : réglages et compte`.
- **Autres boutons et lignes de Clientes** : plus d'`aria-label`. Leur nom vient de leur contenu, complété par du texte réservé aux lecteurs d'écran. Il suit donc ce qui est réellement affiché, y compris quand une largeur montre les initiales ou le prénom. Le rendu visuel ne change pas.

Chromium calcule ces noms avec une espace devant la virgule du complément (`26 LU , lundi…`), car ce texte est positionné en absolu. C'est sans effet à l'écoute, mais c'est ce qui rendait le premier monogramme différent du nom attendu : le premier run CI l'a révélé.

**Résultat.** Sur les mêmes pages : 0 violation, 1 résultat « incomplet » (le `⋯`). La règle est activée dans `expectAccessible`, donc dans tous les e2e axe, sans désactiver aucune règle.

**Portée exacte de ce zéro.** Mesuré : la règle axe ne s'applique qu'aux éléments qui ont un `aria-label`. Un nom issu du contenu en sort. Ces éléments respectent le critère par construction, car leur nom contient leur texte ; ce n'est pas axe qui le prouve. Seul le monogramme reste contrôlé par axe, et son nom exact par un e2e.

**Clientes.** La ligne annonçait une phrase (`Zoé, pas encore venue`) sans le texte affiché (`Aucun contact`, colonnes). Son nom est maintenant son contenu, complété par ce que les colonnes disaient sans mot : `Dernière le`, `Prochain rendez-vous :`. Les initiales de l'avatar restent décoratives (`aria-hidden`) : le prénom suffit à la nommer.

Les cartes du Classique (`time-grid.tsx`) reçoivent la même correction. Elles n'étaient pas visibles sur les aperçus : seule la CI les contrôle.

**Fidélité (MINOR de l'audit Codex).** Le bouton d'une récompense émise s'appelle `Marquer comme utilisée « Remise 5 € »` : le texte visible reste une séquence continue et le nom de la récompense reste dynamique. Un test de composant le contrôle pour trois noms, dont un long. Aucun e2e n'ouvre cet écran avec axe.

## 2. Focus du menu d'options

`useOptionsMenu` (`features/dashboard/agenda/use-options-menu.ts`) remplace le code dupliqué d'Écrin et de Studio, qui avaient le même défaut.

| Chemin de fermeture                       | Destination du focus                                |
| ----------------------------------------- | --------------------------------------------------- |
| Échap                                     | Le bouton d'options                                 |
| Échap alors qu'elle a déjà quitté le menu | Inchangé                                            |
| Clic sur un élément focalisable           | Cet élément                                         |
| Clic sur un élément non focalisable       | Le bouton d'options                                 |
| Défilement tactile (`pointercancel`)      | Inchangé : elle faisait défiler la page             |
| « Afficher les annulés »                  | Reste sur la case, le menu reste ouvert             |
| « Bloquer un créneau »                    | Le panneau, puis le bouton à sa fermeture           |
| Le bouton disparaît (écran élargi)        | Le titre de la page, si le focus était dans le menu |
| « Aujourd’hui » disparaît sur téléphone   | Le titre de la page                                 |

Le titre porte `tabIndex={-1}` : il reste hors de l'ordre de tabulation.

**Geste en cours (MINOR de l'audit Codex).** Une pression extérieure ferme le menu, puis attend sa fin. Ses écouteurs temporaires partagent un `AbortController`. Ils sont retirés au `click`, au `pointercancel`, à la pression suivante si la précédente n'a jamais fini, et au démontage. Seul le `click` peut rendre le focus. Si le focus était sur une option au moment d'un défilement, il retombe donc sur la page : c'est le comportement demandé, aucun bouton ne le récupère.

## 3. Chevauchements

« En même temps · N » devient `N rendez-vous qui se chevauchent`, exact pour une chaîne, sans nouvel algorithme de simultanéité. `overlappingVisits` compte les rendez-vous non annulés qui en chevauchent réellement un autre : une annulation ne déclenche plus le libellé et ne relie plus deux rendez-vous. La présentation des groupes ne change pas.

## 4. Année de `periodLabel`

`28 déc. 2026 – 3 janv. 2027` lorsque la semaine traverse deux années ; inchangé sinon. Studio et Écrin écrivaient déjà les deux années.

## 5. Temps libre

**Libellés.** `Libre · 70 min` devient `Temps libre · 70 min`. L'action devient « proposer un rendez-vous ici » pour les lecteurs d'écran. Le total devient `1 h 40 de temps libre, en 3 plages` (Écrin) et `Temps libre · 3 plages` (Studio). Le champ `bookable` de `dayFlow`, qui voulait dire « à venir », devient `ahead`.

**Inventaire sans changement.**

- « Journée libre » et « Ta journée est libre » disent qu'il n'y a pas de rendez-vous, sans promettre de durée.
- « Indisponible » désigne un blocage posé par la professionnelle.
- `bookableMinutes` sert seulement à calculer un taux de remplissage. Le nom est imprécis, mais il n'est pas affiché.

**Serveur.** `schedule_conflict` et le message de refus ne changent pas. Un e2e prouve la frontière : prestation de 60 min, tampon de 15 min, refusée à 10:50 et acceptée à 10:45, avant un rendez-vous à 12:00.

**Le tampon n'appartient pas à la prestation.** C'est un réglage de l'établissement (`business_settings.buffer_minutes`), figé sur chaque rendez-vous à sa création. Notre premier constat parlait à tort du tampon « de la prestation », et la première fixture visait une colonne qui n'existe pas.

### 5 bis. Faisabilité dans le formulaire : décision prise

Annoncer dans le formulaire si une prestation tient, tampon compris, avant l'envoi.

**Existant.** Le formulaire de l'agenda n'interroge aucune disponibilité. Les disponibilités publiques suivent des règles propres à la réservation en ligne (préavis, horizon) et ne répondent donc pas à la question d'une professionnelle qui place elle-même un rendez-vous. Le seul verdict exact pour elle est aujourd'hui le refus à l'envoi.

**Décision de la direction produit.** Pas de nouvel appel serveur dans cette PR. Les libellés restent exacts et la validation finale reste côté serveur. Le sujet sera réévalué avec les professionnelles pilotes. Ne jamais recalculer cette règle dans le navigateur.

## Preuve que les tests détectent les défauts

Les tests ont été écrits après les correctifs. Chaque ancien comportement a donc été remis, un à la fois, puis retiré.

| Ancien comportement remis                   | Détecté par                                                   |
| ------------------------------------------- | ------------------------------------------------------------- |
| Anciens agendas Écrin (`cd3eb8d`)           | Chromium : focus sur `BODY` après Échap, le défaut de l'audit |
| Échap sans retour du focus                  | Chromium, Écrin et Studio : `BODY`                            |
| Échap qui ramène toujours le focus          | Chromium, Écrin et Studio : focus volé après tabulation       |
| Clic extérieur sans restauration            | Chromium, Écrin et Studio : `BODY`                            |
| Clic extérieur qui ramène toujours le focus | Chromium, Écrin et Studio : focus volé                        |
| Option sans déplacement préalable du focus  | Chromium, Écrin et Studio : `BODY`                            |
| Élargissement sans destination              | Chromium, Écrin et Studio : `BODY`                            |
| « Aujourd’hui » sans destination (Écrin)    | Chromium : `BODY`                                             |
| Ancien nom du monogramme, Studio puis Écrin | Composants : 6 échecs chacun                                  |
| Ancienne année de `periodLabel`             | Unitaire : 1 échec                                            |
| Taille du groupe au lieu des chevauchements | Unitaires : 3 échecs                                          |
| Frontière comptée comme chevauchement       | Unitaire : 1 échec                                            |
| Plages non comptées                         | Unitaire : 1 échec                                            |
| « Libre » remis (Écrin)                     | Composants : 2 échecs                                         |

Le geste en cours et le bouton de récompense ont été reproduits avant correction, puis leurs anciens comportements remis un à un :

| Reproduction ou ancien comportement remis     | Détecté par                                                   |
| --------------------------------------------- | ------------------------------------------------------------- |
| Hook audité, défilement tactile réel          | Chromium, Écrin et Studio : focus repris par le bouton        |
| Hook audité, écouteurs                        | Composants : 8 échecs (4 tests, avec et sans Strict Mode)     |
| Pas d'arrêt au démontage                      | Composants : 4 échecs                                         |
| `pointercancel` non écouté                    | Composants : 4 échecs                                         |
| `pointercancel` qui rend le focus             | Composants : 2 échecs                                         |
| La pression suivante n'arrête pas la première | Composants : 2 échecs                                         |
| Le `click` n'arrête pas le suivi              | Composants : 6 échecs                                         |
| Le `click` ne rend jamais le focus            | Composants : 2 échecs                                         |
| Le `click` rend toujours le focus             | Composants : 2 échecs                                         |
| Ancien nom de la récompense                   | Composants : 4 échecs ; règle axe dans Chromium : 1 violation |

Ces contrôles de focus tournent à 390 px sur les aperçus. Avec vraie session, les mêmes scénarios sont dans `tests/e2e/consolidation-browser.test.ts`. La fixture du tampon prouve sa frontière par construction : sans le réglage, 10:50 serait acceptée et le test échouerait.

## Limites

- Les parcours avec backend ne tournent qu'en CI. En local, les scénarios de focus et l'inventaire axe tournent sur les aperçus Chromium.
- L'audition réelle avec une commande vocale n'a pas été réalisée : la correspondance est vérifiée par le nom accessible et par axe.
- Le nom d'un rendez-vous répète volontairement une partie du texte visible (`Amel 09:30, 09:30, Amel Kaci…`), pour conserver le nom complet quand seul le prénom est affiché. C'est un peu plus long à l'écoute.
- Le bouton « Copier » annonce `Copier l’email` tandis que son texte devient brièvement `Copié`, et les récompenses affichent brièvement `Un instant…`.
- Le test du défilement tactile avec vraie session n'a pas pu tourner en local, seul son équivalent sur les aperçus (390 px, Chromium, CDP). Safari sur iPhone n'a pas été essayé : son enchaînement réel d'événements reste à observer.
- Une pression qui finit sans `click` ni `pointercancel` (souris relâchée hors de la fenêtre) garde ses écouteurs jusqu'à la pression suivante ou au démontage. Ils ne peuvent rendre le focus que s'il est perdu.
