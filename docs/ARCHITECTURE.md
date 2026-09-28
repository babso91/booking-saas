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

| URL                                          | Accès              | Rôle                                        |
| -------------------------------------------- | ------------------ | ------------------------------------------- |
| `/`                                          | public             | présentation produit minimale               |
| `/login`                                     | public             | authentification professionnelle            |
| `/auth/callback`                             | public contrôlé    | échange du code Supabase Auth               |
| `/app`                                       | authentifié        | dashboard                                   |
| `/app/calendar`                              | authentifié        | agenda                                      |
| `/app/clients`                               | authentifié        | mini-CRM                                    |
| `/app/services`                              | authentifié        | prestations                                 |
| `/app/loyalty`                               | authentifié        | programme et récompenses                    |
| `/app/settings`                              | authentifié        | business et disponibilités                  |
| `/b/[slug]`                                  | public             | page business et réservation                |
| `/loyalty/[token]`                           | public signé       | vue fidélité d'une cliente                  |
| `/api/bookings`                              | public, limité     | création transactionnelle d'une réservation |
| `/api/public/businesses/[slug]`              | public             | profil public et prestations actives        |
| `/api/public/businesses/[slug]/availability` | public             | créneaux disponibles d'un jour local        |
| `/api/cron/*`                                | secret machine     | rappels, réactivation et outbox email       |
| `/api/webhooks/resend`                       | signature vérifiée | événements de livraison email               |

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
6. Privilèges « deny by default » (migration `20260927200000`) : `anon` n'a aucun privilège de table, `authenticated` n'a que le DML filtré par RLS (jamais `TRUNCATE`, qui contourne RLS ; aucun DML direct sur `business_hours`, modifiable uniquement par `replace_business_hours`), et toute fonction doit recevoir un `GRANT EXECUTE` explicite. Les helpers internes vivent dans le schéma `private`, non exposé par PostgREST.
7. Les opérations publiques passent exclusivement par quatre RPC `SECURITY DEFINER` (`get_public_business`, `get_public_services`, `get_available_slots`, `create_public_booking`) à `search_path` vide, qui revalident toutes leurs entrées et renvoient des DTO minimaux. Elles sont appelées avec la clé publishable ; aucun secret n'est nécessaire au parcours public.

### Double réservation

PostgreSQL applique la contrainte d'exclusion GiST `appointments_no_overlap` sur `business_id` et la plage occupée `occupied_window = [starts_at, ends_at + buffer)` de tout rendez-vous non annulé. Le buffer est figé dans `buffer_minutes_snapshot` au moment de la réservation et `occupied_window` est dérivée par trigger (jamais fournie par l'appelant). Seule une annulation libère un créneau : `completed` et `no_show` restent occupants. Deux transactions concurrentes ne peuvent donc pas créer de chevauchement, buffer compris. Le code traduit l'erreur de contrainte en `slot_unavailable`.

La contrainte initiale (`[starts_at, ends_at)`, statut `confirmed` uniquement) ignorait le buffer et libérait le créneau d'un rendez-vous terminé ; elle est remplacée par la migration `20260927200100`.

### Coordination du planning

Un verrou transactionnel par business (`pg_advisory_xact_lock` sur `business_schedule:<id>`, migrations `20260928090000` et `20260928190000`) sérialise les écritures qui **ajoutent** de l'occupation ou **remplacent** un ensemble. Toutes les écritures ne le prennent pas.

| Opération                                                                                                     | Verrou de planning | Moment                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `create_public_booking`                                                                                       | oui                | en premier, avant toute lecture                   |
| `replace_business_hours`                                                                                      | oui                | en premier, avant le `DELETE`                     |
| `reorder_services`                                                                                            | oui                | en premier, avant la validation de la permutation |
| insertion ou modification d'un `closed`/`blocked`/`open_override` (création, déplacement, changement de type) | oui                | trigger `BEFORE`                                  |
| insertion d'un rendez-vous non annulé, déplacement, ré-activation d'un rendez-vous annulé                     | oui                | trigger `BEFORE`                                  |
| écriture privilégiée (postgres, service role) sur `business_hours`                                            | oui                | trigger `BEFORE` (filet de sécurité)              |
| annulation d'un rendez-vous, suppression d'une exception                                                      | non                | —                                                 |
| changement de statut sans changement d'horaire (`completed`, `no_show`), notes                                | non                | —                                                 |
| modification d'une prestation ou des réglages                                                                 | non                | protégée par le `FOR SHARE` de la réservation     |
| lectures, calcul des créneaux affichés                                                                        | non                | —                                                 |

