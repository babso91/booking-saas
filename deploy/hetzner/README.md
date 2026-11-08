# Booking SaaS sur Hetzner : mise en service

Serveur `178.104.91.44`, domaine `booking-saas-staging.duckdns.org`, servi par Caddy (authentification Basic). La base est le projet Supabase `booking-saas-staging` (`osvlzlnwjnmjscpubawa`).

**Règles :**

- les services Luminys et les composants partagés (Caddy, réseaux Docker) ne sont jamais arrêtés ;
- seul le conteneur Booking SaaS est remplacé ;
- Caddy est **rechargé**, jamais redémarré : le rechargement est sans coupure, et la nouvelle configuration est validée avant ;
- aucune suppression de données, aucun email réel tant que l'envoi n'est pas validé.

## Fichiers

| Fichier                    | Rôle                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile` (racine)      | image de production : serveur Next.js autonome (standalone), Node 24, utilisateur non root, `HEALTHCHECK` sur `/api/health`                                                                                                           |
| `compose.yml`              | projet compose **séparé** `booking-saas` : aucun port publié, réseau de Caddy, système de fichiers en lecture seule, plafonds mémoire et CPU                                                                                          |
| `Caddyfile.booking`        | bloc du site, à fusionner dans le Caddyfile existant : ingress de confiance (`header_up X-Booking-Client-Ip {remote_host}` et `X-Booking-Proxy-Secret`), authentification Basic conservée côté professionnel, chemins publics ouverts |
| `booking-saas.env.example` | variables d'exécution (noms seulement) ; les valeurs n'existent que sur le serveur                                                                                                                                                    |
| `inventory.sh`             | inventaire du serveur en **lecture seule**, secrets masqués                                                                                                                                                                           |

L'hébergement Hetzner utilise le mode d'ingress `proxy` par défaut, avec Caddy : la PR #51 (mode Vercel) n'est pas nécessaire ici.

## Répétition locale (8 nov. 2026)

Image construite depuis cette branche, lancée derrière un vrai Caddy 2 configuré avec `Caddyfile.booking`, sur une base à 35 migrations :

- **Sans mot de passe :** les pages professionnelles répondent 401. Restent accessibles le mini-site public, la disponibilité, la réservation, `/api/health` et les crons, qui ont leur propre secret.
- **Réservation à travers Caddy, avec `X-Booking-Client-Ip`, `X-Booking-Proxy-Secret` et `X-Forwarded-For` forgés à chaque requête :** Caddy les remplace, la limite par réseau s'applique (3 acceptées, puis **429**), et les adresses forgées sont ignorées.
- **Réservation envoyée directement au conteneur, en contournant Caddy :** `booking_unavailable` (503), sans écriture.
- **Crons :** 401 sans secret, 200 avec. `/apercu` répond 404.
- **Navigateur** (Chromium, écran de téléphone) : connexion, agenda, catalogue, horaires, Studio, clientes, puis mini-site public sans mot de passe. Aucune erreur de console ni réponse 5xx.

## Déroulé de la bascule

**Point de non-retour : l'étape 4.** L'ancienne application ne fonctionne plus une fois les 11 migrations appliquées. Tout ce qui peut l'être est donc préparé et vérifié **avant** : image construite, configuration validée, secrets en place.

0. **Préparation**, sans interruption :
   - inventaire (`inventory.sh`) ;
   - dossier `/opt/booking-saas` (compose, `booking-saas.env` en mode 600) ;
   - image construite et étiquetée ;
   - l'image de l'ancien conteneur est conservée, étiquetée `booking-saas:before-cutover` ;
   - le nouveau bloc Caddy est préparé et validé (`caddy validate`), sans rechargement.
1. **Maintenance :** arrêt du seul ancien conteneur Booking SaaS (`docker stop`). Caddy répond 502 sur ce domaine uniquement ; Luminys n'est pas touché.
2. **Sauvegarde fraîche** depuis le Mac (`scripts/staging/backup.sh`, branche `ops/staging-beta`), base au repos.
3. **Audit :** `node scripts/staging/audit.mjs` doit répondre code 0 (24 migrations, les 11 attendues).
4. **Migrations :**
   - `supabase db push --db-url … --dry-run` doit lister les 11 ;
   - puis `db push` ;
   - puis `audit.mjs --after` doit répondre code 0 (35 migrations, 13/13).
5. **Auth (tableau de bord Supabase) :**
   - Site URL `https://booking-saas-staging.duckdns.org` ;
   - Redirect URLs `…/auth/callback` et `…/auth/callback?**` ;
   - mot de passe minimum 10 caractères ;
   - modèle « Reset Password ».
6. **Nouvelle application :** `docker compose -p booking-saas up -d`, puis le bloc Caddy (`caddy validate`, puis `caddy reload`).
7. **Contrôles réels :**
   - santé, et 401 sans mot de passe ;
   - test 429 de l'ingress ;
   - connexion des 2 comptes existants, agenda, catalogue, horaires, Studio, publication d'un mini-site ;
   - réservation publique depuis un téléphone ;
   - crons appelés une fois à la main (401 sans secret, 200 avec).
8. **Planification des crons** sur l'hôte (minuteur systemd ou crontab) :
   - `/api/cron/site-photos` toutes les 15 min ;
   - `/api/cron/emails` toutes les 5 min (sans effet tant que `EMAIL_TRANSPORT` est vide).

**Retour arrière :**

- **avant l'étape 4 :** `docker start` de l'ancien conteneur ; rien d'autre n'a changé ;
- **après l'étape 4 :** on corrige en avant. La sauvegarde de l'étape 2 reste restaurable dans un nouveau projet, comme répété (`RESTORE VERIFIED`), mais l'ancienne application ne fonctionne qu'avec l'ancien schéma.
