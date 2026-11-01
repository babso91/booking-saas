# Corrections transversales

Issues du rapport final de Studio 2 et de l'audit d'Écrin. Elles sont traitées sur `fix/dashboard-consolidation`, PR Draft basée sur `feat/dashboard-ecrin`. Aucune règle métier, migration, RPC ou action serveur n'est modifiée.

## État

| Sujet                                 | État                                     |
| ------------------------------------- | ---------------------------------------- |
| 1. Noms accessibles (WCAG 2.5.3)      | Résolu                                   |
| 2. Focus du menu d'options            | Résolu, en Écrin et en Studio            |
| 3. Chevauchements                     | Résolu, en Écrin et en Studio            |
| 4. Année de `periodLabel`             | Résolu                                   |
| 5. Temps libre : les libellés         | Résolu                                   |
| 5 bis. Faisabilité dans le formulaire | **À traiter : décision produit requise** |

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

**Correction.** Ces boutons n'ont plus d'`aria-label`. Leur nom vient de leur contenu, complété par du texte réservé aux lecteurs d'écran : `AM, Atelier Maëlys : réglages et compte`. Le nom suit donc ce qui est réellement affiché, y compris quand une requête de conteneur montre les initiales ou le prénom. Le rendu visuel ne change pas.

**Résultat.** Sur les mêmes pages : 0 violation, 1 résultat « incomplet » (le `⋯`). La règle est activée dans `expectAccessible`, donc dans tous les e2e axe, sans désactiver aucune règle.

Les cartes du Classique (`time-grid.tsx`) reçoivent la même correction. Elles n'étaient pas visibles sur les aperçus : seule la CI les contrôle.

## 2. Focus du menu d'options

`useOptionsMenu` (`features/dashboard/agenda/use-options-menu.ts`) remplace le code dupliqué d'Écrin et de Studio, qui avaient le même défaut.

| Chemin de fermeture                       | Destination du focus                                |
| ----------------------------------------- | --------------------------------------------------- |
| Échap                                     | Le bouton d'options                                 |
| Échap alors qu'elle a déjà quitté le menu | Inchangé                                            |
| Clic sur un élément focalisable           | Cet élément                                         |
| Clic sur un élément non focalisable       | Le bouton d'options                                 |
| « Afficher les annulés »                  | Reste sur la case, le menu reste ouvert             |
| « Bloquer un créneau »                    | Le panneau, puis le bouton à sa fermeture           |
| Le bouton disparaît (écran élargi)        | Le titre de la page, si le focus était dans le menu |
| « Aujourd’hui » disparaît sur téléphone   | Le titre de la page                                 |

Le titre porte `tabIndex={-1}` : il reste hors de l'ordre de tabulation.

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

**Serveur.** `schedule_conflict` et le message de refus ne changent pas. Un e2e prouve la frontière : prestation de 60 + 15 min refusée à 10:50 et acceptée à 10:45, avant un rendez-vous à 12:00.

### 5 bis. Faisabilité dans le formulaire : décision requise

Annoncer dans le formulaire si une prestation tient, tampon compris, avant l'envoi.

**Existant.** Le formulaire de l'agenda n'interroge aucune disponibilité. Les disponibilités publiques suivent des règles propres à la réservation en ligne (préavis, horizon) et ne répondent donc pas à la question d'une professionnelle qui place elle-même un rendez-vous. Le seul verdict exact pour elle est aujourd'hui le refus à l'envoi.

**Recommandation.** Garder le comportement actuel pour l'instant : le refus est exact, le texte protège le brouillon et les libellés ne promettent plus rien. Si des professionnelles s'en plaignent, ajouter un appel serveur en lecture dédié, qui réutilise la contrainte existante. Cela demande une validation produit et une PR à part. Ne jamais recalculer cette règle dans le navigateur.

## Limites

- Les parcours avec backend ne tournent qu'en CI. En local, les scénarios de focus et l'inventaire axe tournent sur les aperçus Chromium.
- L'audition réelle avec une commande vocale n'a pas été réalisée : la correspondance est vérifiée par le nom accessible et par axe.
- Le nom d'un rendez-vous répète volontairement une partie du texte visible (`Amel 09:30, 09:30, Amel Kaci…`), pour conserver le nom complet quand seul le prénom est affiché. C'est un peu plus long à l'écoute.
