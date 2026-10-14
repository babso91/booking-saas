# Configuration de l'activité : prestations et horaires (PR #20)

Une professionnelle nouvellement inscrite configure seule ses prestations et ses horaires. Ces réglages sont enregistrés dans Supabase et utilisés par le moteur existant (agenda, disponibilités). Cette PR ne contient que des écrans, sans nouveau contrat serveur.

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

## Contrats réutilisés (inchangés)

- **Prestations :** `listServicesAction`, `createServiceAction`, `updateServiceAction` (seuls les champs modifiés), `setServiceActiveAction`, `reorderServicesAction` (la liste complète, comme l'exige `reorder_services`), `deleteServiceAction` (`in_use` si la prestation a été réservée : l'écran propose alors de la désactiver).
- **Horaires :** `listBusinessHoursAction` et `replaceBusinessHoursAction`, qui remplace la semaine entière de façon atomique (`replace_business_hours`). L'écran envoie toujours la semaine complète, reconstruite depuis la lecture ; un jour fermé n'a aucune plage.
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
- **Création d'une prestation :** le contrat n'a pas de clé d'idempotence. Après une réponse perdue, la liste est relue avant tout nouvel envoi, et une prestation identique apparue entre-temps est reconnue comme créée.
- **Horaires :** ils n'ont pas de version. L'écran les relit avant d'enregistrer. S'ils ont changé ailleurs depuis l'ouverture, rien n'est remplacé sans un choix explicite : « Remplacer par mes horaires » ou « Reprendre les horaires actuels ».
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
- **Reste à faire dans l'interface :** l'expérience de conflit (comparer, puis choisir) pour `stale_service` et `stale_business_hours`, et le retrait des relectures de précaution (§ 5 de la passation).
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
