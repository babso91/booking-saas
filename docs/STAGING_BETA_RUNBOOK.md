# Mise en service de la bêta privée sur staging

Base : `main` @ `1965f8a`. Projet Supabase `booking-saas-staging` (`osvlzlnwjnmjscpubawa`). Ce document décrit **quoi faire et dans quel ordre**. Chaque étape marquée 🔒 est une opération externe qui attend un accord explicite.

## 0. Préparer la copie de travail (sans toucher à `main`)

Les scripts sont sur `ops/staging-beta`, une branche partie de `main` @ `1965f8a` avec des migrations identiques. On l'ouvre dans un **dossier séparé** : la copie de `main` n'est pas touchée, et rien n'est fusionné.

```bash
git fetch origin
git worktree add ../booking-saas-ops origin/ops/staging-beta   # dossier séparé, sans branche locale
cd ../booking-saas-ops
```

`audit.mjs` vérifie de lui-même que `supabase/migrations` est identique à `1965f8a`, et s'arrête sinon.

**Prérequis sur macOS :**

- Node 20 ou plus ;
- les outils PostgreSQL **17**, la version du serveur, sans Docker : `brew install postgresql@17`. Les scripts les trouvent seuls, sinon `export PG_BIN="$(brew --prefix postgresql@17)/bin"` ;
- `npm ci` pour la CLI Supabase du dépôt (2.118.0), utilisée seulement par `db push`, qui n'a pas besoin de Docker.

Les scripts tournent avec le bash 3.2 de macOS et les outils BSD (`sed`, `shasum`). Ils ont été vérifiés sans aucun accès à Docker.

**Chaînes de connexion :**

- **Où les trouver :** tableau de bord Supabase du projet > bouton **Connect** > **Session pooler** (port 5432, utilisateur `postgres.<ref>`). L'hôte direct `db.<ref>.supabase.co` n'est joignable qu'en IPv6, et le transaction pooler (port 6543) est refusé par les scripts.
- **Mot de passe :** remplacer `[YOUR-PASSWORD]` par le vrai mot de passe. S'il contient des caractères spéciaux (`@ : / ? # %`), il faut les encoder dans l'URL, ou plus simplement le réinitialiser avec des lettres et des chiffres (Project settings > Database > Reset password).
- **Saisie :** toujours avec `read -rs` (rien à l'écran, rien dans l'historique), jamais dans un fichier ni dans le chat.

Après la bêta : `git worktree remove ../booking-saas-ops`.

## 1. Audit en lecture seule (jeton à droits restreints, aucun mot de passe)

### 1.1 Créer le jeton

supabase.com > Account > Access Tokens > **jeton à portée restreinte** (« scoped »), limité au projet `booking-saas-staging` :

- `database:read` : historique des migrations, sauvegardes, requêtes SQL en lecture seule ;
- `auth:read` : réglages Auth ;
- `storage:read` : buckets ;
- `projects:read` (si demandé).

Aucun droit d'écriture. Expiration courte (7 jours). À révoquer après la bêta.

### 1.2 Lancer l'audit

```bash
export SUPABASE_ACCESS_TOKEN=…        # dans le terminal, jamais dans un fichier ni un message
node scripts/staging/audit.mjs
```

Tout passe par l'API de gestion Supabase :

- `GET …/database/migrations` : historique hébergé ;
- `GET …/database/backups` : état des sauvegardes ;
- `GET …/config/auth` : réglages Auth. **Seuls des champs non secrets sont conservés** (liste fixe : pas de mot de passe SMTP, pas de secret de fournisseur ni de hook) ;
- `GET …/storage/buckets` : buckets ;
- `POST …/database/query/read-only` : `inventory.sql` (comptages) et `accounts.sql`, exécutés sous `supabase_read_only_user`.

Résultats dans `backups/staging-audit-<horodatage>/` (dossier en mode 700, fichiers en 600, ignoré par git) :

- **`summary.txt` : la partie à partager**, sans email ni secret ;
- `accounts.local.json` : **données personnelles** (emails des comptes). Il reste sur ta machine et ne doit être collé nulle part.

Le script a été testé de bout en bout contre une API simulée, adossée à une vraie base sous `supabase_read_only_user`. Trois cas :

- avant migration : verdict OK ;
- après migration : 13 contrôles OK ;
- dérive (une version présente seulement à distance) : STOP, code 2.

