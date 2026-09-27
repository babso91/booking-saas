# Architecture technique — V1

**Statut :** décision initiale  
**Date :** 27 septembre 2026  
**Portée :** architecture cible et fondation, sans implémentation des parcours métier

## 1. Décision synthétique

L'application est un monolithe modulaire Next.js déployé sur Vercel, avec Supabase comme système de données et d'identité. PostgreSQL reste la source de vérité pour les invariants métier critiques. Le navigateur ne dialogue directement avec Supabase que pour la session ; les lectures privées passent par des Server Components et les mutations par des Server Actions ou Route Handlers minces, toujours adossés à une couche d'accès aux données serveur.

```text
Navigateur
   │
   ├── pages publiques / espace professionnel
   ▼
Next.js 16 App Router sur Vercel
   ├── Server Components : lectures
   ├── Server Actions : mutations internes
   ├── Route Handlers : booking public, webhooks, cron
   ├── validation Zod + DAL server-only
   └── templates et envoi Resend
   │
   ▼
Supabase
   ├── Auth + cookies SSR
   ├── PostgreSQL + contraintes + transactions
   ├── RLS multi-tenant
   ├── Storage privé pour logo/photo
   └── Cron/pg_net pour réveiller les workers HTTP
```

Ce choix évite un microservice prématuré, conserve une seule base de code TypeScript et place les protections de concurrence et de tenant au niveau de la base.

## 2. Versions de fondation

| Élément           | Choix initial                                      | Motif                                                   |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Runtime CI/Vercel | Node.js 24 LTS                                     | compatible Next.js et Vitest, horizon de support adapté |
| Framework         | Next.js `16.3.6`                                   | Active LTS et correctif de sécurité du 22/09/2026       |
| UI                | React `19.2.8`, Tailwind CSS `4.3.3`               | versions générées/compatibles avec Next 16.3.6          |
| Langage           | TypeScript `5.9.3`, mode strict                    | écosystème stable ; pas de saut anticipé vers TS 7      |
| Données/Auth      | Supabase JS `2.117.2`, SSR `0.12.7`, CLI `2.118.0` | client SSR officiel et migrations locales               |
| Validation        | Zod `4.6.5`                                        | schémas serveur et variables d'environnement            |
| Tests             | Vitest `5.0.2`                                     | tests unitaires et d'intégration TypeScript rapides     |

`next` est volontairement verrouillé sur `16.3.6`. Une mise à jour de sécurité `16.3.7` est annoncée pour le 30 septembre 2026 mais n'existe pas à la date de cette décision ; elle devra être évaluée dès sa publication.

Le build de fondation utilise temporairement le bundler Webpack supporté par Next.js. Dans l'environnement d'automatisation courant, Turbopack tente d'ouvrir un port interne pendant le traitement PostCSS et échoue sous sandbox. Ce choix n'affecte ni App Router ni le runtime et pourra être réévalué quand l'environnement CI autorisera ce fonctionnement.

## 3. Organisation du code

```text
src/
  app/
    (auth)/                 # connexion et callbacks
    (dashboard)/            # espace professionnel authentifié
    (public)/b/[slug]/       # page et parcours public du business
    api/                     # webhooks, cron, endpoints externes
  components/
    ui/                      # primitives visuelles sans logique métier
    shared/                  # composants transverses
  features/
    appointments/
    availability/
    businesses/
    clients/
    emails/
    loyalty/
    services/
      actions/               # Server Actions minces
      data/                  # DAL server-only, DTO minimaux
      schemas/               # entrées Zod
      components/            # UI propre à la feature
  lib/
    env/                     # validation env publique/serveur
    supabase/                # clients browser/server/admin
  types/                     # types générés depuis Supabase
supabase/
  migrations/                # schéma versionné
  seed.sql                   # données de démonstration (étape ultérieure)
docs/
```

