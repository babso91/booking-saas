# Booking SaaS

Fondation d'un SaaS de réservation, gestion clientes et fidélisation pour les indépendantes beauté.

Le socle technique et le backend de la réservation (prestations, horaires, disponibilités, réservation publique) sont en place ; les écrans et les autres verticales de la V1 restent à construire. Le périmètre produit complet est dans [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) et les décisions techniques dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prérequis

- Node.js 24 LTS ;
- npm 11+ ;
- Docker Desktop ou un runtime Docker compatible pour Supabase local.

## Installation

```bash
nvm use
npm install
cp .env.example .env.local
npm run db:start
```

Renseigner dans `.env.local` les clés affichées par `npm run db:start`, puis lancer :

```bash
npm run db:reset
npm run dev
```

L'application est disponible sur [http://localhost:3000](http://localhost:3000), Supabase Studio sur [http://localhost:54323](http://localhost:54323) et le contrôle de santé sur [http://localhost:3000/api/health](http://localhost:3000/api/health).

Le seed de démonstration est intentionnellement désactivé dans cette étape de fondation. Il sera ajouté avec la première verticale métier.

## Scripts

| Commande               | Usage                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run dev`          | serveur Next.js local                                                                             |
| `npm run build`        | build de production                                                                               |
| `npm run check`        | format, lint, types et tests                                                                      |
| `npm run test`         | tests unitaires Vitest (sans base)                                                                |
| `npm run test:db`      | tests d'intégration contre Supabase local                                                         |
| `npm run test:upgrade` | upgrade d'une base peuplée : remise à un ancien schéma, données historiques, migrations suivantes |
| `npm run test:e2e`     | parcours de confirmation email contre `next start`                                                |
| `npm run db:start`     | démarre Supabase local                                                                            |
| `npm run db:stop`      | arrête Supabase local                                                                             |
| `npm run db:reset`     | rejoue les migrations locales                                                                     |
| `npm run db:types`     | régénère les types TypeScript depuis le schéma local                                              |

## Tests de base de données

Les tests de `tests/integration` s'exécutent contre la pile Supabase locale entièrement migrée (PostgreSQL, Auth, PostgREST) : migrations, RLS entre deux businesses, calcul des créneaux, réservation publique, double réservation concurrente et Route Handlers.

```bash
npm run db:start   # une fois
npm run db:reset   # rejoue toutes les migrations
npm run test:db
```

Les migrations qui transforment des données existantes ont deux preuves : base vierge (`npm run db:reset` puis `npm run test:db`) et upgrade d'une base peuplée (`npm run test:upgrade`, `tests/upgrade`). Ce dernier remet la base locale à un schéma antérieur, insère des données historiques, applique les migrations suivantes et vérifie les données. Il est destructif pour la base locale, qu'il laisse entièrement migrée.

Le test E2E `tests/e2e` vérifie l'inscription avec confirmation email : lien reçu dans Mailpit (http://127.0.0.1:54324), `/auth/callback`, session puis `/onboarding`. Il démarre lui-même `next start` sur `http://localhost:3000` (port libre requis) :

```bash
npm run build
npm run test:e2e
```

Les clés sont lues via `supabase status` ; elles peuvent aussi être fournies par `SUPABASE_TEST_API_URL`, `SUPABASE_TEST_DB_URL`, `SUPABASE_TEST_ANON_KEY` et `SUPABASE_TEST_SERVICE_ROLE_KEY`. Les tests refusent de s'exécuter contre un hôte non local. La CI (`.github/workflows/ci.yml`) exécute les mêmes étapes et vérifie que `src/types/database.generated.ts` correspond au schéma.

## Variables d'environnement

- `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` : configuration publique Supabase ;
- `NEXT_PUBLIC_APP_URL` : origine canonique de l'app (`http://localhost:3000` en local, jamais `127.0.0.1`). Elle doit correspondre au `site_url` et aux URL de redirection de Supabase Auth, sinon la confirmation email échoue ;
- `SUPABASE_SERVICE_ROLE_KEY` : secret serveur qui contourne RLS, réservé aux workers ;
- `RESEND_API_KEY` et `RESEND_FROM_EMAIL` : envoi d'emails, non utilisés avant la verticale email ;
- `CRON_SECRET` : authentification des routes de traitements programmés.