Aucun des secrets factices de la configuration Auth ne s'est retrouvé dans les fichiers.

### 1.3 Lire le résultat

**État réellement observé (audit du 8 novembre 2026)** :

- **Migrations :** 24 sur 35 appliquées, la dernière est `20261016090000` (setup_write_guarantees). Aucune version présente seulement à distance, aucun trou.
- **Base :** PostgreSQL 17.11.
- **Données :** 2 comptes confirmés, 2 établissements, 2 prestations, 1 rendez-vous.
- **Storage :** 0 fichier ; les colonnes lues par la réconciliation sont présentes.
- **Sauvegardes :** 0, PITR désactivé.
- **Auth :**
  - `site_url` pointe vers une adresse DuckDNS ;
  - mot de passe minimum : 6 caractères ;
  - aucun SMTP configuré.

**Pour continuer (code de sortie 0) :**

- la dernière version hébergée est **exactement** `20261016090000` ;
- il n'y a aucune version « remote only », ni aucun trou ;
- les migrations en attente sont **exactement** les 11 du § 1.4, dans cet ordre.

`audit.mjs` vérifie précisément cet état (`EXPECTED_LAST_HOSTED`, `EXPECTED_PENDING`), et non plus l'hypothèse des « 4 migrations ». Il a été testé contre cinq états simulés :

| État simulé                                      | Verdict |
| ------------------------------------------------ | ------- |
| État réel (24 migrations, 11 en attente)         | OK      |
| Après migration                                  | OK      |
| Version présente seulement à distance            | STOP    |
| Ancienne hypothèse (dernière version `20261103`) | STOP    |
| Trou dans l'historique                           | STOP    |

**Sinon (code 2) : arrêt.** La répétition du § 2.4 ne décrit plus cet état. On analyse avant tout `migration repair` ou `--include-all`, et on ne fait aucune réparation automatique.

**Deux comptes existants : conservés.** La migration 20261107 donne l'accès bêta à **tous** les comptes présents (`source = 'existing'`), donc ces deux comptes le recevront. On ne supprime aucun compte : ils restent en attente d'identification. Aucun script ne supprime quoi que ce soit.

**À clarifier avant la migration : le `site_url` DuckDNS.** Une ancienne version de l'application tourne peut-être encore sur cette adresse, branchée sur staging. Après la mise à niveau, elle casserait : plusieurs fonctions RPC changent de signature (réservation, disponibilités, agenda, création de prestation), et la réservation publique devient réservée au serveur. Il faut savoir si elle sert encore, et l'arrêter ou l'ignorer.

### 1.4 Les 11 migrations en attente, et leur effet sur la base de staging

Ordre exact d'application :