Annuler un rendez-vous ou supprimer un blocage ne fait que libérer du temps. Une écriture concurrente validée sur l'état précédent n'a vu que moins de disponibilité : elle peut être refusée à tort, jamais produire un état incohérent. Ces opérations restent donc hors verrou.

L'invariant est symétrique et porté par des triggers, pas par les appelants :

- une période `closed` ou `blocked` ne peut pas chevaucher `[starts_at, ends_at)` d'un rendez-vous non annulé ;
- un rendez-vous non annulé ne peut pas chevaucher une période `closed` ou `blocked`.

Règle métier V1 : un blocage (création, déplacement ou changement de type) en conflit avec un rendez-vous existant est refusé avec `schedule_conflict`. Un rendez-vous n'est jamais déplacé ni annulé automatiquement. Les périodes adjacentes sont autorisées. Les triggers sont `SECURITY INVOKER` : la vérification ne voit que les lignes lisibles sous RLS et ne révèle donc rien d'un autre tenant.

Les horaires hebdomadaires ne sont modifiables par les rôles API qu'au travers de `replace_business_hours` : le DML direct sur `business_hours` est retiré à `authenticated`. Un remplacement est atomique : après commit, les horaires correspondent exactement au dernier appel sérialisé, jamais à une fusion de deux appels concurrents.

#### Niveau d'isolation supporté

La garantie repose sur `READ COMMITTED`. Après avoir attendu le verrou, chaque requête suivante prend un nouveau snapshot qui inclut l'écriture concurrente commitée. Sous `REPEATABLE READ` ou `SERIALIZABLE`, le snapshot est figé à la première requête de la transaction, et le verrou ne le rafraîchit pas.

Toute écriture qui prend le verrou de planning refuse donc un autre niveau d'isolation, avec l'erreur `unsupported_isolation_level` (SQLSTATE `0A000`), avant d'attendre le verrou et avant d'écrire quoi que ce soit. L'application, PostgREST et Supabase utilisent `READ COMMITTED` par défaut. Les écritures qui libèrent seulement du temps restent autorisées à tout niveau.

#### Ordre des verrous

Convention : **verrou de planning d'abord, puis verrous de lignes métier** (`businesses`, `business_settings`, `services`, `business_hours`). Les trois RPC ci-dessus la respectent. La réservation prend le verrou de planning, puis `FOR SHARE` sur le business, les réglages et la prestation.

Une modification isolée d'une prestation ou des réglages (une seule instruction) ne prend pas le verrou de planning. Elle ne peut donc pas former de cycle : elle attend la réservation, ou la réservation l'attend.

Risques restants, documentés plutôt que sur-architecturés :

- pour un `UPDATE` d'une exception ou d'un rendez-vous existant, PostgreSQL verrouille la ligne visée avant d'exécuter le trigger qui prend le verrou de planning. C'est sans risque aujourd'hui : aucun détenteur du verrou de planning ne verrouille ces lignes. Les futures RPC d'agenda qui déplaceront des rendez-vous devront appeler `private.lock_business_schedule` avant de toucher ces lignes ;
- une transaction à plusieurs instructions qui modifierait une prestation ou les réglages, puis écrirait dans le planning, inverserait l'ordre et pourrait entrer en deadlock avec une réservation. PostgreSQL annulerait alors l'une des deux transactions. Aucun chemin applicatif ne fait cela aujourd'hui ; une future opération de ce type devra prendre le verrou de planning en premier.

### Cohérence des valeurs d'une réservation

