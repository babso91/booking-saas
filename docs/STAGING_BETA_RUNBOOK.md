# Mise en service de la bêta privée sur staging

Base : `main` @ `1965f8a`. Projet Supabase `booking-saas-staging` (`osvlzlnwjnmjscpubawa`). Ce document décrit **quoi faire et dans quel ordre**. Chaque étape marquée 🔒 est une opération externe qui attend un accord explicite.

## 0. Préparer la copie de travail (sans toucher à `main`)

Les scripts sont sur `ops/staging-beta`, une branche partie de `main` @ `1965f8a` avec des migrations identiques. On l'ouvre dans un **dossier séparé** : la copie de `main` n'est pas touchée, et rien n'est fusionné.

```bash
git fetch origin
git worktree add ../booking-saas-ops origin/ops/staging-beta   # dossier séparé, sans branche locale
cd ../booking-saas-ops
```

`audit.mjs` vérifie de lui-même que `supabase/migrations` est identique à `1965f8a`, et s'arrête sinon. Node 20 ou plus suffit pour l'audit. Pour la sauvegarde, `npm ci` est nécessaire (CLI Supabase du dépôt, 2.118.0) ainsi que `psql` (client PostgreSQL 17).

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

**Pour continuer (code de sortie 0) :**

- dernière version hébergée `20261103090000`, aucune version « remote only », aucun trou ;
- migrations en attente, exactement dans cet ordre :
  1. `20261105090000_site_publishing.sql`
  2. `20261106090000_site_photos.sql`
  3. `20261107090000_beta_invitations.sql`
  4. `20261108090000_category_move.sql`
- `storage.objects columns for 20261106: present`.

**Sinon (code 2) : arrêt.** Version présente seulement à distance, trou ou autre ordre : on analyse avant tout `migration repair` ou `--include-all`. Aucune réparation automatique.

**Comptes existants.** La migration 20261107 donne l'accès bêta à **tous** les comptes présents au moment où elle tourne (`source = 'existing'`). Le résumé les compte. `accounts.local.json` les liste, pour que tu décides, compte par compte : garder ou supprimer. **Aucun compte n'est supprimé** sans cette décision explicite, et aucun script ne supprime quoi que ce soit.

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