| #   | Migration                            | Effet sur les données existantes                                                                                                                                                                            | Point d'attention                                                                                                                                                               |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `20261017_public_booking_guarantees` | aucun                                                                                                                                                                                                       | Remplace `create_public_booking` (nouvelle signature, avec `request_id`). Une ancienne application qui l'appelle cassera.                                                       |
| 2   | `20261018_public_booking_hardening`  | **vide** `private.public_booking_log`, le journal anti-abus (empreintes non salées, voulu) ; ajoute une clé HMAC                                                                                            | Réservation publique **réservée au serveur** (`service_role`). `get_public_business` est recréée.                                                                               |
| 3   | `20261019_email_notifications`       | colonnes ajoutées à `email_events` (contraintes `not valid`, l'existant n'est pas revalidé) ; **met en file un rappel** pour chaque rendez-vous futur confirmé qui a un email client                        | Ces emails partiront dès qu'un transport sera activé : **garder `EMAIL_TRANSPORT` vide** tant que la file n'a pas été revue (l'inventaire compte les emails `pending`).         |
| 4   | `20261020_loyalty_engine`            | crée un programme de fidélité **inactif** par établissement ; désactive un programme actif sans événement ; renumérote le grand livre (`ledger_seq`) et complète les récompenses et utilisations existantes | Remplace les politiques d'écriture de la fidélité par des fonctions. Sur staging (aucun événement de fidélité attendu), seule la création des 2 programmes inactifs s'applique. |
| 5   | `20261021_client_hub`                | aucun (tables nouvelles)                                                                                                                                                                                    | —                                                                                                                                                                               |
| 6   | `20261031_member_preferences`        | aucun                                                                                                                                                                                                       | —                                                                                                                                                                               |
| 7   | `20261103_service_catalog`           | colonnes ajoutées : `services.category_id` (nul, donc « sans catégorie ») et `appointments.options_snapshot` (`[]`)                                                                                         | Remplace 7 fonctions (disponibilités, réservations, agenda, création de prestation) par des versions avec options.                                                              |
| 8   | `20261105_site_publishing`           | aucun (tables nouvelles)                                                                                                                                                                                    | —                                                                                                                                                                               |
| 9   | `20261106_site_photos`               | crée le bucket privé `site-photos` et l'état de réconciliation                                                                                                                                              | Lit `storage.objects.archived_at` et `is_delete_marker` (présents sur staging).                                                                                                 |
| 10  | `20261107_beta_invitations`          | **donne l'accès bêta aux 2 comptes existants**                                                                                                                                                              | Ajoute un déclencheur sur `businesses` : une nouvelle création d'établissement exige l'accès bêta.                                                                              |
| 11  | `20261108_category_move`             | aucun                                                                                                                                                                                                       | —                                                                                                                                                                               |

Rien ne supprime de rendez-vous, de cliente, d'établissement ni de compte. Seul le journal anti-abus est vidé, ce qui est voulu.

**Dépendances :** chaque migration s'appuie sur les précédentes : par exemple, 20261103 recrée les fonctions de 20261017 et 20261018. Il faut donc les appliquer **toutes, dans l'ordre, en une seule opération** (`db push`). Aucune extension nouvelle n'est requise.

## 2. Sauvegarde et retour arrière

Le plan Free n'a ni sauvegarde automatique ni PITR (l'audit l'affiche : `Backups: 0 listed`). On ne compte donc que sur notre propre sauvegarde. **Elle n'est considérée complète qu'une fois restaurée et vérifiée** (§ 2.3).

### 2.1 Ce que contient la sauvegarde, et ce qu'elle ne contient pas

Ce que `backup.sh` contient (vérifié sur la répétition locale) :

| Fichier                              | Contenu                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.sql`                          | réglages des rôles                                                                                                                                                           |
| `schema.sql`                         | nos schémas : tables, fonctions, politiques RLS, déclencheurs                                                                                                                |
| `history-schema.sql` + `history.sql` | **l'historique des migrations** (`supabase_migrations`), absent des dumps standards : sans lui, un projet restauré ne saurait plus quelles migrations sont appliquées        |
| `data.sql`                           | données de `auth` (comptes, identités, hachages de mots de passe), `public`, `private` (dont les clés HMAC anti-abus et les jetons calendrier chiffrés) et l'index `storage` |
| `acl.sql`                            | **les droits exacts** de nos schémas, rejoués en dernier (voir l'encadré)                                                                                                    |
| `fingerprint.txt`                    | pour chaque table, le nombre de lignes et le md5 du contenu, pris juste après le dump                                                                                        |
| `acl-fingerprint.txt`                | les droits, sous forme normalisée                                                                                                                                            |
| `inventory.txt`, `SHA256SUMS`        | —                                                                                                                                                                            |

Ce que la sauvegarde **ne contient pas** :

- **Fichiers Storage :** un dump SQL n'en contient pas. Le script **s'arrête** si l'index compte des fichiers. On s'attend à 0, puisque le bucket `site-photos` n'existe qu'après 20261106. S'il y en avait : les télécharger d'abord (tableau de bord Storage, ou `supabase storage cp --experimental`), puis en reparler avant de continuer.
- **Réglages Auth et modèles d'email :** l'instantané non secret est dans `auth.json` (audit). Les secrets (mot de passe SMTP, clés d'API) ne sont jamais exportés : ils se ressaisissent.
- **Vault :** non utilisé (0 secret, aucune migration n'y fait référence).
- **Deux tables internes de Storage** (`buckets_vectors`, `vector_indexes`) : elles appartiennent à la plateforme, sont inutilisées, et `postgres` ne peut pas y écrire. Leur vide est contrôlé par l'empreinte.

> **Piège évité (constaté à la répétition).** `pg_dump` écrit les droits par rapport aux défauts de PostgreSQL, pas à ceux d'un projet Supabase neuf, qui accordent `EXECUTE` et l'accès aux tables à `anon` et `authenticated`. Restaurée telle quelle, la base avait **198 droits différents** : `create_beta_invitation`, réservée au service, devenait exécutable par `anon`. `acl.sql` retire d'abord tout aux rôles de l'API, puis rend exactement les droits de la source, droits par défaut de `postgres` compris. Après restauration, les droits sont identiques (345 objets), et l'appel anonyme à `create_beta_invitation` est refusé (`permission denied`).

Ce dossier contient des données personnelles et des secrets. Il reste sur ta machine (mode 700), ne va jamais dans le dépôt, un disque partagé ou un message, et est supprimé après la bêta.

### 2.2 Sauvegarder

```bash
read -rs SOURCE_DB_URL && export SOURCE_DB_URL   # Session pooler de STAGING
scripts/staging/backup.sh                        # demande de retaper la ref de staging
```

`backup.sh` ne fait que lire staging :

- `pg_dump` et `pg_dumpall --roles-only`, avec exactement les options et filtres de la CLI Supabase (relevés avec son `--dry-run`), mais sans Docker ;
- des `SELECT` en transaction en lecture seule.

Aucun jeton d'API n'est nécessaire.

Garde-fous :

- l'URL doit désigner le projet staging (`osvlzlnwjnmjscpubawa`) ;
- le script affiche l'état lu (version, migrations, comptes) et fait retaper la ref avant de commencer ;
- il s'arrête si Storage contient des fichiers, si un fichier est vide, ou si l'historique ou les comptes Auth manquent.

`manifest.txt` garde la source (ref, hôte, sans mot de passe), l'état et la version de `pg_dump`.

À lancer quand personne n'écrit sur staging, ce qui est le cas aujourd'hui. Ensuite, on peut réinitialiser le mot de passe de la base.

### 2.3 Répétition sur un projet jetable : restaurer, vérifier, puis monter de version (obligatoire avant staging)

Le projet jetable sert deux fois : il prouve que la sauvegarde se restaure, puis que la montée de version 24 → 35 passe sur une **vraie** infrastructure Supabase, avec les vraies données de staging.

1. Créer un projet Supabase **jetable** : gratuit, même région, Postgres 17, vide, avec un mot de passe de base en lettres et chiffres. Noter sa **ref**.
2. Restaurer et vérifier :

   ```bash
   export TARGET_REF=<ref du jetable>
   read -rs TARGET_DB_URL && export TARGET_DB_URL   # Session pooler du JETABLE
   scripts/staging/restore.sh backups/staging-<horodatage>
   ```

   Attendu : `data: identical`, `privileges: identical`, `RESTORE VERIFIED`.

   Garde-fous de `restore.sh`, tous vérifiés **avant** la moindre écriture (chacun a été testé en le provoquant) :

   - la ref nommée par l'URL doit être `TARGET_REF` ;
   - la cible ne peut pas être staging : ni par sa ref, ni par son hôte direct, ni par l'utilisateur du pooler ;
   - la cible ne peut pas être la source de la sauvegarde ;
   - le transaction pooler est refusé ;
   - la cible doit être vide : aucune table à nous, aucun compte ;
   - les sommes SHA-256 de la sauvegarde doivent être intactes ;
   - il faut retaper la ref de la cible.

   Ensuite, il restaure en une seule transaction (rôles, schémas, historique, données, puis droits exacts) et lance `verify-restore.sh`.

3. Monter le jetable de version, comme on le fera pour staging :

   ```bash
   scripts/staging/upgrade-throwaway.sh
   ```

   Le script :

   - refuse staging ;
   - exige que la cible soit exactement au niveau de staging (24 migrations, `20261016090000`) ;
   - montre le `db push --dry-run` (les 11 migrations), fait retaper la ref, puis applique ;
   - vérifie le niveau 35 et les 13 contrôles.

   Attendu : `UPGRADE REHEARSED: 35 migrations, 13/13 post-checks.`

4. Contrôle fonctionnel sur le jetable (tableau de bord : Auth et Table Editor) :

   - les 2 comptes et les 2 établissements sont là ;
   - `private.beta_access` contient 2 lignes `existing` ;
   - aucun email en attente dans `public.email_events` (l'audit en comptait 0).

5. Supprimer le projet jetable.

**Répétition faite en local, depuis l'état exact de staging.** On a construit une base à 24 migrations, puis on y a créé des données par les vrais points d'entrée de cette version :

- 2 comptes confirmés (Auth) ;
- 2 établissements (`complete_onboarding`) et 2 prestations ;
- les horaires ;
- 1 réservation publique future, avec email client.

| Étape                                                                   | Résultat                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup.sh` de cet état ancien, puis `restore.sh` vers une stack vierge | 62 tables identiques (dont les 24 versions de l'historique), 170 droits identiques, `RESTORE VERIFIED`                                                                              |
| Montée de version 24 → 35 sur la **source**                             | les 11 migrations passent, dans l'ordre ; 13/13 contrôles                                                                                                                           |
| Montée de version 24 → 35 sur la **copie restaurée**                    | les 11 passent ; 13/13 ; mêmes droits que la source mise à niveau                                                                                                                   |
| Comparaison avec une base neuve à 35 migrations (celle que teste la CI) | schéma **identique** (0 ligne de différence), droits identiques                                                                                                                     |
| Données existantes                                                      | le rendez-vous est identique, colonne nouvelle mise à part ; 2 comptes, 2 établissements, 2 prestations conservés                                                                   |
| Effets attendus                                                         | 2 accès bêta `existing` ; 2 programmes de fidélité inactifs ; journal anti-abus vidé ; 1 rappel mis en file (plus la confirmation déjà en attente) ; prestations « sans catégorie » |
| Contrôles fonctionnels après montée de version                          | 11/11 (détail ci-dessous)                                                                                                                                                           |

Les 11 contrôles fonctionnels :

- un compte existant se connecte et garde son accès bêta ;
- il voit son établissement et son rendez-vous ;
- il ne voit pas l'autre établissement ;
- l'établissement et la disponibilité publics répondent ;
- une nouvelle réservation passe par le chemin serveur, et l'appel anonyme est refusé (401) ;
- la création de catégorie fonctionne ;
- `create_beta_invitation` est refusée à un compte connecté (403).

Reproductible : `scripts/staging/rehearsal/rehearse.sh`, sur la stack locale uniquement (il efface la base locale et ne touche jamais un projet hébergé).

**Dernière répétition (8 nov., outils natifs, Docker inaccessible aux scripts) :**

- `backup.sh` (`pg_dump` 17.11) de l'état ancien ;
- `restore.sh` vers une base vierge : `RESTORE VERIFIED` (62 tables, 170 droits) ;
- `upgrade-throwaway.sh` : `UPGRADE REHEARSED` (35 migrations, 13/13) ; droits identiques à la source mise à niveau, 2 comptes, 2 établissements, 2 accès `existing`.

Les garde-fous ont été provoqués un par un, et tous ont arrêté le script sans rien écrire.

Ce qui reste à prouver sur l'hébergé : les étapes 2 à 4 ci-dessus, sur le projet jetable.

### 2.4 Retour arrière

- **Si `db push` échoue :** chaque migration est transactionnelle, donc celle qui échoue est entièrement annulée, et les précédentes restent appliquées. On **arrête**, on relance `audit.mjs` pour voir où en est l'historique, et on analyse.
  - L'application n'est pas encore déployée : aucun utilisateur n'est touché.
  - On ne fait aucune réparation automatique.
- **S'il faut revenir à l'état d'avant :**
  - on restaure la sauvegarde (§ 2.2) dans un **nouveau** projet avec `restore.sh` ;
  - on pointe l'application vers ce projet ;
  - on garde l'ancien staging pour analyse.

  `restore.sh` refuse d'écrire sur staging ou sur une base non vide : il n'y a jamais d'écrasement en place.

- **Avant tout cela :** la répétition du § 2.3 sur le jetable doit avoir réussi, sinon on ne touche pas staging.

## 3. 🔒 Migration de staging (après accord, et après le § 2.3 réussi)

C'est l'étape qui écrit. Elle demande le mot de passe de la base, que seul la CLI utilise, dans ton terminal.

```bash
node scripts/staging/audit.mjs                         # code 0 : toujours 24 appliquées, les 11 attendues
read -rs SOURCE_DB_URL && export SOURCE_DB_URL         # Session pooler de STAGING
npx --no-install supabase db push --db-url "$SOURCE_DB_URL" --dry-run   # exactement les 11, dans l'ordre
npx --no-install supabase db push --db-url "$SOURCE_DB_URL"             # 🔒 applique 20261017 → 20261108
node scripts/staging/audit.mjs --after                  # code 0 : 35 appliquées, 13 contrôles « ok »
```

Ensuite :

- réinitialiser le mot de passe de la base (Project settings > Database) ;
- révoquer ou laisser expirer le jeton.

`scripts/staging/postcheck.sql` (13 contrôles, en lecture seule) :

- les migrations 20261105 à 20261108 sont enregistrées ; `audit.mjs --after` exige en plus l'historique complet jusqu'à 20261108 ;
- RLS est active sur les tables du mini-site ;
- le bucket `site-photos` est privé (10 Mo, 4 types d'image), et aucune politique Storage ne l'ouvre ;
- les colonnes `storage.objects` lues par la réconciliation sont présentes ;
- les tables de maintenance des photos existent ;
- le déclencheur bêta est installé ;
- `create_beta_invitation` n'est exécutable ni par `anon` ni par `authenticated` ;
- tout membre d'un établissement existant a l'accès bêta.

**Ne jamais lancer `supabase config push`** vers staging : `config.toml` contient `site_url = http://localhost:3000`. Les réglages Auth se font à la main (§ 4.3) :

- `site_url` à remplacer (aujourd'hui DuckDNS) ;
- mot de passe minimum de 6 à 10 caractères ;
- SMTP à configurer séparément.

## 4. Hébergement de l'application

### 4.1 Choix : Vercel, un projet relié au dépôt

C'est le chemin le plus court : Next.js 16 natif, `sharp` (conversion des photos) supporté sous Linux x64, HTTPS et domaine `*.vercel.app` immédiats, crons intégrés.

- **Plan Pro nécessaire au moment de déployer (aucun abonnement souscrit pour l'instant).** Les crons tournent toutes les 5 et 15 min, alors que Hobby limite les crons à une exécution par jour (le déploiement échoue sinon : à confirmer à la création du projet). Hobby est aussi réservé à l'usage non commercial.
- Branche de production : `main`. Les previews n'ont pas d'accès à la base de staging (variables limitées à Production).
- `vercel.json` (branche `ops/staging-beta`) déclare les deux crons nécessaires. Vercel envoie `Authorization: Bearer $CRON_SECRET`, que les routes vérifient déjà :
  - `/api/cron/site-photos`, toutes les 15 min : nettoyage, purges, conversions expirées, réconciliation du bucket ;
  - `/api/cron/emails`, toutes les 5 min.

  `/api/cron/calendar` n'est pas planifié : Google Agenda n'est pas configuré pour la bêta.

### 4.2 Variables d'environnement (Production uniquement)

| Variable                                | Valeur                                                                       | Secrète             |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`              | `https://osvlzlnwjnmjscpubawa.supabase.co`                                   | non                 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`  | clé publishable (ou anon) du projet                                          | non                 |
| `NEXT_PUBLIC_APP_URL`                   | l'origine publique exacte, ex. `https://<projet>.vercel.app`, sans `/` final | non                 |
| `SUPABASE_SERVICE_ROLE_KEY`             | clé service_role / secret                                                    | **oui** (Sensitive) |
| `CRON_SECRET`                           | `openssl rand -hex 32`                                                       | **oui**             |
| `BOOKING_TRUSTED_INGRESS`               | `vercel` (après fusion de #51)                                               | non                 |
| `EMAIL_TRANSPORT`                       | vide pour la bêta (emails transactionnels gardés dans l'outbox), ou `resend` | non                 |
| `EMAIL_FROM` / `RESEND_API_KEY`         | seulement si `resend`                                                        | clé : **oui**       |
| `DASHBOARD_PREVIEW`                     | **absent** (les pages `/apercu` répondent alors 404)                         | non                 |
| `GOOGLE_CALENDAR_*`, `CALENDAR_TOKEN_*` | absents (l'intégration répond `calendar_not_configured`)                     | —                   |

Les secrets sont saisis par vous dans Vercel (Settings > Environment Variables, type Sensitive), jamais dans le dépôt, un ticket ou un message.

### 4.3 Supabase Auth (tableau de bord du projet staging)

- **URL Configuration :**
  - Site URL : la valeur de `NEXT_PUBLIC_APP_URL` ;
  - Redirect URLs : `<origine>/auth/callback` et `<origine>/auth/callback?**` (le lien de récupération porte `next=/invitation`).
- **Providers > Email :** inscription activée, confirmation d'email activée, longueur minimale du mot de passe à 10 (comme `config.toml`).
- **Email Templates :**
  - « Confirm signup » : le modèle par défaut convient. Il utilise `{{ .ConfirmationURL }}`, qui revient sur `/auth/callback?code=…` (PKCE, même appareil) ;
  - « Reset Password » : sujet « Choisis ton mot de passe », corps copié de `supabase/templates/recovery.html`. Il est indispensable au parcours d'un compte non confirmé préexistant (`/invitation`).
- **SMTP personnalisé : obligatoire** (§ 5, blocage 2).

### 4.4 Stockage des photos

- Le bucket est créé par 20261106. Il n'y a rien à créer à la main, et il ne faut **ajouter aucune politique**.
- Le navigateur envoie directement vers Storage avec une URL signée : pas de limite de corps Vercel. Le serveur convertit avec `sharp` (`maxDuration` 60 s).
- La diffusion publique passe par `/api/sites/photos/…`, avec un cache CDN de 5 min.

## 5. Blocages réels

1. **Réservation publique sur Vercel : option A retenue, PR à relire.** [babso91/booking-saas#51](https://github.com/babso91/booking-saas/pull/51) ajoute `BOOKING_TRUSTED_INGRESS=vercel`.
   - Ce mode lit l'adresse écrite par l'edge de Vercel, seulement avec des preuves de la plateforme : `VERCEL=1`, `x-vercel-id`, et `x-vercel-forwarded-for` égal à `x-real-ip`.
   - Il n'y a aucun proxy à ajouter.
   - Sur Vercel, la variable remplace `BOOKING_PROXY_SECRET`.
   - Après le premier déploiement, il faut faire la vérification en production décrite au contrat § 9.1 bis : la quatrième réservation, avec des en-têtes forgés, doit répondre **429**.
2. **Emails Auth.** Sans SMTP personnalisé, le service d'email de Supabase n'envoie qu'aux adresses des membres de l'équipe du projet, avec un débit très bas. Une professionnelle invitée ne recevrait ni la confirmation ni le lien de récupération.
   - Il faut un SMTP personnalisé (Resend, par exemple), avec un domaine d'envoi vérifié (SPF/DKIM). Le même compte peut servir ensuite à `EMAIL_TRANSPORT=resend`.
   - Il faut ensuite relever « Rate limits > emails » (à environ 30/h).
3. **Plan Free de Supabase.**
   - Il n'y a aucune sauvegarde automatique (d'où la sauvegarde manuelle du § 2).
   - Le projet est mis en pause après une semaine d'inactivité. Pendant la bêta, il faut soit le plan Pro (sauvegardes quotidiennes), soit une sauvegarde manuelle régulière et une surveillance de la pause.
4. **HEIC non validé.** Le serveur refuse `image/heic` et `image/heif` avec un message clair (`site_photo_unsupported`). La conversion par iOS, grâce à l'attribut `accept`, n'a jamais été vérifiée sur un appareil réel (§ 7).

## 6. Plan d'exécution

| #   | Étape                                                                                                                                                   | Qui                      | Externe                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- |
| 1   | Audit `audit.mjs` (fait le 8 nov. : 24/35, verdict STOP attendu sur l'ancienne hypothèse) ; relancer avec le garde-fou à jour : code 0 attendu          | toi                      | lecture seule                   |
| 2   | Les 2 comptes existants sont conservés (identification en cours) ; vérifier si l'application à l'adresse DuckDNS utilise encore staging                 | toi                      | —                               |
| 3   | `backup.sh`, puis sur un projet jetable : `restore.sh` (`RESTORE VERIFIED`) et montée de version 24 → 35 (13 contrôles « true »)                        | toi                      | lecture seule sur staging       |
| 4   | Revue et fusion de #51 (ingress Vercel), CI verte                                                                                                       | équipe, puis Cloud       | 🔒 **fusion**                   |
| 5   | 🔒 `db push` des 11 migrations sur staging, puis `audit.mjs --after` (code 0)                                                                           | toi ou Cloud, sur accord | **migration**                   |
| 6   | 🔒 Auth : `site_url`, URLs de redirection, mot de passe minimum 10, modèle de récupération ; puis SMTP (séparément)                                     | toi                      | config                          |
| 7   | 🔒 Projet Vercel : plan, variables (`EMAIL_TRANSPORT` vide), `vercel.json`, premier déploiement                                                         | toi ou Cloud, sur accord | **déploiement**                 |
| 8   | Fumée : `/`, `/login`, `/b/<inconnu>` en 404, `/apercu` en 404, cron avec secret (200) et sans (401), vérification 429 de l'ingress (contrat § 9.1 bis) | Cloud                    | lecture, 3 réservations de test |
| 9   | 🔒 Première invitation, à une adresse de l'équipe, puis parcours § 7                                                                                    | toi                      | **invitation**                  |
| 10  | Invitations réelles                                                                                                                                     | toi                      | **invitation**                  |

## 7. Parcours de validation

Le parcours se fait sur ordinateur, puis sur iPhone Safari, avec une adresse de l'équipe.

1. **Invitation :**
   - `SUPABASE_URL=https://osvlzlnwjnmjscpubawa.supabase.co SUPABASE_SERVICE_ROLE_KEY=… APP_URL=<origine> node scripts/beta-invite.mjs <adresse> --days 7 --note "essai staging"` (le lien est affiché, rien n'est envoyé) ;
   - le même lien, réutilisé avec une autre adresse, est refusé.
2. **Inscription** par le lien : `/signup?invitation=…`. Une inscription sans lien est refusée (`beta_invitation_required`).
3. **Confirmation de l'email :**
   - l'email arrive (SMTP) ;
   - le lien ouvre `/auth/callback`, puis l'onboarding, **sur le même navigateur** (PKCE) ;
   - noter le comportement si le lien est ouvert dans une autre application.
4. **Onboarding :** établissement créé, `/app` atteint.
5. **Catégorie, puis prestation :**
   - créer, renommer et déplacer une catégorie ;
   - créer une prestation avec une option ;
   - le prix affiché est en euros.
6. **Horaires :** semaine type, plus une exception.
7. **Studio :**
   - choix d'un univers, couleur d'accent sombre : le texte reste lisible en Core ;
   - enregistrement du brouillon ;
   - un second onglet signale le conflit.
8. **Photo :**
   - un JPEG de plus de 5 Mo : conversion et aperçu ;
   - un PNG ;
   - un fichier de plus de 10 Mo est refusé proprement.
9. **Publication :**
   - `/b/<slug>` affiche le site et la photo, en WebP via `/api/sites/photos/…` ;
   - la dépublication et la révocation d'une photo donnent un 404 après le cache de 5 min.
10. **Réservation publique** (nécessite le blocage 1 résolu) :
    - depuis un autre appareil ou réseau : prestation, option, créneau, coordonnées ;
    - confirmation à l'écran, avec le prix et l'heure dans le fuseau de l'établissement ;
    - un renvoi après coupure réseau ne crée pas de doublon.
11. **Agenda :** le rendez-vous apparaît dans `/app/today` et l'agenda, et la fiche cliente est créée.
12. **Crons :**
    - après 15 min, `site_photo_reconciliation_status()` montre un passage terminé ;
    - aucune erreur 500 dans les logs Vercel.

### iPhone Safari : vérifications propres

Chaque cas est noté réussi ou en échec, avec la version d'iOS. Rien n'est déclaré fonctionnel sans ce test.

- **Sélection de photo :**
  - depuis la photothèque, depuis l'appareil photo et depuis Fichiers ;
  - une photo prise en HEIC (réglage « Haute efficacité ») : vérifier si iOS envoie du JPEG ou si le serveur répond `site_photo_unsupported` avec le message guidant.
- **Live Photo :** l'image fixe est envoyée, pas la vidéo.
- **Photo en portrait :** l'orientation est correcte après conversion.
- **HDR et grande taille** (plus de 10 Mo possible) : refus propre si la taille dépasse la limite.
- **Réseau :**
  - mode avion pendant l'envoi d'une photo : erreur claire, puis nouvel essai possible ;
  - même chose pendant une réservation : le renvoi garde la sélection et ne crée pas de doublon ;
  - réseau lent (Réglages développeur, « Network Link Conditioner »).
- **Petits écrans** (iPhone SE, 375 px) :
  - onboarding, Studio, mini-site et réservation : rien de coupé, pas de défilement horizontal ;
  - le clavier ne masque pas les boutons ;
  - le code à usage unique est proposé par le clavier.
- **Retour arrière, puis avant** dans Safari (bfcache) pendant la réservation.
- **Au moins deux versions d'iOS** si possible.