Les secrets ne doivent jamais utiliser le préfixe `NEXT_PUBLIC_` ni être importés hors des modules `server-only`.

## État actuel

Inclus :

- Next.js App Router, TypeScript strict, Tailwind CSS ;
- clients Supabase navigateur, serveur, public (sans session) et admin ;
- schéma multi-tenant avec RLS, privilèges « deny by default » et clés étrangères composites ;
- contrainte d'exclusion GiST empêchant tout chevauchement de rendez-vous non annulés, buffer compris ;
- prestations : création, lecture, modification, activation, ordre d'affichage, suppression si jamais réservée ;
- horaires hebdomadaires à plages multiples, réglages de réservation, exceptions (fermeture, vacances, blocage, ouverture exceptionnelle) ;
- calcul des créneaux disponibles dans le fuseau IANA du business, PostgreSQL étant la seule autorité calendaire (jours réels, heures murales, occurrences ; ni Node ni le navigateur ne convertissent avec leur propre tzdata : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8) ;
- réservation publique transactionnelle avec création/rapprochement de la cliente et email de confirmation mis en outbox ;
- API publique : `GET /api/public/businesses/[slug]`, `GET /api/public/businesses/[slug]/availability?serviceId=…&date=AAAA-MM-JJ`, `POST /api/bookings` ;
- Server Actions professionnelles dans `src/features/*/actions` ;
- authentification professionnelle (email + mot de passe), gardes de routage serveur et onboarding transactionnel : contrat UI dans [docs/AUTH_ONBOARDING_CONTRACT.md](docs/AUTH_ONBOARDING_CONTRACT.md).
- intégration Google Calendar entrante (OAuth, sélection des calendriers bloquants, synchronisation complète, incrémentale et push, périodes occupées dans la disponibilité et la réservation) : contrat dans [docs/CALENDAR_INTEGRATION_CONTRACT.md](docs/CALENDAR_INTEGRATION_CONTRACT.md) ;
- backend de l'agenda professionnel V1 (lecture d'une plage, rendez-vous manuels, déplacements, statuts, blocs, concurrence) : contrat UI dans [docs/PROFESSIONAL_AGENDA_CONTRACT.md](docs/PROFESSIONAL_AGENDA_CONTRACT.md).

Non inclus : écrans métier (dont l'écran d'agenda), CRM, fidélité fonctionnelle, envoi des emails, relances, statistiques et seed.

## Interface d'authentification et d'onboarding

Les écrans `/login`, `/signup`, `/onboarding` (4 étapes, aperçu en direct de la page publique) et `/app/welcome` (fin d'onboarding) appellent directement les Server Actions du contrat [docs/AUTH_ONBOARDING_CONTRACT.md](docs/AUTH_ONBOARDING_CONTRACT.md), via `callAction` (`src/features/auth/client/call-action.ts`), qui ajoute seulement le cas `network` quand la requête n'aboutit pas. Chaque code d'erreur a son texte d'interface (`src/features/auth/client/error-copy.ts`) ; aucun message backend, Supabase ou PostgreSQL n'est affiché. Les gardes serveur restent l'autorité : l'écran de succès vit sous `/app` parce que, une fois l'activité créée, la garde de `/onboarding` redirige.

La validation côté navigateur reprend les limites des schémas backend (vérifié par `src/features/onboarding/contract-alignment.test.ts`). Le brouillon d'onboarding est gardé dans l'onglet (`sessionStorage`), rattaché au compte, et effacé après succès ou déconnexion.

Si une action échoue au niveau du transport, `callAction` interroge la page courante (requête `HEAD` suivant les redirections, 5 s maximum) : elle ne conclut à une session expirée que si le serveur mène à `/login`, seule destination de l'état `unauthenticated`. Une autre redirection (par exemple `/onboarding` → `/app` après un onboarding dont la réponse a été perdue) reste une erreur réseau à réessayer, et une réponse 5xx une erreur interne.

## Interface de l'agenda professionnel

`/app` est l'espace professionnel : barre latérale sur ordinateur, barre d'onglets en bas sur téléphone. L'agenda (`src/features/agenda/components`) n'utilise que les Server Actions de [docs/PROFESSIONAL_AGENDA_CONTRACT.md](docs/PROFESSIONAL_AGENDA_CONTRACT.md) :

- une semaine est lue à partir de 768 px, une journée sur téléphone, en une seule requête agrégée ;
- la grille place chaque élément d'après ses instants UTC réels et les bornes réelles de chaque jour local (`localDayBounds` : premier instant réel de la date → premier instant réel de la date suivante, intervalle semi-ouvert ; un minuit répété commence au premier, un minuit sauté à la transition ; jours de 23, 24, 25 h mais aussi 23,5 ou 26 h), d'après les règles IANA du runtime ; la période est demandée à partir de la veille puis réduite à ces bornes (précaution conservée : le backend utilise désormais la même définition du jour, agenda comme réservation publique) ; l'heure répétée d'automne a sa propre bande, un élément ne change jamais de jour ni de durée ; les heures affichées et les prix viennent du DTO (`local*`, `priceCents`), sans calcul flottant ;
- aucune écriture optimiste : la réponse du serveur met à jour le panneau et la plage visible est rechargée ;
- les versions (`stale_*`), l'idempotence de création (`requestId` lié à l'empreinte de la commande), les conflits de planning et les deux occurrences de l'heure répétée à l'automne sont gérés explicitement.

