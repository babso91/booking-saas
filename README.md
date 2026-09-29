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

| Commande           | Usage                                                |
| ------------------ | ---------------------------------------------------- |
| `npm run dev`      | serveur Next.js local                                |
| `npm run build`    | build de production                                  |
| `npm run check`    | format, lint, types et tests                         |
| `npm run test`     | tests unitaires Vitest (sans base)                   |
| `npm run test:db`  | tests d'intégration contre Supabase local            |
| `npm run db:start` | démarre Supabase local                               |
| `npm run db:stop`  | arrête Supabase local                                |
| `npm run db:reset` | rejoue les migrations locales                        |
| `npm run db:types` | régénère les types TypeScript depuis le schéma local |

## Tests de base de données

Les tests de `tests/integration` s'exécutent contre la pile Supabase locale entièrement migrée (PostgreSQL, Auth, PostgREST) : migrations, RLS entre deux businesses, calcul des créneaux, réservation publique, double réservation concurrente et Route Handlers.

```bash
npm run db:start   # une fois
npm run db:reset   # rejoue toutes les migrations
npm run test:db
```

Les clés sont lues via `supabase status` ; elles peuvent aussi être fournies par `SUPABASE_TEST_API_URL`, `SUPABASE_TEST_DB_URL`, `SUPABASE_TEST_ANON_KEY` et `SUPABASE_TEST_SERVICE_ROLE_KEY`. Les tests refusent de s'exécuter contre un hôte non local. La CI (`.github/workflows/ci.yml`) exécute les mêmes étapes et vérifie que `src/types/database.generated.ts` correspond au schéma.

## Variables d'environnement

- `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` : configuration publique Supabase ;
- `NEXT_PUBLIC_APP_URL` : URL canonique utilisée dans les liens ;
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
- calcul des créneaux disponibles dans le fuseau IANA du business ;
- réservation publique transactionnelle avec création/rapprochement de la cliente et email de confirmation mis en outbox ;
- API publique : `GET /api/public/businesses/[slug]`, `GET /api/public/businesses/[slug]/availability?serviceId=…&date=AAAA-MM-JJ`, `POST /api/bookings` ;
- Server Actions professionnelles dans `src/features/*/actions` ;
- authentification professionnelle (email + mot de passe), gardes de routage serveur et onboarding transactionnel : contrat UI dans [docs/AUTH_ONBOARDING_CONTRACT.md](docs/AUTH_ONBOARDING_CONTRACT.md).

Non inclus : écrans métier, agenda, CRM, fidélité fonctionnelle, envoi des emails, relances, statistiques et seed.

## Règles d'architecture

- Les lectures privées passent par des Server Components et une DAL `server-only`.
- Les mutations UI passent par des Server Actions minces et revalident toujours auth, autorisation et entrées.
- Les endpoints publics ou machine utilisent des Route Handlers étroits.
- Les rendez-vous, transitions de statut, événements fidélité et emails ne sont pas directement modifiables par le rôle `authenticated` : des fonctions transactionnelles dédiées seront ajoutées avec les verticales concernées.
- RLS reste la dernière ligne de défense ; un filtre frontend n'est jamais une autorisation.

## Migrations

| Migration                                              | Contenu                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260927193000_initial_foundation.sql`                | modèle initial, RLS et politiques                                                                                                                |
| `20260927200000_harden_api_privileges.sql`             | retrait de `TRUNCATE`, privilèges anonymes et `EXECUTE` implicites ; schéma `private`                                                            |
| `20260927200100_scheduling_invariants.sql`             | fuseau validé, réglages par défaut, plages sans chevauchement, contrainte avec buffer                                                            |
| `20260927200200_availability_and_public_booking.sql`   | calcul des créneaux, RPC publiques de réservation, fonctions horaires et ordre des prestations                                                   |
| `20260928090000_schedule_coordination.sql`             | verrou de planning commun, blocages refusés sur un rendez-vous, valeurs de réservation cohérentes, plages DST                                    |
| `20260928190000_schedule_lock_order_and_isolation.sql` | remplacements atomiques (`replace_business_hours`, `reorder_services`), `READ COMMITTED` exigé pour les écritures de planning, ordre des verrous |
| `20260929090000_auth_onboarding.sql`                   | onboarding transactionnel et idempotent, normalisation et réservation des slugs, téléphone du business                                           |

Toute modification de schéma doit être ajoutée dans une nouvelle migration ; ne pas réécrire une migration déjà appliquée sur un environnement partagé.
