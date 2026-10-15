# Configuration de l'activité : prestations et horaires (PR #20)

Une professionnelle nouvellement inscrite configure seule ses prestations et ses horaires. Ces réglages sont enregistrés dans Supabase et utilisés par le moteur existant (agenda, disponibilités). Les garanties d'écriture (création idempotente, versions, semaine attendue) viennent du backend : voir [`SETUP_WRITE_GUARANTEES_HANDOFF.md`](SETUP_WRITE_GUARANTEES_HANDOFF.md).

## Écrans

| Route                 | Composant             | Contenu                                                                                                         |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/app/services`       | `ServicesManager`     | Liste, création, modification, activation et désactivation, ordre, suppression d'une prestation jamais réservée |
| `/app/settings/hours` | `BusinessHoursEditor` | Horaires hebdomadaires : jours ouverts ou fermés, plusieurs plages par jour                                     |
| `/app/welcome`        | `OnboardingSuccess`   | « Mise en route » : prestations, puis horaires, puis rendez-vous                                                |
| `/app`                | `SetupChecklist`      | Bandeau compact au-dessus de l'agenda, tant que les prestations ou les horaires manquent                        |

**Navigation :**

- sur ordinateur, la barre latérale affiche « Prestations » et « Horaires » ;
- sur téléphone, « Prestations » prend la place de « Fidélité » (qui était « Bientôt ») dans la barre d'onglets, et « Horaires » se trouve dans la feuille « Compte ».

Ces pages restent accessibles à tout moment, pas seulement après l'inscription.

## Contrats utilisés

- **Prestations :** `listServicesAction`, `createServiceAction` (avec `requestId`), `updateServiceAction` (seuls les champs modifiés, avec `expectedVersion`), `setServiceActiveAction` (par valeur, sans version), `reorderServicesAction` (la liste complète, comme l'exige `reorder_services`), `deleteServiceAction` (`in_use` si la prestation a été réservée : l'écran propose alors de la désactiver).
- **Horaires :** `listBusinessHoursAction` et `replaceBusinessHoursAction`, qui remplace la semaine entière de façon atomique (`replace_business_hours`), seulement si elle est encore la semaine `expected`. L'écran envoie toujours la semaine complète, reconstruite depuis la lecture ; un jour fermé n'a aucune plage.
- **Devise :** `getBookingSettingsAction`.
- **Fuseau :** celui de l'activité, lu dans la session (`business.timezone`). Les heures sont des heures murales `HH:MM`, comparées en minutes, sans `Date` ni fuseau du navigateur.
- **Progression :** `getSetupProgress` (nouvelle fonction de lecture, `src/features/businesses/data/setup-progress.ts`) compte les prestations actives et les plages horaires, sous RLS.
- **Agenda :** `listAgendaServices` lit les prestations actives dans l'ordre configuré. Les plages d'ouverture de l'agenda viennent de `business_time`, à partir des mêmes `business_hours`. Il n'existe aucun second modèle d'horaires.

## Sûreté des écritures

Ce sont les mêmes règles que pour la PR #19.

- **Pendant un enregistrement :**
  - champs en lecture seule et gestionnaires de saisie ignorés (une frappe tardive ne change pas ce qui est envoyé) ;
  - fenêtre impossible à fermer ;
  - aucun double envoi.
- **Succès :** affiché seulement après confirmation du serveur.
- **Échec :** brouillon exact conservé et déverrouillé, avec un nouvel essai.
- **Brouillons :** conservés par prestation tant que la page reste ouverte, avec « Garder pour plus tard » et « Abandonner mes modifications » sur une ligne à part.
- **Création d'une prestation :** un `requestId` par création.
  - Après une réponse perdue (« Création non confirmée »), renvoyer les mêmes valeurs réutilise le même `requestId` : le backend renvoie la prestation déjà créée, jamais une seconde.
  - La création en cours (saisie, `requestId`, réponse perdue) est gardée pour la session, par activité : fermer le formulaire ou quitter la page ne l'oublie pas. La liste l'indique (« Une création n'a pas été confirmée », « Reprendre la création »).
  - Des valeurs modifiées, ou une nouvelle création volontaire, ont un nouveau `requestId` ; l'écran le dit si une création non confirmée est en cours.
  - `idempotency_conflict` : rien n'est renvoyé automatiquement. Choix explicite : « La créer comme nouvelle prestation » (nouveau `requestId`) ou « Abandonner ».
  - `service_deleted` : jamais recréée implicitement ; la liste est relue et l'écran le dit.
- **Modification d'une prestation :** envoyée avec la version lue (`expectedVersion`). En cas de `stale_service`, la version actuelle est relue et comparée champ par champ, la saisie est conservée et rien n'est envoyé avant un choix :
  - « Garder mes modifications » / « Garder ma saisie » : les champs modifiés par la professionnelle sont gardés, les autres prennent la valeur actuelle, et seuls ses champs sont envoyés, sur la nouvelle version ;
  - « Reprendre la version actuelle ».
  - Un brouillon gardé puis rouvert sur une prestation changée entre-temps est comparé de la même façon.
- **Activation :** par valeur, sans version. Le bouton envoie l'état inverse de celui affiché : une vue périmée ne peut produire qu'une écriture sans effet, et la réponse remplace la ligne (version comprise). L'ordre ne change pas la version.
- **Horaires :** envoyés avec la semaine de départ du brouillon (`expected`), sans relecture préalable. En cas de `stale_business_hours`, la semaine actuelle est lue et affichée, le brouillon est conservé et rien n'est remplacé sans un choix : « Remplacer par mes horaires » (envoyé contre la semaine affichée ; refusé et comparé à nouveau si elle change encore), « Reprendre les horaires actuels » ou « Continuer à modifier ».
- **Horaires non enregistrés : jamais perdus en silence.**
  - Un lien interne (barre latérale, barre d'onglets, feuille « Compte »…) ouvre une demande : « Enregistrer et continuer » (la navigation n'a lieu qu'après confirmation de l'enregistrement), « Quitter sans enregistrer » ou « Continuer à modifier ». Seuls les clics simples vers une autre page de l'application sont retenus, et seulement tant qu'il y a des modifications.
  - Fermer ou recharger l'onglet demande une confirmation au navigateur (`beforeunload`).
  - Une autre sortie (bouton Précédent) garde la semaine non enregistrée pour la session. Elle est proposée au retour (« Brouillon non enregistré restauré »), seulement si les horaires enregistrés n'ont pas changé depuis. Sinon, l'écran le dit et ne restaure rien.

## Ce qui n'est pas promis

La réservation en ligne par les clientes n'existe pas encore (`/b/[slug]` est une page de fondation). Les invitations à « partager ton lien » ont donc été retirées :

- de l'écran de bienvenue ;
- de l'agenda vide ;
- de l'annuaire vide ;
- de la barre latérale, où l'adresse est affichée avec la mention « Bientôt », sans lien.

## Limites connues

Les garanties d'écriture sont fournies par le backend (migration `20261016090000_setup_write_guarantees.sql`). Elles sont testées contre PostgreSQL réel dans `tests/integration/professional-setup-concurrency.test.ts`. Contrat et passation UI : [`SETUP_WRITE_GUARANTEES_HANDOFF.md`](SETUP_WRITE_GUARANTEES_HANDOFF.md).

- **Création de prestation idempotente :** un nouvel essai avec le même `requestId` ne crée jamais de seconde prestation.
- **Prestations versionnées :** une modification fondée sur une lecture périmée est refusée (`stale_service`), jamais appliquée sans le dire.
- **Horaires comparés à la semaine lue :** un enregistrement fondé sur une semaine périmée est refusé (`stale_business_hours`), de façon atomique.
- **Interface :** branchée sur ces garanties (voir « Sûreté des écritures »).
- **Pas encore d'écran :** le fuseau de l'activité et les exceptions (fermetures, ouvertures exceptionnelles) ont déjà leurs actions.

## Recette en staging (comptes fictifs uniquement)

1. Se connecter avec un compte professionnel fictif, nouvellement inscrit.
2. `/app/welcome` affiche « Mise en route », 0 étape sur 2. Cliquer sur « Ajouter mes prestations ».
3. Créer trois prestations, par exemple :
   - Pose cil à cil, 120 min, 110 € ;
   - Remplissage, 60 min, 55 € ;
   - Rehaussement, 75 min, 65 €.
4. Dans « Horaires » :
   - ouvrir du lundi au samedi ;
   - mardi : 9:00–12:30 et 13:30–19:00 ;
   - samedi : 10:00–16:00 ;
   - dimanche fermé ;
   - enregistrer : le message « Horaires enregistrés. » s'affiche.
5. Recharger les deux pages : tout est identique, et le bandeau « Mise en route » a disparu de l'agenda.
6. Dans l'agenda, « Nouveau rendez-vous » : les trois prestations sont proposées dans l'ordre. Créer un rendez-vous pour une nouvelle cliente.
7. Le rendez-vous apparaît dans l'agenda, au jour choisi.
8. La cliente apparaît dans « Clientes ».
9. Optionnel : désactiver une prestation. Elle n'est plus proposée dans l'agenda, et ses rendez-vous existants la gardent.

Les étapes 1 à 8 sont aussi automatisées contre PostgreSQL réel dans `tests/integration/professional-setup.test.ts`.
