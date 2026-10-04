# Architecture technique — V1

**Statut :** architecture cible et état du socle livré

**Mise à jour :** 28 septembre 2026

**Portée :** moteur de réservation sécurisé livré ; intégration calendrier décrite ci-dessous uniquement à l'état de conception

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
| `/onboarding`                                | authentifié        | création du business (sans business)        |
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

- Supabase Auth, email et mot de passe en V1. Magic link, Google et reset de mot de passe s'ajouteront sans changer le modèle : ils aboutissent tous à `/auth/callback` (échange PKCE ou `verifyOtp`), puis aux mêmes gardes.
- `@supabase/ssr` maintient et rafraîchit les cookies dans `src/proxy.ts`. Le Proxy fait aussi une redirection optimiste des visiteurs sans session hors de `/app` et `/onboarding`.
- État serveur d'un visiteur (`src/features/auth/data/session.ts`) : `unauthenticated`, `onboarding_required` ou `ready`. Il est calculé à partir de `auth.getUser()` (validé par le serveur Auth) et de `business_members` lu sous RLS. Des gardes de layout (`src/features/auth/data/guards.ts`) redirigent chaque état vers l'unique route qui l'accepte : pas de boucle possible.
- Chaque Server Action revalide l'utilisateur, son membership et l'objet ciblé ; une protection de page n'est pas héritée par l'action.
- RLS reste active avec le client utilisateur. Aucun identifiant fourni par le client ne suffit à déterminer le tenant : il vient de la session et du membership.
- Les endpoints machine vérifient un secret constant-time ou une signature fournisseur.

### Onboarding

`public.complete_onboarding` (migration `20260929090000`) est la seule voie de création d'un business par un utilisateur. C'est une RPC `SECURITY DEFINER`, exécutable uniquement par `authenticated`, à `search_path` vide, sans aucun paramètre d'identité : le propriétaire est `auth.uid()`.

Elle crée dans une seule transaction :

1. le profil (upsert du prénom et du nom) ;
2. le business ;
3. les réglages de réservation (créés par trigger, puis mis à jour) ;
4. le membership `owner` ;
5. le programme de fidélité par défaut ;
6. l'enregistrement `business_onboardings`.

Toute erreur annule l'ensemble.

- **Idempotence** : `business_onboardings.user_id` est une clé primaire, donc au plus un onboarding par utilisateur, quel que soit le niveau d'isolation. Un verrou consultatif par utilisateur transforme une double soumission en `already_onboarded` propre plutôt qu'en erreur de contrainte. Un utilisateur déjà membre d'un business reçoit aussi `already_onboarded`. Le nombre de businesses par utilisateur n'est pas contraint par ailleurs.
- **Slug** : normalisé uniquement côté base (`private.normalize_slug`, avec `unaccent`). Les contraintes `CHECK` garantissent le format, 3 à 63 caractères et les mots réservés ; la contrainte d'unicité existante tranche la concurrence (`slug_taken`). `check_slug_availability` n'est qu'une aide UX.
- **Contrat UI** : `docs/AUTH_ONBOARDING_CONTRACT.md`.
- **Migration et slugs existants** : les contraintes `businesses_slug_length` et `businesses_slug_not_reserved` sont ajoutées validées (sans `NOT VALID`). Aucun environnement ne contient de données réelles (pas de projet hébergé, pas de seed) : la migration est sûre. Sur une base contenant un slug trop court ou réservé, elle échouerait explicitement plutôt que de modifier des données ; il faudrait alors renommer ces slugs avant de la rejouer.
- **État futur non traité** : un `business_onboardings` existe mais le membership `owner` a été supprimé. L'utilisateur est alors `onboarding_required` et la RPC répond `already_onboarded`. Aucune suppression de membership n'existe en V1 ; une procédure de reprise (support ou RPC dédiée) sera définie avec la gestion d'équipe.

### Hôte canonique, confirmation email et déconnexion