- **Fichiers Storage :** un dump SQL n'en contient pas. Le script **s'arrête** si l'index compte des fichiers. On s'attend à 0, puisque le bucket `site-photos` n'existe qu'après 20261106. S'il y en avait : `npx supabase storage cp -r ss:///<bucket> backups/…/storage --experimental --linked` avant de continuer.
- **Réglages Auth et modèles d'email :** l'instantané non secret est dans `auth.json` (audit). Les secrets (mot de passe SMTP, clés d'API) ne sont jamais exportés : ils se ressaisissent.
- **Vault :** non utilisé (0 secret, aucune migration n'y fait référence).
- **Deux tables internes de Storage** (`buckets_vectors`, `vector_indexes`) : elles appartiennent à la plateforme, sont inutilisées, et `postgres` ne peut pas y écrire. Leur vide est contrôlé par l'empreinte.

> **Piège évité (constaté à la répétition).** `pg_dump` écrit les droits par rapport aux défauts de PostgreSQL, pas à ceux d'un projet Supabase neuf, qui accordent `EXECUTE` et l'accès aux tables à `anon` et `authenticated`. Restaurée telle quelle, la base avait **198 droits différents** : `create_beta_invitation`, réservée au service, devenait exécutable par `anon`. `acl.sql` retire d'abord tout aux rôles de l'API, puis rend exactement les droits de la source, droits par défaut de `postgres` compris. Après restauration, les droits sont identiques (345 objets), et l'appel anonyme à `create_beta_invitation` est refusé (`permission denied`).

Ce dossier contient des données personnelles et des secrets. Il reste sur ta machine (mode 700), ne va jamais dans le dépôt, un disque partagé ou un message, et est supprimé après la bêta.

### 2.2 Sauvegarder

```bash
npm ci
export SUPABASE_ACCESS_TOKEN=…     # le même jeton en lecture seule
export SUPABASE_DB_PASSWORD=…      # Project settings > Database ; pg_dump en a besoin
scripts/staging/backup.sh
```

Seule la lecture se fait sur staging : `pg_dump` via la CLI, puis des `SELECT` via l'API en lecture seule. Le mot de passe de la base n'est utilisé que par `pg_dump`. Il reste dans le terminal, n'est jamais dans un fichier ni dans le chat, et on peut le **réinitialiser après la sauvegarde** (Project settings > Database > Reset password).

À lancer quand personne n'écrit sur staging (c'est le cas : aucune application n'y est branchée). L'empreinte est prise juste après le dump.

### 2.3 Restaurer sur un projet jetable, puis vérifier (obligatoire avant de migrer)

1. Créer un projet Supabase **jetable** (gratuit, même région, même version Postgres 17), vide.
2. Restaurer et vérifier :

   ```bash
   export TARGET_DB_URL='postgresql://postgres:<mdp du projet jetable>@db.<ref jetable>.supabase.co:5432/postgres'
   scripts/staging/restore.sh backups/staging-<horodatage>
   ```

   `restore.sh` :

   - contrôle les sommes SHA-256 ;
   - **refuse** une cible qui serait le projet staging, ou une cible non vide ;
   - restaure en **une seule transaction** : rôles (sans les droits propres à la plateforme), schémas, historique, données (contraintes différées), puis les droits ;
   - lance `verify-restore.sh`, qui compare table par table les lignes et le md5, historique compris, ainsi que les droits normalisés.

3. Attendu : `data: identical`, `privileges: identical`, `RESTORE VERIFIED`.
4. Contrôle fonctionnel :
   - se connecter avec un compte de test sur le projet jetable (Auth > Users, ou l'API) ;
   - appeler une fonction publique (`get_public_business`) en anonyme : 200 ;
   - appeler `create_beta_invitation` en anonyme : refusé.
5. Supprimer le projet jetable.

**Répétition faite en local** (stack source avec 30 comptes, 397 établissements et 403 rendez-vous, puis une stack vierge comme cible) :

- `backup.sh`, puis `restore.sh` : 87 tables identiques (dont les 35 versions de l'historique), 345 droits identiques, `RESTORE VERIFIED` ;
- connexion avec le mot de passe d'un compte restauré : OK, et un mauvais mot de passe est refusé ;
- RPC publique : 200 ; `create_beta_invitation` en anonyme : `permission denied` ;
- **tests négatifs :** une ligne modifiée donne `DATA DIFFERS`, et un `EXECUTE` accordé à `anon` donne `PRIVILEGES DIFFER`. La vérification détecte donc bien un écart.

Ce qui reste à prouver sur l'hébergé : la même répétition sur un projet jetable Supabase (étape 2 ci-dessus).

### 2.4 Pourquoi le risque est limité

Les quatre migrations sont **additives** : nouvelles tables et fonctions, un bucket, un déclencheur sur `businesses`. Le seul remplissage est `beta_access` pour les comptes existants. Elles ne suppriment ni ne réécrivent aucune donnée existante.

La CI rejoue toutes les migrations depuis zéro, puis la montée de version sur des données (« Migrations and upgrade », vert sur `1965f8a`).

Chaque migration est transactionnelle : un échec ne laisse rien de partiel. En cas d'échec, on **arrête et on analyse** ; restaurer n'est pas nécessaire.

## 3. 🔒 Migration de staging (après accord)

Cette étape écrit : elle demande un accès en écriture, accordé seulement pour elle.

```bash
node scripts/staging/audit.mjs                       # rien n'a bougé depuis l'audit (code 0)
npx --no-install supabase link --project-ref osvlzlnwjnmjscpubawa
npx --no-install supabase db push --linked --dry-run  # exactement les 4 migrations
npx --no-install supabase db push --linked            # 🔒 applique 20261105 → 20261108
node scripts/staging/audit.mjs --after                # postcheck : 13 lignes « ok »
```

Ensuite :

- révoquer le jeton d'écriture, s'il en a fallu un ;
- réinitialiser le mot de passe de la base, s'il a été utilisé.

`scripts/staging/postcheck.sql` (13 contrôles, vérifiés en local, en lecture seule) :

- les 4 versions sont enregistrées, sans version postérieure inconnue ;
- RLS est active sur les tables du mini-site ;
- le bucket `site-photos` est privé (10 Mo, 4 types d'image), et aucune politique Storage ne l'ouvre ;
- les colonnes `storage.objects` lues par la réconciliation sont présentes ;
- les tables de maintenance des photos existent ;
- le déclencheur bêta est installé ;
- `create_beta_invitation` n'est exécutable ni par `anon` ni par `authenticated` ;
- tout membre d'un établissement existant a l'accès bêta.

**Ne jamais lancer `supabase config push`** vers staging : `config.toml` contient `site_url = http://localhost:3000`. Les réglages Auth se font à la main (§ 4.3).

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
| 1   | Jeton à droits restreints, puis `audit.mjs` ; transmettre `summary.txt`                                                                                 | toi                      | lecture seule                   |
| 2   | Décision compte par compte (`accounts.local.json`) : garder ou supprimer                                                                                | toi                      | —                               |
| 3   | `backup.sh`, puis `restore.sh` sur un projet jetable : `RESTORE VERIFIED`                                                                               | toi                      | lecture seule sur staging       |
| 4   | Revue et fusion de #51 (ingress Vercel), CI verte                                                                                                       | équipe, puis Cloud       | 🔒 **fusion**                   |
| 5   | 🔒 `db push`, puis `audit.mjs --after` (13 « ok »)                                                                                                      | toi ou Cloud, sur accord | **migration**                   |
| 6   | 🔒 Auth : URLs, modèle de récupération, puis SMTP (séparément)                                                                                          | toi                      | config                          |
| 7   | 🔒 Projet Vercel : plan, variables, `vercel.json`, premier déploiement                                                                                  | toi ou Cloud, sur accord | **déploiement**                 |
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
