# Booking SaaS sur Hetzner : mise en service

## Le serveur tel qu'il est (inventaire du 8 nov. 2026, lecture seule)

**Machine :** CX33, Ubuntu 24.04, 7,6 Go de RAM (5,8 Go libres), disque à 19 %. Accès SSH `vps-luminys` (root, par clé), réservé à l'adresse IP de Babere. Seuls les ports 22, 80 et 443 sont ouverts (pare-feu Hetzner et UFW).

**`/opt/luminys`** (projet compose `luminys`) :

- `caddy` est **le seul** à publier 80 et 443. Son Caddyfile est `/opt/luminys/Caddyfile`, avec les blocs `n8n.`, `stats.` puis `booking-saas-staging`.
- Caddy est relié au réseau externe `booking-saas-staging-proxy` (déclaré dans `compose.caddy.yml`).
- Les autres services sont n8n et n8n-postgres, plausible, plausible_db et clickhouse.

**`/opt/booking-saas-staging`** (projet compose `booking-saas-staging`) :

- `app` : image `booking-saas-staging:b35b6e0…`, ancienne version, utilise Supabase staging ;
- `mailpit` ;
- `email-hook`.

**Bloc Caddy actuel :** authentification Basic sur tout, sauf `/staging/auth-email`. C'est le hook d'emails Auth de Supabase, signé en HMAC, qui dépose les emails dans Mailpit. Mailpit est servi sous `/mailpit/*`.

## Principes

- **On ne touche ni à Luminys ni à Caddy en tant que service.** Seul le bloc `booking-saas-staging` du Caddyfile change. Les blocs `n8n.` et `stats.` restent identiques octet pour octet (contrôle par `diff`). On valide (`caddy validate`), puis on fait un `caddy reload` dans le conteneur existant : jamais de `restart`, ni de `up` du projet `luminys`.
- **Dans le projet `booking-saas-staging`, seul le service `app` est remplacé.** `mailpit` et `email-hook` ne bougent pas ; le chemin `/staging/auth-email` et `/mailpit/*` restent servis comme aujourd'hui.
- **Les emails Auth continuent d'aller dans Mailpit** (rien ne part vers de vraies boîtes). `EMAIL_TRANSPORT` reste vide, donc les emails transactionnels restent dans l'outbox.
- **Aucune suppression :**
  - l'ancienne image est conservée et étiquetée `booking-saas-staging:before-cutover` ;
  - les fichiers modifiés sont d'abord copiés en `*.before-cutover` ;
  - une sauvegarde fraîche de la base est faite avant les migrations.

## Fichiers de cette branche