- **Hôte canonique** : `NEXT_PUBLIC_APP_URL` est la seule origine de l'app (`http://localhost:3000` en local). `signUpAction` en dérive `emailRedirectTo` (`authCallbackUrl`), sans hôte codé en dur. `supabase/config.toml` aligne `site_url` et `additional_redirect_urls = ["http://localhost:3000/auth/callback"]`. Le cookie `code-verifier` PKCE est lié à l'hôte : une redirection vers un autre hôte (ex. `127.0.0.1` au lieu de `localhost`) fait échouer l'échange. En production : Site URL, Redirect URLs (`<origine>/auth/callback`) et `NEXT_PUBLIC_APP_URL` doivent désigner la même origine.
- **Confirmation email** activée en local comme en production ; emails lisibles dans Mailpit (http://127.0.0.1:54324). Le parcours complet est testé de bout en bout (`npm run test:e2e`).
- **Déconnexion** : révocation de la session et du refresh token côté Auth ; `getUser` (proxy, gardes, actions) refuse immédiatement l'ancien jeton. PostgREST ne vérifie que la signature et l'expiration du JWT : un jeton d'accès copié reste utilisable sur l'API de données, sous RLS, jusqu'à `jwt_expiry` (3600 s). Pas de liste noire maison ; réduire `jwt_expiry` en production si cette fenêtre est jugée trop longue.

## 8. Disponibilités

### Autorité calendaire : PostgreSQL

Toute conversion qui a une conséquence sur le planning est calculée par PostgreSQL, avec **sa** base IANA (migration `20261001090000`). Node et le navigateur embarquent chacun leur propre tzdata, qui peut différer : en CI, Node 24 (tzdata 2026c) lit America/Vancouver en UTC−7 le 14 mars 2027 alors que PostgreSQL (tzdata 2025b) y lit encore UTC−8. Avec trois calculs « équivalents », l'agenda montrait alors une ouverture `00:00 → 01:00` à 07:00Z–08:00Z pendant que la réservation publique la plaçait à 08:00Z–09:00Z. Il n'y a donc plus qu'une autorité :

| Conversion                                                                                 | Calculée par                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| date civile → instant, bornes d'un jour (`local_day_start`, `local_date_of`)               | PostgreSQL                                                   |
| plages d'ouverture réelles d'un jour (`private.opening_ranges`)                            | PostgreSQL, pour la disponibilité publique **et** l'agenda   |
| disponibilité, horizon, délai minimal, validation de réservation                           | PostgreSQL                                                   |
| heure murale et occurrence (`first`/`second`) d'un instant stocké                          | PostgreSQL (`wall_clock`, `wall_occurrence`)                 |
| heure murale saisie → instant(s) : `exact` / `ambiguous` / `nonexistent`, borne de période | PostgreSQL (`resolve_local`, `local_bound`)                  |
| heure murale des créneaux publics, du payload d'email                                      | PostgreSQL (`get_available_slots`, outbox)                   |
| date du jour du business, instant où elle se termine, instant courant de référence         | PostgreSQL (`business_time` : `today`, `todayEndsAt`, `now`) |

Le serveur Next.js obtient ces valeurs en un appel par lecture ou écriture : `public.business_time` (membres uniquement, entrées bornées), encapsulée par `src/lib/time/business-time.ts`. L'agenda reçoit avec chaque lecture les bornes réelles de chaque jour et les tranches de décalage UTC constant qui les couvrent (`offsets`) ; la grille (`src/features/agenda/client/zone.ts`, `layout.ts`) ne fait que de l'arithmétique sur ces valeurs.

**Date du jour sur un écran ouvert.** Ni l'horloge de l'appareil ni celle du serveur Next ne certifient la date du business : elles peuvent avoir des minutes ou des heures d'écart. `public.business_time` renvoie, à partir d'un seul instant PostgreSQL (migration `20261002090000`), `today`, `todayEndsAt` et `now` ; `readBusinessToday` les transmet tels quels : `{ date, endsAt, now }`, avec toujours `now < endsAt`.

- **Lecture d'action.** Toute action qui dépend d'aujourd'hui (bouton Aujourd'hui, jour par défaut d'une création en vue semaine) envoie **sa propre** question à PostgreSQL, après le clic, et utilise cette réponse. Elle ne rejoint jamais une requête déjà en vol — ni un rafraîchissement d'affichage, ni une autre action : une lecture commencée avant le clic ne dit rien de la date au moment du clic. En cas d'échec, erreur avec réessai (nouvelle lecture) plutôt qu'une date devinée. Une action en attente est abandonnée dès que l'utilisatrice fait autre chose (panneau ouvert, changé ou fermé, navigation).
- **Lecture d'affichage.** Le surlignage d'aujourd'hui et la ligne « maintenant » utilisent un cache. Sa durée de validité est `endsAt − now`, calculée par PostgreSQL seul ; l'écran ne mesure que le temps **écoulé** depuis l'envoi de la question (le plus grand de l'horloge monotone et de l'horloge murale), sans jamais comparer une horloge à un instant de la base. Une requête par changement de jour, partagée par ses déclencheurs : timer posé sur la fin, retour de l'onglet (`visibilitychange`, focus, `pageshow`), tick d'horloge de l'écran. Tant que la date est incertaine, rien n'est surligné.
- **Toutes les lectures.** Chacune se termine toujours (réponse, délai de 10 s ou arrêt) et une réponse arrivée après coup n'est jamais appliquée. Le cache suit la lecture **envoyée** le plus récemment : une lecture plus ancienne ne le fait jamais reculer. Arrêt puis redémarrage (React Strict Mode) équivaut à un premier démarrage.

Code : `src/features/agenda/client/today.ts`, `today-tracker.ts`, `use-canonical-today.ts`. Ni `Intl` ni « date + 1 » : la date suivante vient toujours de PostgreSQL.

Ce que Node et le navigateur ont encore le droit de calculer :

- l'arithmétique de dates civiles sans fuseau (`src/lib/time/local-date.ts` : jour suivant, nombre de jours, jour de semaine) ;
- l'arithmétique sur les instants et les décalages envoyés par PostgreSQL (placement sur la grille, heure murale d'un instant couvert par ces décalages) ;
- le formatage décoratif d'une date civile (`Intl.DateTimeFormat` en `timeZone: "UTC"` pour « mercredi 30 septembre ») et des montants ;
- un pré-contrôle de formulaire (`isValidTimeZone`), que la base refait.

