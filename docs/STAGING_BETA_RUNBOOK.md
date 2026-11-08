# Mise en service de la bêta privée sur staging

Base : `main` @ `1965f8a`. Projet Supabase `booking-saas-staging` (`osvlzlnwjnmjscpubawa`). Ce document décrit **quoi faire et dans quel ordre**. Chaque étape marquée 🔒 est une opération externe qui attend un accord explicite.

## 0. Ce qui n'a pas pu être vérifié depuis la session

Sans jeton Supabase, l'état réel de la base hébergée n'a pas été lu. Il faut d'abord lancer l'audit en lecture seule (étape 1), qui remplace toute supposition.

## 1. Audit en lecture seule

```bash
git checkout main && git pull            # 1965f8a ou plus récent
npm ci
export SUPABASE_ACCESS_TOKEN=…           # jeton dédié, à révoquer après la bêta
export SUPABASE_DB_PASSWORD=…            # Project settings > Database
scripts/staging/preflight.sh
```

Le script n'écrit rien à distance : `migration list`, `db push --dry-run`, et un `SELECT` de comptage (`scripts/staging/inventory.sql`, aucune donnée personnelle). Résultats dans `backups/staging-audit-*/` (ignoré par git).

**Attendu pour continuer :**

- l'historique hébergé s'arrête à `20261103090000_service_catalog`, sans version inconnue du dépôt ;
- le dry run liste exactement, dans cet ordre :
  1. `20261105090000_site_publishing.sql`
  2. `20261106090000_site_photos.sql`
  3. `20261107090000_beta_invitations.sql`
  4. `20261108090000_category_move.sql`
- `storage_column` liste `archived_at` et `is_delete_marker` (lus par la réconciliation des photos, 20261106).

**Sinon : arrêt.** Version présente seulement à distance, trou dans l'historique, ordre différent : on analyse avant tout `migration repair` ou `--include-all`. Aucune réparation automatique.

**À lire dans l'inventaire :**

- `auth.users` : chaque compte existant au moment de la migration 20261107 reçoit l'accès bêta (`source = 'existing'`). Les comptes de test présents aujourd'hui garderont donc l'accès. Si certains ne doivent pas l'avoir, il faut les supprimer **avant** la migration (décision à prendre).
- `storage.objects` : s'il n'est pas à 0, ces fichiers ne sont pas dans un dump SQL (étape 2).

## 2. Sauvegarde et retour arrière

Le tableau de bord indique « No backups » : c'est le cas du plan Free (aucune sauvegarde automatique ni PITR). On ne compte donc que sur une sauvegarde logique faite par nous.

### 2.1 Sauvegarder (avant toute migration)

```bash
scripts/staging/backup.sh
```

Le script produit `roles.sql`, `schema.sql`, `data.sql` (COPY), `migration-list.txt` et `SHA256SUMS` dans `backups/staging-<horodatage>/` (`umask 077`, ignoré par git). Il échoue si un dump est vide. Les commandes ont été vérifiées sur la base locale.

Ces fichiers contiennent des données (comptes Auth compris). Ils ne vont ni dans le dépôt ni sur un disque partagé, et sont supprimés après la bêta.

**Fichiers Storage :** si l'inventaire compte des objets, il faut les télécharger à part. Le bucket `site-photos` n'existe pas avant 20261106, donc on s'attend à 0.

### 2.2 Restaurer (procédure Supabase, sur décision)

La restauration se fait de préférence dans un **nouveau** projet vide, pour ne pas mélanger deux états :

```bash
psql --single-transaction -v ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "postgresql://postgres:<mdp>@db.<nouveau-ref>.supabase.co:5432/postgres"
```

Ensuite, on pointe les variables de l'application vers ce projet.

### 2.3 Répétition (recommandée, 15 min)

Restaurer la sauvegarde dans un projet jetable et y relancer `inventory.sql` : les comptages doivent être identiques. La restauration n'est pas prouvée tant qu'on ne l'a pas faite une fois.

### 2.4 Pourquoi le risque est limité

Les quatre migrations sont **additives** : nouvelles tables et fonctions, un bucket, un déclencheur sur `businesses`. Le seul remplissage est `beta_access` pour les comptes existants. Elles ne suppriment ni ne réécrivent aucune donnée existante.

La CI rejoue toutes les migrations depuis zéro, puis rejoue la montée de version sur des données (job « Migrations and upgrade », vert sur `1965f8a`).

Chaque migration est transactionnelle : un échec au milieu ne laisse rien de partiel de cette migration. En cas d'échec, l'action est donc d'**arrêter et d'analyser**, pas de restaurer.

## 3. 🔒 Migration de staging

```bash
scripts/staging/preflight.sh                       # rien n'a bougé depuis l'audit
npx --no-install supabase db push --linked          # applique 20261105 → 20261108
scripts/staging/preflight.sh --after                # postcheck : chaque ligne ok = t
```

`scripts/staging/postcheck.sql` (13 contrôles, vérifiés en local) :