Les pages et layouts sont des Server Components par défaut. `'use client'` est limité aux îlots interactifs. Tous les modules privilégiés importent `server-only`. Les objets bruts de base ne traversent pas la frontière React : la DAL retourne des DTO minimaux et sérialisables.

## 4. Routage cible

| URL                    | Accès              | Rôle                                        |
| ---------------------- | ------------------ | ------------------------------------------- |
| `/`                    | public             | présentation produit minimale               |
| `/login`               | public             | authentification professionnelle            |
| `/auth/callback`       | public contrôlé    | échange du code Supabase Auth               |
| `/app`                 | authentifié        | dashboard                                   |
| `/app/calendar`        | authentifié        | agenda                                      |
| `/app/clients`         | authentifié        | mini-CRM                                    |
| `/app/services`        | authentifié        | prestations                                 |
| `/app/loyalty`         | authentifié        | programme et récompenses                    |
| `/app/settings`        | authentifié        | business et disponibilités                  |
| `/b/[slug]`            | public             | page business et réservation                |
| `/loyalty/[token]`     | public signé       | vue fidélité d'une cliente                  |
| `/api/bookings`        | public, limité     | création transactionnelle d'une réservation |
| `/api/cron/*`          | secret machine     | rappels, réactivation et outbox email       |
| `/api/webhooks/resend` | signature vérifiée | événements de livraison email               |

Le Proxy Next.js rafraîchit la session Supabase et peut effectuer une redirection optimiste. Il ne remplace jamais l'autorisation dans la DAL et les politiques RLS.

## 5. Modèle de données

Tous les identifiants sont des UUID générés par PostgreSQL. Les montants sont des entiers en centimes et une devise ISO. Les dates métier sont stockées en `timestamptz` UTC ; les horaires récurrents sont des `time` interprétés dans le fuseau IANA du business.

### Identité et tenant

- `profiles` : extension de `auth.users`, sans données métier de tenant.
- `businesses` : identité publique, slug unique, fuseau, propriétaire créateur.
- `business_members` : relation utilisateur/business et rôle. Même si la V1 n'a qu'une professionnelle, cette relation évite de coupler le tenant à `auth.users`.
- `business_settings` : règles de réservation et réactivation en 1:1 avec le business.

### Offre et disponibilité

- `services` : prestation, durée, prix, activation et ordre.
- `business_hours` : zéro ou plusieurs plages par jour de semaine.
- `availability_exceptions` : fermeture, blocage ou ouverture exceptionnelle datée.

### Clientes et rendez-vous

- `clients` : identité de la cliente unique par email normalisé dans un business, notes privées et empreinte du token fidélité.
- `appointments` : créneau, snapshots du nom/prix/durée de la prestation, statut et notes. Les snapshots préservent l'historique après modification d'une prestation.

Les clés étrangères vers cliente et prestation sont composites `(id, business_id)`. Une ligne ne peut donc pas associer des objets appartenant à deux tenants différents.

### Fidélité

- `loyalty_programs` : configuration 1:1, avec mode `appointment` en V1 et `spend` réservé au futur.
- `loyalty_events` : ledger immuable, source de vérité des points.
- `rewards` : catalogue des récompenses actives/inactives.
- `reward_redemptions` : utilisation historisée d'une récompense.

Le passage à `completed`, l'ajout de l'événement de points et le déblocage éventuel d'une récompense seront exécutés dans une seule fonction transactionnelle. Une clé d'idempotence et un index unique partiel sur le rendez-vous empêchent le double crédit.

### Emails

- `email_events` joue le rôle d'outbox : type, destinataire, payload minimal, date prévue, statut, nombre de tentatives et clé de déduplication.

L'événement métier et l'email à envoyer sont créés dans la même transaction. Le worker revendique les lignes par lot avec `FOR UPDATE SKIP LOCKED`, appelle Resend, puis marque le résultat. Ainsi, un échec réseau ne fait pas perdre l'intention d'envoi.