Ils n'utilisent jamais `Intl` avec le fuseau du business pour une décision de planning. La règle `no-restricted-imports` d'`eslint.config.mjs` interdit les conversions de `src/lib/time/zoned.ts` (fondées sur `Intl`) hors des tests. Pour une date que le serveur n'a pas envoyée, l'UI affiche le libellé d'occurrence sans décalage UTC plutôt que d'en deviner un. Un test d'intégration remplace `Intl.DateTimeFormat` par une base volontairement fausse et vérifie que l'agenda, les écritures, la grille et la disponibilité ne bougent pas.

Conséquence assumée : la tzdata de PostgreSQL fait foi. Si elle est en retard sur une décision gouvernementale (cas de la Colombie-Britannique ci-dessus), toute l'application suit la même règle, cohérente partout ; la mettre à jour (image Supabase) change d'un bloc l'agenda, la disponibilité et la réservation.

### Calcul

Le calcul est implémenté une seule fois, en PostgreSQL (`private.available_slots(business, service, date locale, now)`). La RPC publique d'affichage et la transaction de réservation appellent la même fonction : l'affichage ne peut pas être plus permissif que l'insertion. La transaction de réservation est `private.create_public_booking_at(now, …)` ; la RPC publique `create_public_booking` l'appelle avec `now()`, et aucun rôle d'API ne peut appeler le cœur avec un autre « maintenant ». Les tests utilisent ce cœur avec des instants fixes : leur résultat ne dépend pas de la date d'exécution.

Pour un jour calendaire `D` du fuseau du business :

0. jour `D` = `[local_day_start(D), local_day_start(D + 1))`, où `private.local_day_start` renvoie le premier instant réel dont la date locale est `D` ou postérieure. Conséquences :
   - minuit répété (America/Havana et Atlantic/Azores en automne, Asia/Gaza…) : sa **première** occurrence ;
   - minuit sauté : le premier instant après le saut ;
   - date inexistante (Pacific/Apia, 30/12/2011) : jour vide, aucun créneau ;
   - aucune journée n'est supposée durer 24 h.