- les 4 versions sont enregistrées, et aucune version postérieure inconnue ;
- RLS est active sur les tables du mini-site ;
- le bucket `site-photos` est privé (10 Mo, 4 types d'image), et aucune politique Storage ne l'ouvre ;
- les colonnes `storage.objects` dont dépend la réconciliation sont présentes ;
- les tables de maintenance des photos existent ;
- le déclencheur bêta est installé ;
- `create_beta_invitation` n'est pas exécutable par `anon` ni `authenticated` ;
- tout membre d'un établissement existant a l'accès bêta.

**Ne jamais lancer `supabase config push`** vers staging : `config.toml` contient `site_url = http://localhost:3000`. La configuration Auth se fait à la main (§ 4.3).

## 4. Hébergement de l'application

### 4.1 Choix : Vercel, un projet relié au dépôt

C'est le chemin le plus court : Next.js 16 natif, `sharp` (conversion des photos) supporté sous Linux x64, HTTPS et domaine `*.vercel.app` immédiats, crons intégrés.

- **Plan Pro requis.** Les crons tournent toutes les 5 et 15 min, alors que Hobby limite les crons à une exécution par jour (le déploiement échoue sinon : à confirmer à la création du projet). Hobby est aussi réservé à l'usage non commercial.
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
| `BOOKING_PROXY_SECRET`                  | voir § 5, blocage 1                                                          | **oui**             |
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

1. **Réservation publique sur Vercel (bloquant pour « recevoir des réservations »).**
   - `POST /api/bookings` exige l'en-tête `x-booking-client-ip`, prouvé par `x-booking-proxy-secret`, posé par un reverse proxy de confiance. Sans cela, la réponse est 503 `booking_unavailable`, sans aucune écriture : c'est l'échec fermé voulu.
   - Vercel ne pose pas ces en-têtes. En revanche, Vercel **écrase** `x-forwarded-for` / `x-real-ip` / `x-vercel-forwarded-for` avec l'adresse réelle du client (documentation Vercel, « Request headers »).
   - Deux options :
     - **A (recommandée, petit changement de code) :** un mode d'ingress explicite `BOOKING_TRUSTED_INGRESS=vercel`, actif seulement si `VERCEL=1`. Il lit `x-vercel-forwarded-for`, avec la même validation stricte d'une seule IP littérale. Il faut des tests, la mise à jour du contrat § 9.1, puis une PR à faire relire. Sans cette variable, le comportement reste identique à aujourd'hui.
     - **B :** un reverse proxy à nous (Caddy ou nginx, ou Cloudflare) devant Vercel. Cela ajoute une brique à héberger et à sécuriser : plus lourd pour une bêta.
2. **Emails Auth.** Sans SMTP personnalisé, le service d'email de Supabase n'envoie qu'aux adresses des membres de l'équipe du projet, avec un débit très bas. Une professionnelle invitée ne recevrait ni la confirmation ni le lien de récupération.
   - Il faut un SMTP personnalisé (Resend, par exemple), avec un domaine d'envoi vérifié (SPF/DKIM). Le même compte peut servir ensuite à `EMAIL_TRANSPORT=resend`.
   - Il faut ensuite relever « Rate limits > emails » (à environ 30/h).
3. **Plan Free de Supabase.**
   - Il n'y a aucune sauvegarde automatique (d'où la sauvegarde manuelle du § 2).
   - Le projet est mis en pause après une semaine d'inactivité. Pendant la bêta, il faut soit le plan Pro (sauvegardes quotidiennes), soit une sauvegarde manuelle régulière et une surveillance de la pause.
4. **HEIC non validé.** Le serveur refuse `image/heic` et `image/heif` avec un message clair (`site_photo_unsupported`). La conversion par iOS, grâce à l'attribut `accept`, n'a jamais été vérifiée sur un appareil réel (§ 7).

## 6. Plan d'exécution

| #   | Étape                                                                                                                           | Qui                       | Externe         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- |
| 1   | Audit `preflight.sh`, résultat transmis                                                                                         | vous                      | lecture seule   |
| 2   | Décision sur les comptes existants (accès bêta hérité)                                                                          | vous                      | —               |
| 3   | `backup.sh` + répétition de restauration                                                                                        | vous                      | lecture seule   |
| 4   | Décisions : option A ou B (réservations), SMTP, plans Vercel et Supabase                                                        | vous                      | —               |
| 5   | Si option A : PR du mode d'ingress Vercel, CI verte, revue                                                                      | Cloud                     | —               |
| 6   | 🔒 `db push` puis `preflight.sh --after`                                                                                        | vous ou Cloud, sur accord | **migration**   |
| 7   | 🔒 Auth : URLs, modèle de récupération, SMTP                                                                                    | vous                      | config          |
| 8   | 🔒 Projet Vercel : variables, `vercel.json`, premier déploiement                                                                | vous ou Cloud, sur accord | **déploiement** |
| 9   | Fumée : `/`, `/login`, `/b/<slug>` en 404, `/apercu` en 404, cron appelé à la main avec le secret (200), cron sans secret (401) | Cloud                     | lecture         |
| 10  | 🔒 Première invitation, à une adresse de l'équipe, puis parcours § 7                                                            | vous                      | **invitation**  |
| 11  | Invitations réelles                                                                                                             | vous                      | **invitation**  |

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