| Fichier                    | Rôle                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Dockerfile` (racine)      | image de production : serveur Next.js autonome (standalone), Node 24, utilisateur non root, `HEALTHCHECK` |
| `Caddyfile.booking`        | **référence** des ajouts au bloc existant : en-têtes de l'ingress, chemins publics                        |
| `compose.yml`              | **référence** des réglages du service `app` (lecture seule, aucun port, plafonds)                         |
| `booking-saas.env.example` | noms des variables d'exécution                                                                            |
| `inventory.sh`             | inventaire en lecture seule, secrets masqués                                                              |

L'ingress de confiance est Caddy, en mode `proxy` par défaut : la PR #51 (mode Vercel) n'est pas nécessaire ici.

## Répétition locale (8 nov. 2026)

Image construite depuis cette branche, derrière un vrai Caddy 2 avec ces en-têtes, sur une base à 35 migrations :

- en-têtes `X-Booking-Client-Ip`, `X-Booking-Proxy-Secret` et `X-Forwarded-For` forgés : ignorés, la limite par réseau s'applique (3 réservations, puis 429) ;
- accès direct au conteneur : 503, sans écriture ;
- crons : 401 sans secret, 200 avec ; `/apercu` en 404 ;
- navigateur (Chromium, écran de téléphone) : connexion, agenda, catalogue, horaires, Studio, clientes et mini-site public, sans aucune erreur.

## Déroulé

### A. Préparation (sans interruption ; l'ancienne application continue de tourner)

1. **Lecture seule :**
   - fichier compose de `/opt/booking-saas-staging` et bloc Caddy `booking-saas-staging`, secrets masqués ;
   - noms des variables de `app` ;
   - origine de l'image actuelle ;
   - version de Caddy (`basic_auth` ou `basicauth`).
2. **Code sur le serveur**, sans dépôt git ni jeton :

   ```bash
   git archive <sha> | ssh vps-luminys "mkdir -p /opt/booking-saas-staging/src-<sha> && tar -x -C /opt/booking-saas-staging/src-<sha>"
   ```

3. **Image construite sur le serveur, en basse priorité :**
   - `nice -n 19 ionice -c3 docker build -t booking-saas-staging:<sha> …` ;
   - les `NEXT_PUBLIC_*` sont lus dans l'environnement actuel de `app`, côté serveur ;
   - l'ancienne image est étiquetée `booking-saas-staging:before-cutover`.
4. **Environnement de la nouvelle application**, écrit **sur le serveur** (fichier en mode 600) :
   - reprend l'URL et les clés Supabase de l'environnement actuel ;
   - crée `CRON_SECRET` et `BOOKING_PROXY_SECRET` avec `openssl rand -hex 32` ;
   - aucune valeur ne transite par un chat ni par git.
5. **Fichiers préparés à côté, sans les activer :**
   - le compose (service `app` sur la nouvelle image, plus un service `cron`, qui appelle `app` par le réseau interne avec `CRON_SECRET` : photos toutes les 15 min, emails toutes les 5 min, ces derniers sans effet tant que `EMAIL_TRANSPORT` est vide) ;
   - le Caddyfile, validé avec `caddy validate` en lisant la copie, et dont les blocs `n8n.` et `stats.` sont vérifiés identiques par `diff`.

### B. Fenêtre de bascule (environ 15 minutes)

Seul le domaine `booking-saas-staging` est concerné ; Luminys n'est pas touché.

1. **Maintenance :** `docker compose stop app` dans `/opt/booking-saas-staging`. Caddy répond 502 sur ce seul domaine.
2. **Sauvegarde fraîche** depuis le Mac (`backup.sh`), base au repos.
3. **`audit.mjs` : code 0** (24 migrations, les 11 attendues).
4. 🔒 **Migrations :**
   - `supabase db push --dry-run` doit lister les 11 ;
   - puis `db push` ;
   - puis `audit.mjs --after` doit répondre code 0 (35 migrations, 13/13 contrôles).
5. **Auth (tableau de bord Supabase) :**
   - mot de passe minimum 10 caractères ;
   - modèle « Reset Password » ;
   - Site URL et redirections `https://booking-saas-staging.duckdns.org/auth/callback` à vérifier ;
   - le hook d'emails reste inchangé.
6. **Mise en service :**
   - nouveau compose activé, puis `docker compose up -d app cron` : seuls ces deux services sont touchés ;
   - nouveau Caddyfile en place, puis `caddy reload`.
7. **Contrôles réels :**
   - `n8n.` et `stats.` répondent comme avant ;
   - santé, et 401 sans mot de passe ;
   - test 429 de l'ingress ;
   - connexion des 2 comptes existants, agenda, catalogue, horaires, Studio, publication d'un mini-site ;
   - réservation publique depuis un téléphone ;
   - crons (journal du service `cron`) ;
   - emails Auth visibles dans Mailpit.

### Retour arrière

- **Avant B4 :**
  - remettre les fichiers `*.before-cutover` ;
  - `docker compose up -d app` sur l'image `before-cutover` ;
  - `caddy reload`.

  Rien d'autre n'a changé.

- **Après B4 :** l'ancienne application ne fonctionne qu'avec l'ancien schéma. On corrige en avant. La sauvegarde de B2 reste restaurable dans un nouveau projet (répété : `RESTORE VERIFIED`).