1. plages ouvertes (`private.opening_ranges`) = plages hebdomadaires du jour de semaine de `D` (`0` = dimanche) + exceptions `open_override`, limitées au jour réel puis fusionnées. Une plage hebdomadaire `de → à` est **l'ensemble des instants du jour `D` dont l'heure murale est dans `[de, à)`** (`24:00` = fin du jour). Elle peut donc donner plusieurs intervalles UTC :
   - heure répétée (Havana, 1er novembre 2026, 00:00–01:00 deux fois) : `00:00 → 00:30` ouvre les deux 00:00–00:30 réels (04:00Z–04:30Z et 05:00Z–05:30Z), jamais le premier 00:30–01:00 entre les deux. Une plage qui couvre toute l'heure répétée (`00:00 → 02:00`) reste un seul intervalle continu de 3 h réelles ;
   - heure inexistante (Paris, 28 mars 2027, 02:00–03:00 absent) : `02:30 → 04:00` ouvre 03:00–04:00 (ce qui en existe), `01:00 → 02:30` ouvre 01:00–02:00, `02:30 → 03:00` n'ouvre rien ce jour-là. Jamais d'intervalle négatif ;
   - `00:00 → 24:00` couvre exactement la journée réelle, qu'elle dure 23, 24, 25, 23,5 ou 26 h (vérifié pour tous les fuseaux IANA, 2018–2028).

   Le calcul procède par tranches de décalage UTC constant (`private.zone_offsets`) : dans une tranche, heure murale = instant + décalage, donc l'intervalle mural se convertit exactement.