La RPC `create_public_booking` lit une seule fois le business, les réglages et la prestation, avec `FOR SHARE` après le verrou de planning. Elle passe ces valeurs explicitement à `private.compute_available_slots`, puis les réutilise pour la fenêtre occupée et l'insertion. Une modification concurrente est soit validée avant et lue, soit mise en attente jusqu'au commit de la réservation. Validation et rendez-vous stocké utilisent donc toujours exactement les mêmes durée, buffer et grille.

La RPC `create_public_booking` effectue dans une transaction : validation du business et du service actif, recalcul de disponibilité par la même fonction que l'affichage, recherche ou création de la cliente (email insensible à la casse, au sein du business uniquement, sans jamais modifier une fiche existante), insertion du rendez-vous avec snapshots, puis insertion de l'email de confirmation dans l'outbox. Grâce au verrou de planning, une seconde réservation concurrente attend la première puis revalide sur un snapshot à jour. La contrainte d'exclusion reste la garantie finale entre rendez-vous, quel que soit le chemin d'écriture et le niveau d'isolation. L'interface n'est jamais la source d'autorité du créneau.

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

Le calcul est implémenté une seule fois, en PostgreSQL (`private.available_slots(business, service, date locale, now)`). La RPC publique d'affichage et la transaction de réservation appellent la même fonction : l'affichage ne peut pas être plus permissif que l'insertion. La conversion des horaires locaux utilise la base IANA de PostgreSQL et gère les changements d'heure.

Pour un jour calendaire `D` du fuseau du business :

1. plages ouvertes = plages hebdomadaires du jour de semaine de `D` (`0` = dimanche, `24:00` autorisé en fin de plage) + exceptions `open_override` ;
2. plages utilisables = plages ouvertes − exceptions `closed` (fermeture, vacances) et `blocked` (créneau bloqué, rendez-vous personnel) ; une fermeture l'emporte sur une ouverture exceptionnelle ;
3. candidats = grille de `slot_interval_minutes` ancrée sur le début de chaque plage ouverte ;
4. un candidat est retenu si `[début, début + durée)` tient dans une plage utilisable, si `[début, début + durée + buffer)` ne touche la plage occupée d'aucun rendez-vous non annulé, si `début ≥ now + délai minimal`, et si `début` tombe au plus tard le jour local `aujourd'hui + horizon` (le dernier jour est réservable en entier).

Le buffer n'est exigé qu'entre deux rendez-vous : une prestation peut finir à la fermeture ou au début d'un blocage.

Changements d'heure (règle identique à `timestamp AT TIME ZONE` de PostgreSQL et à `src/lib/time/zoned.ts`) :

- une heure locale inexistante (passage à l'heure d'été) est décalée de la durée du saut : 02:30 devient 03:30 à Paris ;
- une heure ambiguë (passage à l'heure d'hiver) prend l'instant le plus tardif, en heure standard ;
- une plage rendue vide ou inversée ce jour-là (par exemple 02:30–03:00 le 28 mars 2027) est ignorée pour ce jour uniquement ; les autres plages de la journée restent calculées.

Le serveur reçoit une date locale et renvoie des instants UTC accompagnés du fuseau du business. Côté professionnel, les exceptions sont saisies en heure murale locale et converties en UTC côté serveur avec le fuseau du business (`src/lib/time/zoned.ts`, aligné sur le comportement de PostgreSQL pour les heures ambiguës ou inexistantes). Aucun code ne suppose `Europe/Paris`, qui n'est qu'une valeur par défaut de colonne ; les fuseaux invalides sont refusés par trigger.

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
- **base locale Supabase :** contraintes de chevauchement, RLS A/B, clés composites et fonctions transactionnelles (`npm run test:db`, dossier `tests/integration`, contre la pile Supabase locale entièrement migrée) ;
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

La fondation crée le projet, les frontières de code, la validation d'environnement, les clients Supabase et le schéma initial sécurisé. La verticale suivante livre le backend des prestations, des horaires et exceptions, du calcul de créneaux et de la réservation publique (RPC, DAL, Server Actions et Route Handlers). Ne sont pas encore livrés : authentification utilisable et onboarding, écrans, agenda, CRM, fidélité, envoi des emails, relances, seed de démonstration et statistiques. Ces éléments doivent être ajoutés en verticales testables dans l'ordre ci-dessus.