## Règles d'architecture

- Les lectures privées passent par des Server Components et une DAL `server-only`.
- Les mutations UI passent par des Server Actions minces et revalident toujours auth, autorisation et entrées.
- Les endpoints publics ou machine utilisent des Route Handlers étroits.
- Les rendez-vous, transitions de statut, événements fidélité et emails ne sont pas directement modifiables par le rôle `authenticated` : des fonctions transactionnelles dédiées seront ajoutées avec les verticales concernées.
- RLS reste la dernière ligne de défense ; un filtre frontend n'est jamais une autorisation.

## Migrations

| Migration                                              | Contenu                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260927193000_initial_foundation.sql`                | modèle initial, RLS et politiques                                                                                                                                      |
| `20260927200000_harden_api_privileges.sql`             | retrait de `TRUNCATE`, privilèges anonymes et `EXECUTE` implicites ; schéma `private`                                                                                  |
| `20260927200100_scheduling_invariants.sql`             | fuseau validé, réglages par défaut, plages sans chevauchement, contrainte avec buffer                                                                                  |
| `20260927200200_availability_and_public_booking.sql`   | calcul des créneaux, RPC publiques de réservation, fonctions horaires et ordre des prestations                                                                         |
| `20260928090000_schedule_coordination.sql`             | verrou de planning commun, blocages refusés sur un rendez-vous, valeurs de réservation cohérentes, plages DST                                                          |
| `20260928190000_schedule_lock_order_and_isolation.sql` | remplacements atomiques (`replace_business_hours`, `reorder_services`), `READ COMMITTED` exigé pour les écritures de planning, ordre des verrous                       |
| `20260929090000_auth_onboarding.sql`                   | onboarding transactionnel et idempotent, normalisation et réservation des slugs, téléphone du business                                                                 |
| `20261001090000_unified_local_day.sql`                 | PostgreSQL autorité calendaire : jour civil réel, plages murales multi-segments, `business_time`, heures murales des créneaux, réservation à `now` explicite           |
| `20261002090000_business_time_now.sql`                 | `business_time` renvoie aussi `now` et `todayEndsAt` : durée restante du jour calculée par PostgreSQL seul                                                             |
| `20261003090000_calendar_inbound_sync.sql`             | calendriers externes (Google → Booking) : connexions, secrets chiffrés, calendriers bloquants, périodes externes dans la disponibilité et la réservation               |
| `20261004090000_calendar_sync_hardening.sql`           | sync calendrier durcie : incarnations de connexion, claims de sync, générations jamais réutilisées, changement de fuseau, backoff et équité, `freeBusyReader`          |
| `20261005090000_calendar_sync_hardening_2.sql`         | sync calendrier, 2ᵉ passe : reprojection atomique des journées entières au changement de fuseau, CAS des secrets, fenêtre de révocation persistée, intervalles stricts |
| `20261006090000_calendar_sync_hardening_3.sql`         | sync calendrier, 3ᵉ passe : aucun repli sur le fuseau du business, fuseaux stricts, lignes historiques préservées et resynchronisées, attentes de verrou bornées       |

Toute modification de schéma doit être ajoutée dans une nouvelle migration ; ne pas réécrire une migration déjà appliquée sur un environnement partagé.