## 6. Invariants critiques

### Isolation multi-tenant

1. RLS est activée sur chaque table métier.
2. Les politiques privées testent l'appartenance via une fonction `security definer` minimale basée sur `auth.uid()`.
3. La DAL filtre aussi explicitement par `business_id`.
4. Les relations métier utilisent des clés étrangères composites.
5. La clé service-role est réservée aux workers serveur ; elle n'est jamais utilisée pour les requêtes ordinaires d'un utilisateur.

### Double réservation

PostgreSQL applique une contrainte d'exclusion GiST sur `business_id` et la plage `[starts_at, ends_at)` pour les rendez-vous `confirmed`. Deux transactions concurrentes ne peuvent donc pas créer de chevauchement. Le code traduit l'erreur de contrainte en réponse métier compréhensible.

La future RPC de réservation publique effectuera dans une transaction : validation du business/service actif, recalcul de disponibilité, upsert de la cliente, insertion du rendez-vous et insertion de l'email de confirmation. L'interface ne sera jamais la source d'autorité du créneau.

### Fidélité idempotente

- aucun point à la réservation ;
- un seul événement `appointment_completed` par rendez-vous ;
- ledger non modifié rétroactivement ; une correction produit un événement compensatoire ;
- une utilisation de récompense crée à la fois `reward_redemptions` et un débit du ledger.

### Accès fidélité sans compte

Le lien contient au moins 32 octets aléatoires encodés en base64url. Seul un hash SHA-256 est stocké. Le token est révocable/rotatif, comparé côté serveur et ne donne accès qu'à un DTO limité de la cliente concernée.

## 7. Authentification et autorisation

- Supabase Auth par email/magic link ou mot de passe, décision UX à prendre lors du lot Auth.
- `@supabase/ssr` maintient les cookies dans `src/proxy.ts`.
- chaque Server Action revalide l'utilisateur, son membership et l'objet ciblé ; une protection de page n'est pas héritée par l'action ;
- RLS reste active avec le client utilisateur ;
- aucun identifiant fourni par le client ne suffit à déterminer le tenant ; le tenant autorisé vient de la session/membership ;
- les endpoints machine vérifient un secret constant-time ou une signature fournisseur.

## 8. Disponibilités

Le calcul cible produit des intervalles candidats selon :

1. plages hebdomadaires du business dans son fuseau ;
2. exceptions d'ouverture/fermeture/blocage ;
3. durée de la prestation et buffer ;
4. rendez-vous `confirmed` existants ;
5. délai minimal et horizon maximal ;
6. intervalle de grille configurable, 15 minutes par défaut.

Le serveur renvoie des instants UTC. La base réévalue la validité lors de l'insertion ; un créneau affiché peut devenir indisponible avant la confirmation et doit alors être signalé sans créer de doublon.

## 9. Emails et tâches planifiées

Resend est appelé uniquement côté serveur. Les emails immédiats et différés passent par l'outbox.

- un cron Supabase déclenche périodiquement un Route Handler Vercel protégé par `CRON_SECRET` ;
- ce handler crée les rappels/réactivations dus de façon idempotente, puis traite un lot d'outbox ;
- `email_events.dedupe_key` est unique par business ;
- les relances sont désactivées par défaut ;
- les tentatives sont bornées et les échecs définitifs restent inspectables.

Ce compromis conserve la logique applicative et les templates dans Next.js tout en utilisant le scheduler de la plateforme de données. Si les limites d'hébergement changent, le même worker pourra être invoqué par Vercel Cron sans modifier le métier.

## 10. Stockage de fichiers

Un bucket Supabase Storage privé stockera les logos/photos. Le chemin inclut le `business_id`. Les uploads sont validés (MIME, taille, dimensions) et les politiques Storage vérifient l'appartenance. La page publique reçoit une URL signée ou une variante publique explicitement dérivée, jamais une permission d'écriture.