2. plages utilisables = plages ouvertes − exceptions `closed` (fermeture, vacances) et `blocked` (créneau bloqué, rendez-vous personnel) ; une fermeture l'emporte sur une ouverture exceptionnelle ;
3. candidats = grille de `slot_interval_minutes` ancrée sur le début de chaque plage ouverte ;
4. un candidat est retenu si `[début, début + durée)` tient dans une plage utilisable, si `[début, début + durée + buffer)` ne touche la plage occupée d'aucun rendez-vous non annulé, si `début ≥ now + délai minimal`, et si `début` tombe au plus tard le jour local `aujourd'hui + horizon` (le dernier jour est réservable en entier).
   - les horaires hebdomadaires sont des heures **murales** ; le délai minimal, la durée et le buffer sont des minutes **réelles** ;
   - une prestation ne quitte jamais un intervalle ouvert : dans `00:00 → 00:30` à Havana le 1er novembre, aucun service de 60 min n'est proposé ;
   - l'horizon se compte en jours civils : il s'arrête à `local_day_start(aujourd'hui + N + 1)`.

Un créneau appartient au jour `D` si et seulement si son instant est dans `[local_day_start(D), local_day_start(D + 1))`. La réservation valide l'instant demandé sur ce même jour (`private.local_date_of`) : ce qui est affiché est exactement ce qui est réservable, y compris pendant la première heure d'un jour au minuit répété.

Le buffer n'est exigé qu'entre deux rendez-vous : une prestation peut finir à la fermeture ou au début d'un blocage.

Périodes saisies par la professionnelle (blocs, fermetures, ouvertures exceptionnelles ; `private.local_bound`) : minuit est le début réel du jour ; une autre heure suit `timestamp AT TIME ZONE` (heure répétée → occurrence la plus tardive, heure inexistante → décalage d'avant le changement). Une borne inchangée d'un bloc garde son instant stocké. Un rendez-vous saisi à une heure répétée exige `occurrence`, une heure inexistante est refusée.

La RPC publique renvoie des instants UTC, le fuseau du business et l'heure murale de chaque créneau lue par PostgreSQL (`localStartsAt`, `localEndsAt`) : un client affiche ces valeurs, jamais une conversion avec sa propre tzdata. Aucun code ne suppose `Europe/Paris`, qui n'est qu'une valeur par défaut de colonne ; les fuseaux invalides sont refusés par trigger.

### Agenda professionnel (V1, backend)

L'agenda n'est pas un second moteur de planning : il lit et modifie les mêmes tables que la réservation publique, avec les mêmes garanties. Il n'existe aucune table d'événements propre à l'agenda. Les événements externes (Google Calendar) auront leur propre modèle (§8 bis).

- **Rendez-vous.** Ils restent dans `appointments`, qu'ils viennent de la page publique (`created_by` nul) ou soient ajoutés par la professionnelle.
- **Blocs.** Ce sont des `availability_exceptions` de type `blocked` ou `closed`.
- **Horaires.** Ils viennent de `business_hours` et `open_override`.
- **Écritures des rendez-vous** (migration `20260930090000`). Trois RPC `SECURITY DEFINER` : `agenda_create_appointment`, `agenda_update_appointment` et `agenda_set_appointment_status`. Chacune :
  - vérifie `auth.uid()` et le membership du business avant toute lecture ;
  - adresse chaque ligne par `(id, business_id)` ;
  - calcule côté serveur la durée, la fin, le buffer et les snapshots ;
  - prend le verrou de planning en premier pour tout ce qui ajoute de l'occupation, selon la convention d'ordre des verrous.
- **Garanties finales.** La contrainte d'exclusion et les triggers rendez-vous ↔ blocs restent les garanties finales. Ils refusent toujours un niveau d'isolation autre que READ COMMITTED.
- **Placement libre.** La professionnelle peut placer un rendez-vous hors horaires, sans délai minimal ni horizon, mais jamais en chevauchement.
- **Écritures des blocs.** Elles gardent le chemin existant : DML filtré par RLS, dont les triggers prennent le verrou et refusent les chevauchements. L'agenda y ajoute seulement une condition de version.
- **Versions optimistes.** `appointments.version` et `availability_exceptions.version` sont incrémentés par trigger à chaque UPDATE, quel que soit le chemin. Une édition faite depuis un écran périmé renvoie `stale_appointment` ou `stale_block` au lieu d'écraser la modification la plus récente. Le choix d'un entier plutôt que `updated_at` évite toute perte de précision (microsecondes) dans les allers-retours JSON et JavaScript.
- **Double soumission.** À la création, la clé facultative `creation_request_id` est unique par business et liée à `creation_request_fingerprint`, l'empreinte SHA-256 de la commande canonique (prestation, instant UTC, cliente, note ; textes en Unicode NFC, email en minuscules). Un retry identique renvoie le rendez-vous initial. La même clé avec une autre commande donne `idempotency_conflict`, y compris en concurrence, puisque les créations sont sérialisées par le verrou de planning. Pour un changement de statut, redemander le statut courant est sans effet.
- **Changements d'heure.** Une édition qui ne change pas l'horaire conserve l'instant UTC stocké exactement (`p_starts_at` nul), sans reconversion heure murale → UTC. Une heure répétée à l'automne exige `occurrence` (`first` ou `second`, sinon `ambiguous_local_time`), et une heure sautée au printemps est refusée. La réservation publique n'échange que des instants UTC : les deux règles désignent le même instant. Pour les blocs, chaque borne renvoyée inchangée garde son instant UTC stocké ; seule une borne modifiée est convertie, avec la règle du moteur (seconde occurrence pour une heure répétée nouvellement saisie).
- **Statuts.** Les transitions V1 sont bornées en SQL (`agenda_set_appointment_status`). Seule l'annulation libère le créneau. `completed` et `no_show` exigent que le rendez-vous ait commencé. Revenir de `completed` est refusé dès que des points de fidélité ont été attribués.
- **Clientes.** `clients.email` devient facultatif, pour une cliente connue par son nom ou son téléphone. `unique (business_id, email)` continue de dédupliquer les emails, et la réservation publique exige toujours un email. La recherche (`search_clients`) est limitée au business, sous RLS, et échappe les jokers `LIKE`.
- **Lecture.** Elle passe par les Server Actions, sous RLS. Une plage est limitée à 42 jours, 800 rendez-vous et 500 exceptions ; les plages hebdomadaires et les prestations ont aussi un plafond explicite. Chaque liste est demandée avec son plafond + 1, et un dépassement est refusé plutôt que tronqué, car PostgREST plafonne silencieusement à 1000 lignes.
- **Plages d'ouverture.** Celles de chaque jour viennent de `private.opening_ranges`, exactement les plages de la disponibilité publique (§8) ; une plage hebdomadaire et une ouverture exceptionnelle contiguës sont fusionnées. La lecture fait trois allers-retours constants (calendrier, éléments en parallèle, heures murales), jamais un par jour ou par élément.
- **Contrat UI.** Il est décrit dans `docs/PROFESSIONAL_AGENDA_CONTRACT.md`.

## 8 bis. Intégration des calendriers externes

Contrat complet : [`docs/CALENDAR_INTEGRATION_CONTRACT.md`](CALENDAR_INTEGRATION_CONTRACT.md). Migration : `20261003090000_calendar_inbound_sync.sql`.

### Sources de vérité

- Rendez-vous clientes : Booking SaaS est la source de vérité, y compris pour leurs déplacements et annulations. Google n'en modifie jamais un.
- Événements personnels et externes : le fournisseur est la source de vérité. Leurs périodes occupées, pour les calendriers explicitement sélectionnés, sont copiées localement et bloquent la disponibilité publique.
- Rendez-vous Booking exportés vers Google : prochaine PR, non implémentée.

### Implémenté (V1 : Google → Booking)

| Brique                  | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abstraction fournisseur | Le contrat `CalendarProvider` (`src/features/calendar/providers/types.ts`) couvre l'OAuth, la liste des calendriers, les événements full ou incrémentaux, les canaux push et des erreurs classées. Le code propre à Google est isolé dans `providers/google.ts`. Domaine, tables et actions sont génériques (`provider = 'google'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tables                  | `calendar_connections` (métadonnées, RLS en lecture), `external_calendars` (calendriers et sélection bloquante), `external_calendar_events` (périodes UTC, sans titre ni participant ; index GiST `(business_id, busy_window) where busy`). En schéma `private`, inaccessible aux rôles d'API : secrets chiffrés, état de sync et canaux, états OAuth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secrets                 | AES‑256‑GCM côté serveur. La clé est dans l'environnement, avec rotation par identifiant de clé, et des données associées lient chaque chiffré à son business. La base ne stocke que du chiffré ; tokens de canal et `state` OAuth sont stockés sous forme de hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| OAuth                   | Flux « web server » avec PKCE `S256` et `state` à usage unique (10 min), lié à l'utilisateur et au business. `access_type=offline` et `prompt=consent`. Scopes minimaux : `calendar.calendarlist.readonly`, `calendar.events.readonly`, `openid`, `email`. Le callback est uniquement côté serveur, et l'enregistrement se fait en une transaction, sans connexion partielle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Synchronisation         | `singleEvents=true` : Google développe les séries, il n'y a pas de moteur RRULE. Full sync bornée sur `[now − 1 j, now + 400 j)`, paginée et reprise page par page, puis balayage par génération. Incrémentale par `syncToken` ; un 410 relance une full sync. Application idempotente, page par page, sous le verrou de planning, sans appel réseau pendant le verrou. Un seul worker par calendrier ; des notifications répétées coalescent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Autorité des écritures  | Une incarnation de connexion (`credential_generation`) change à chaque connexion, reconnexion et déconnexion : rafraîchissement, `invalid_grant`, liste des calendriers et déconnexion n'écrivent que pour l'incarnation qui les a lancés. Un claim de sync (`claim_id`) conditionne chaque écriture d'une passe ; le bail ne sert qu'à l'acquisition. Échéance globale par passe, transmise à chaque appel Google. Générations de full sync jamais réutilisées. Réponses Google validées strictement (erreur `protocol`, aucun balayage). Fuseau du calendrier inclus dans la copie : au changement, PostgreSQL reprojette les journées entières (dates civiles conservées) dans la transaction qui le détecte, sans fenêtre de sous-blocage, puis une full sync confirme. Écritures de secrets en _compare-and-set_ sur la ligne secrète (incarnation, version) ; ordre des verrous documenté dans le contrat. Révocation distante autorisée par une fenêtre fixée à la déconnexion. Un calendrier ne protège qu'après sa première sync complète (`protecting`). Aucun repli sur le fuseau du business ; un fuseau nommé mais inconnu est une erreur de protocole. Les lignes historiques sans dates civiles gardent leur fenêtre UTC jusqu'à la full sync forcée (preuve : `npm run test:upgrade`). Un fuseau inconnu de PostgreSQL n'arrête jamais la sync : décalage explicite exact, sinon période élargie à tous les fuseaux ; un calendrier au fuseau non fiable (`timezone_trust`) est `degraded`, jamais `synced`, et sa liste est relue toutes les 6 h jusqu'au retour d'un fuseau connu, puis full sync. Les bornes d'un événement sont comparées après résolution de leurs fuseaux ; des bornes incohérentes bloquent l'enveloppe conservatrice et ne font jamais échouer la page ; un calendrier fiable avec des événements élargis ou ajustés est aussi `degraded`. L'écriture d'un token rafraîchi est décidée par PostgreSQL avant une échéance calculée sur sa propre horloge. Statuts `pending`, `syncing`, `synced`, `degraded`, `stale`, `error`, `incomplete` (détail dans le contrat). |
| Push et tâche           | Webhook vérifié par le canal courant, la ressource, le token et l'expiration ; réponse 204 uniforme. Tâche `/api/cron/calendar`, toutes les 15 min : renouvellement des canaux sans trou (nouveau canal, rattrapage, puis arrêt de l'ancien), glissement de fenêtre, reprises avec backoff par calendrier et ordre tourniquet, rattrapage toutes les 6 h.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Disponibilité           | `compute_available_slots` traite une période externe occupée comme une occupation : `[début, début + durée + buffer)` ne doit pas la chevaucher. `create_public_booking_at` revalide sous le verrou, donc un chevauchement synchronisé entre l'affichage et la réservation est refusé. Aucun appel au fournisseur pendant une consultation ou une réservation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Conflits                | Un événement externe peut chevaucher un rendez-vous existant : il est stocké, la sync n'échoue pas, et le rendez-vous reste intact. `calendar_conflicts` le signale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Déconnexion             | D'abord en local, immédiatement et de façon idempotente : périodes, calendriers, secrets et canaux sont supprimés, aucun rendez-vous n'est touché. Ensuite, au mieux, chez Google : arrêt des canaux et révocation ; une reconnexion est refusée tant que cette révocation peut encore toucher la nouvelle autorisation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Cohérence à terme

Google ne participe pas aux transactions PostgreSQL. Un événement créé chez Google bloque Booking une fois synchronisé :

- en quelques secondes avec les notifications push ;
- au plus après le rattrapage de 6 h, plus l'intervalle de la tâche, si une notification se perd.

Une réservation faite dans cet intervalle est conservée. Le conflit est signalé et n'est jamais résolu automatiquement. Le miroir Booking → Google rend aussi le rendez-vous visible côté Google, une fois copié.

### Miroir Booking → Google (outbound core)

Booking reste la source de vérité : Google Calendar n'est qu'un miroir, dans un calendrier secondaire créé par l'application (scope `calendar.app.created`, ajouté par autorisation incrémentale au compte déjà connecté, même compte obligatoire). Un trigger sur `appointments` enregistre seulement un état souhaité (`private.appointment_calendar_mirrors`, un compteur de révision par rendez-vous) dans la transaction du rendez-vous, sur tous les chemins d'écriture ; aucun appel Google n'a lieu dans une transaction Booking ni sous le verrou de planning. Des workers l'appliquent après le commit (kick après la réponse, puis tâche périodique), avec des ids d'événement déterministes, un claim qui capture génération outbound, incarnation et révision, et une revérification SQL avant toute écriture locale. Le calendrier dédié est retrouvé par un marqueur après une réponse perdue. Il n'est jamais une source d'indisponibilité. S'il est supprimé, l'outbound passe `action_required` sans le recréer : les états souhaités continuent d'être enregistrés et sont rejoués après réactivation explicite. Contrat : [`docs/CALENDAR_INTEGRATION_CONTRACT.md`](CALENDAR_INTEGRATION_CONTRACT.md), migration `20261010090000_calendar_outbound_core.sql`.

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
- **E2E :** inscription → email de confirmation (Mailpit) → `/auth/callback` → session → `/onboarding`, contre `next start` (`npm run test:e2e`, dossier `tests/e2e`) ; scénario critique mobile avec Playwright une fois l'UI disponible ;
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

## 15. Roadmap technique indicative

1. moteur de réservation sécurisé — **TERMINÉ**, intégré sur `main` au commit `3a424e5807f7277a98cfe1ca939c8dd13821a30e` ;
2. authentification et onboarding professionnelle ;
3. agenda professionnel et changements de statut ;
4. intégration Google Calendar ;
5. CRM clientes ;
6. ledger fidélité et récompenses ;
7. outbox Resend, rappels et modifications ;
8. réactivation opt-in ;
9. statistiques utiles.

Cet ordre reflète la direction actuelle, pas une obligation architecturale absolue. Sécurité, tests de concurrence/multi-tenant, E2E et préparation de production restent transverses à chaque étape. L'intégration Google n'implique pas que les intégrations Outlook ou Apple soient incluses dans ce lot.

## 16. Ce que la fondation actuelle ne prétend pas faire

La fondation et le moteur de réservation sécurisé sont livrés : backend des prestations, horaires et exceptions, calcul des créneaux et réservation publique (RPC, DAL, Server Actions et Route Handlers), avec outbox de confirmation et tests. L'authentification professionnelle et l'onboarding transactionnel sont livrés (backend et écrans). Le backend de l'agenda professionnel V1 est livré (lecture d'une plage, rendez-vous manuels, déplacements, statuts, blocs, versions optimistes). Ne sont pas encore livrés : écrans métier dont l'agenda, synchronisation des calendriers externes, CRM, fidélité, envoi des emails, relances, seed de démonstration et statistiques. Ces éléments doivent être ajoutés en verticales testables selon la roadmap indicative ci-dessus.
