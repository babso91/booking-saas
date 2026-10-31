# Corrections transversales à traiter dans une PR dédiée

Issues du rapport final de Studio 2. Studio 2 reste READY : aucun de ces points n'est un défaut d'intégrité des données, et aucun n'est corrigé dans les PR #29 ou #30. Ils seront traités ensemble, une fois Studio 2 et Écrin stabilisés.

## 1. Accessibilité : nom du monogramme (WCAG 2.5.3)

**Cause.** Le bouton affiche les initiales (`AM`), alors que son `aria-label` vaut `Atelier Maëlys : réglages et compte`. Le texte visible n'est pas contenu dans le nom accessible. Une personne en commande vocale qui dit « cliquer AM » n'atteint pas le bouton. **Écrin a le même défaut**, puisque son monogramme reprend ce libellé.

**Pourquoi nos contrôles ne l'ont pas vu.** Notre appel à axe se limite aux étiquettes `wcag2a`, `wcag2aa` et `wcag21aa`. La règle `label-content-name-mismatch` n'en fait pas partie : axe la range parmi ses règles expérimentales. Le « 0 violation » d'axe ne couvre donc pas ce critère.

**Correction proposée.** Commencer le nom par le texte visible : `` `${initialsOf(name)}, ${name} : réglages et compte` ``. Le rendu ne change pas.

**Risque.** Faible. Le nom change pour les lecteurs d'écran, et les tests qui cherchent le bouton par son nom sont à adapter.

**Fichiers.** `src/features/dashboard/components/studio-shell.tsx:83`, `src/features/dashboard/ecrin/ecrin-shell.tsx:102`, et leurs tests.

**Tests.**

- Tests de composant : le nom accessible contient le texte visible, dans les deux coquilles.
- `tests/e2e/support/ecrin.ts` et les parcours Studio : activer explicitement cette règle axe. D'autres écrans peuvent alors remonter et seront à traiter dans la même PR.

## 2. Classique : année de `periodLabel` au Nouvel An

**Cause.** `periodLabel` (`src/features/agenda/client/dates.ts:87`) n'écrit que l'année de fin. La semaine du 28 décembre 2026 s'affiche donc `28 déc. – 3 janv. 2027`, ce qui laisse croire que le 28 décembre tombe en 2027.

**Correction proposée.** Écrire les deux années lorsqu'elles diffèrent : `28 déc. 2026 – 3 janv. 2027`. Le libellé reste le même dans tous les autres cas. Écrin le fait déjà dans son sous-titre.

**Risque.** Très faible : ce texte n'est utilisé que dans l'en-tête de `agenda-view.tsx:548`. Le libellé est plus long, donc à vérifier à 320 px.

**Fichiers.** `src/features/agenda/client/dates.ts`, `src/features/agenda/client/dates.test.ts`.

**Tests.**

- Semaine à cheval sur deux années : les deux années sont écrites.
- Semaine à cheval sur deux mois de la même année : une seule année.
- Vue jour : inchangée.
- À vérifier au passage : l'en-tête de Studio traite-t-il ce cas ?

## 3. Disponibilités : temps libre brut et temps réservable

**Ce qui est affiché aujourd'hui.** `freeMinutes` (`src/features/dashboard/agenda/day-flow.ts`) additionne tous les intervalles libres à venir, déjà nets des rendez-vous, de leurs tampons et des blocages. Il apparaît comme `Libre` ou `Libre, à venir` (`studio-day-summary.tsx:63`) et `X libres` (`ecrin-agenda.tsx:341`). Chaque intervalle d'au moins 5 min devient `Libre · X min` avec une action « nouveau rendez-vous » (`studio-day-flow.tsx:158`, `ecrin-thread.tsx:181`).

**Écart avec le serveur.** Un rendez-vous occupe sa durée **plus son propre tampon** (`ends_at + buffer_minutes_snapshot`, `20260927200100_scheduling_invariants.sql:111`). Une prestation de 60 min avec 15 min de tampon ne tient donc pas dans `Libre · 70 min`.

**Le libellé peut-il tromper ? Oui, modérément.**

- Le mot « Libre » est exact, mais le total ne dit rien de ce qu'on peut réserver : `30 min libres` peut être six morceaux de 5 min.
- L'action sur un intervalle court suggère qu'un rendez-vous y tient. Le refus n'arrive qu'à l'envoi du formulaire.
- **L'intégrité n'est pas en jeu** : le serveur refuse (`schedule_conflict`), sans double réservation. Le risque est une perte de temps, ou une promesse faite à une cliente avant de vérifier.

**Correction proposée.** Elle tient en trois gestes, sans dupliquer de règle de réservation côté interface :

1. Garder `freeMinutes` comme donnée brute et l'afficher comme `Temps libre`, jamais comme « disponible » ou « réservable ».
2. Remplacer l'action sur l'intervalle par « Proposer un rendez-vous ici », sans promesse de faisabilité.
3. Dans le formulaire, une fois la prestation choisie, annoncer si elle tient, tampon compris, à partir de la réponse du serveur. Si aucun appel existant ne répond à cette question pour un créneau donné, l'arbitrage (nouvel appel en lecture ou statu quo) revient à une décision produit.

**Risque.** Moyen. C'est le seul des trois points qui touche au formulaire partagé par les trois styles, et il peut demander un appel de plus par changement de prestation. Le relire avec le travail de disponibilités existant avant de commencer.

**Fichiers.** `studio-day-summary.tsx`, `studio-day-flow.tsx`, `ecrin-agenda.tsx`, `ecrin-thread.tsx`, le formulaire de rendez-vous de `features/agenda`, et leurs tests.

**Tests.**

- Intervalle de 70 min avec une prestation de 60 + 15 min : annoncée comme ne tenant pas, et refusée par le serveur (e2e).
- Même prestation dans 75 min : acceptée, à la minute près.
- Tampon précédent et changement d'heure : calcul identique à celui du serveur.
- Total composé de petits morceaux : libellé non trompeur, en Studio comme en Écrin.