## 11. Observabilité et erreurs

- erreurs structurées avec un code stable, message utilisateur et cause serveur non exposée ;
- identifiant de corrélation pour réservation et workers ;
- journaux Vercel sans données personnelles inutiles ;
- suivi des statuts d'email dans `email_events` ;
- page d'erreur et états vides explicites ;
- ajout d'un outil de suivi d'erreurs seulement lorsque la première verticale métier existe.

## 12. Stratégie de tests

- **unitaires :** calcul de créneaux, métriques, règles de réactivation, schémas Zod ;
- **base locale Supabase :** contraintes de chevauchement, RLS A/B, clés composites et fonctions transactionnelles ;
- **intégration :** réservation et completion/idempotence sur une base locale ;
- **E2E :** scénario critique mobile avec Playwright une fois la verticale réservation disponible ;
- **contrat email :** snapshot sémantique des données et test de déduplication, sans appeler Resend.

Les tests de sécurité de base sont obligatoires avant toute mise en production, pas reportés à une phase de finition.

## 13. Déploiement

Environnements distincts : local, preview et production. Chacun possède son projet Supabase et ses secrets. Les migrations sont appliquées avant le déploiement applicatif compatible. Les types TypeScript sont générés depuis le schéma Supabase et vérifiés en CI.

Pipeline cible :

1. format et lint ;
2. vérification TypeScript ;
3. tests unitaires ;
4. démarrage Supabase local et tests de base ;
5. build Next.js ;
6. preview Vercel ;
7. migration puis promotion production avec sauvegarde Supabase vérifiée.

## 14. Points problématiques identifiés

1. **Concurrence de réservation.** Un simple `SELECT` puis `INSERT` est vulnérable. La contrainte d'exclusion est non négociable.
2. **Fuseaux et changements d'heure.** Les horaires récurrents sont locaux mais les rendez-vous sont UTC ; la conversion doit être centralisée et testée sur les bascules été/hiver.
3. **Accès public avec RLS.** Ouvrir les tables aux anonymes exposerait trop de données. Les opérations publiques passeront par des fonctions/endpoints étroits et validés.
4. **Service-role.** Il contourne RLS ; son usage sera cantonné à l'admin client serveur et aux workers, jamais à la DAL utilisateur.
5. **Emails exactement une fois.** Aucun fournisseur ne garantit l'exactly-once réseau. L'outbox et la clé de déduplication fournissent une sémantique « au moins une tentative, un événement logique unique ».
6. **Fidélité et corrections.** Repasser un rendez-vous de `completed` à un autre statut nécessite une politique métier. La recommandation est un événement compensatoire auditable, pas la suppression d'une ligne du ledger.
7. **Statistiques.** Les métriques doivent reposer sur les rendez-vous terminés et une définition stable ; pas de table d'agrégats en V1 tant que le volume ne le justifie pas.
8. **Données personnelles.** Email, téléphone et notes imposent minimisation, politique de conservation et procédure de suppression/export avant ouverture publique.

## 15. Ordre d'implémentation après la fondation

1. Supabase local, authentification et onboarding transactionnel ;
2. prestations et horaires ;
3. verticale réservation publique complète, avec contrainte de chevauchement ;
4. agenda et changements de statut ;
5. CRM clientes ;
6. ledger fidélité et récompenses ;
7. outbox Resend, rappels et modifications ;
8. réactivation opt-in ;
9. statistiques utiles ;
10. durcissement sécurité, tests E2E et production.

## 16. Ce que la fondation actuelle ne prétend pas faire

La fondation crée le projet, les frontières de code, la validation d'environnement, les clients Supabase et le schéma initial sécurisé. Elle ne livre pas encore : authentification utilisable, onboarding, CRUD, calcul de créneaux, réservation, agenda, fidélité, emails, seed de démonstration ou statistiques. Ces éléments doivent être ajoutés en verticales testables dans l'ordre ci-dessus.
