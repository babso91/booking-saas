# Contrat — intégration calendrier (V1 : Google → Booking)

Ce document décrit le backend de l'intégration calendrier livré par la migration `20261003090000_calendar_inbound_sync.sql`. Il sert de contrat à la future UI et au déploiement.

## Principes

- **Booking SaaS reste la source de vérité des rendez-vous clientes.** Google ne crée, ne déplace et n'annule jamais un rendez-vous Booking.
- **Google est la source de vérité des événements personnels** de la professionnelle. Les périodes occupées des calendriers qu'elle sélectionne sont copiées localement (`external_calendar_events`) et bloquent la disponibilité publique.
- **Aucun appel à Google pendant une consultation ou une réservation.** La disponibilité et la transaction de réservation lisent uniquement la copie locale, indexée, dans PostgreSQL.
- **PostgreSQL reste l'autorité temporelle.** Les dates des événements « journée entière » sont converties par `private.local_day_start` dans le fuseau du calendrier. Les `dateTime` avec décalage explicite sont gardés tels quels, jamais reconstruits depuis l'heure murale.
- **Booking → Google (miroir des rendez-vous) n'est pas implémenté.** Il fera l'objet de la PR suivante (voir « Évolutions »).

## Modèle de données

| Table                            | Contenu                                                                                                                                                                                                                             | Accès                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `calendar_connections`           | Un compte par fournisseur et par business : `provider`, compte (`provider_account_id`, `account_email`), `status` (`active`, `reauth_required`, `disconnected`), `scopes`, `last_synced_at`, `last_error` (code stable), `version`. | Lecture par les membres (RLS), sauf `provider_account_id` et `connected_by`. Aucune écriture directe. |
| `private.calendar_secrets`       | Refresh token et access token **chiffrés** (AES‑256‑GCM, clé uniquement dans l'environnement serveur).                                                                                                                              | Aucun rôle d'API ; seulement les fonctions `security definer` réservées au `service_role`.            |
| `external_calendars`             | Calendriers visibles du compte : nom, fuseau, `is_primary`, `access_role`, `selected_for_blocking`, `sync_status` (`idle`, `pending`, `error`), `last_synced_at`, `last_error`.                                                     | Lecture par les membres. La sélection passe par `calendar_set_blocking`.                              |
| `private.external_calendar_sync` | Curseur de sync (`sync_token`), génération, fenêtre, full sync en cours (page, génération), bail du worker, canal push (id, ressource, **hash** du token, expiration).                                                              | Aucun rôle d'API.                                                                                     |
| `external_calendar_events`       | Périodes des calendriers sélectionnés : instants UTC `[starts_at, ends_at)`, `all_day`, `busy`, identifiants fournisseur (événement, série), `etag`, `updated`, génération. Aucun titre, aucune description, aucun participant.     | Lecture par les membres (instants seulement).                                                         |
| `private.calendar_oauth_states`  | États OAuth : **hash** du `state`, utilisateur, business, vérificateur PKCE chiffré, expiration à 10 minutes.                                                                                                                       | Aucun rôle d'API.                                                                                     |

Index : `gist (business_id, busy_window) where busy` pour le chevauchement. La disponibilité l'utilise en _Index Only Scan_.

## Stockage des secrets

- **Chiffrement.** AES‑256‑GCM (`src/lib/crypto/secret-box.ts`), IV aléatoire de 96 bits. Les données associées lient le chiffré à son propriétaire : `calendar-token:<provider>:<business_id>` pour les tokens, `oauth-verifier:<hash du state>` pour le vérificateur PKCE. Un chiffré copié vers un autre business ne se déchiffre pas.
- **Clé.** `CALENDAR_TOKEN_ENCRYPTION_KEY` : 32 octets en base64, présente uniquement dans l'environnement serveur. La base ne voit que du chiffré.
- **Rotation.**
  1. Mettre la nouvelle clé dans `CALENDAR_TOKEN_ENCRYPTION_KEY`.
  2. Déplacer l'ancienne dans `CALENDAR_TOKEN_PREVIOUS_KEYS` (liste séparée par des virgules). Chaque chiffré porte l'identifiant de sa clé, ce qui permet de le déchiffrer avec l'ancienne.
  3. Attendre que chaque access token soit réécrit, ce qui arrive à chaque rafraîchissement, environ toutes les heures. Les refresh tokens ne sont réécrits qu'à la reconnexion.
  4. Retirer l'ancienne clé une fois tous les secrets réécrits.
- **Ce qui ne contient jamais de token ni de secret :**
  - les logs ;
  - les DTO ;
  - les URL ;
  - les variables `NEXT_PUBLIC_*`.

  Les tokens de canal et les `state` ne sont stockés que sous forme de hash SHA‑256.

## OAuth Google

- **Scopes.** Ce sont les plus étroits qui couvrent l'import, vérifiés sur la liste officielle :
  - `openid` et `email` : identifiant stable et adresse du compte ;
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` : liste des calendriers ;
  - `https://www.googleapis.com/auth/calendar.events.readonly` : lecture des événements.

  L'écriture dans un calendrier choisi (PR suivante) ajoutera `calendar.events.owned` par autorisation incrémentale (`include_granted_scopes=true`). Elle n'est pas demandée avant d'être utilisée. Si un scope requis n'est pas accordé (consentement granulaire), la connexion est refusée avec `calendar_scope_missing`.

- **Démarrage (`startGoogleCalendarConnectAction`).**
  - Un `state` aléatoire de 256 bits est créé. Seul son hash est stocké, lié à l'utilisateur et au business, valable 10 minutes, à usage unique ; on garde au plus 10 états par utilisateur.
  - Un vérificateur PKCE est généré et stocké chiffré, avec un défi `S256`.
  - L'URL Google porte `access_type=offline` et `prompt=consent`. Google ne renvoie un refresh token qu'au premier consentement ; `prompt=consent` le fait renvoyer à chaque reconnexion.
- **Callback (`GET /api/calendar/google/callback`, serveur uniquement).** Les étapes s'enchaînent ainsi :
  1. le `state` est consommé par l'utilisateur connecté (même utilisateur, non expiré, jamais utilisé) ;
  2. le business du `state` doit être celui de la session ;
  3. le code est échangé avec le vérificateur ;
  4. l'`id_token` est contrôlé (`aud`, `iss`) ;
  5. les scopes sont vérifiés ;
  6. la liste des calendriers est lue ;
  7. connexion, secrets et calendriers sont enregistrés **dans une seule transaction**.

  Aucune connexion partielle ne peut subsister. La réponse est toujours une redirection vers `/app?calendar=<résultat>`, jamais une redirection ouverte. Les résultats possibles sont : `connected`, `denied`, `invalid_state`, `scope_missing`, `provider_unavailable`, `not_configured`, `error`.

- **Refus et `state` manquant.** Un refus (`error=access_denied`) ou un code absent consomme le `state`. Un `state` absent, inconnu, expiré, rejoué, émis pour un autre utilisateur, ou dont l'utilisateur a perdu l'accès au business donne `invalid_state` ou `error`, sans rien enregistrer.
- **Reconnexion du même compte.**
  - La même ligne est réutilisée, sans doublon possible : contrainte `unique (business_id, provider)`. Deux onglets aboutissent donc au même résultat.
  - Les tokens sont remplacés, les calendriers rafraîchis et la sélection conservée. Les calendriers sélectionnés repartent en full sync.
  - Si Google n'envoie pas de refresh token, l'ancien est conservé.
- **Autre compte, ou reconnexion après déconnexion.** L'ancien contenu (calendriers et périodes) est supprimé, puis le nouveau compte est enregistré.

## Token d'accès

`getAccessToken` (`src/features/calendar/data/tokens.ts`) est le seul point qui fournit un access token :

- le token stocké est réutilisé tant qu'il lui reste plus d'une minute ;
- sinon un seul rafraîchissement a lieu par connexion et par processus (_single-flight_), sans _stampede_ ;
- après un 401, un rafraîchissement forcé est tenté, une seule fois ;
- `invalid_grant` (révocation ou expiration chez Google) fait passer la connexion en `reauth_required`. Les périodes déjà copiées continuent de bloquer, comme dernier état connu, jusqu'à la reconnexion ou la déconnexion.

## Appels à Google

`src/features/calendar/providers/http.ts` encadre chaque appel :

- délai de 10 s par tentative ;
- au plus 3 nouvelles tentatives, uniquement pour 429, 5xx, timeout ou erreur réseau ;
- backoff exponentiel avec _jitter_, plafonné à 4 s ;
- respect de `Retry-After` dans la limite de ce plafond.

Les 4xx ne sont jamais retentés. Un 403 `rateLimitExceeded` est classé `rate_limited`. Aucune boucle n'est infinie.

## Sélection des calendriers bloquants

`updateBlockingCalendarsAction({ calendarIds })` remplace l'ensemble de la sélection, en une transaction sous le verrou de planning :

- **Calendriers retirés.** Ils perdent immédiatement leurs périodes et leur curseur ; leurs canaux push sont arrêtés.
- **Calendriers ajoutés.** Ils passent `pending`, puis la full sync tourne après la réponse.
- **Calendriers d'un autre business.** Ils sont refusés (`calendar_not_found`).
- **Par défaut, aucun calendrier n'est bloquant**, y compris anniversaires et jours fériés.

## Synchronisation

**Fenêtre.** La copie couvre `[maintenant − 1 jour, maintenant + 400 jours)`, ce qui couvre l'horizon de réservation maximal (365 jours, plus le jour en cours) avec une marge.

- La fenêtre est renouvelée par une full sync dès qu'elle ne couvre plus 380 jours, environ toutes les 3 semaines.
- Les événements hors fenêtre ne sont jamais stockés, même s'ils arrivent dans une sync incrémentale.
- L'historique Google n'est jamais copié.

**Récurrences.** Les événements sont lus avec `singleEvents=true` : Google développe lui-même les séries en occurrences, chacune avec son identifiant et `recurringEventId`. Il n'y a aucun moteur RRULE ici.

- Une occurrence modifiée revient seule.
- Une occurrence supprimée revient en `cancelled`.
- Une série annulée (identifiant de série) supprime toutes ses occurrences.

**Full sync.**

- Elle est paginée par 250 événements, avec au plus 40 pages.
- Chaque page est appliquée dans sa propre transaction, avec le curseur de page. Une sync interrompue reprend à la dernière page appliquée si elle a moins d'une heure, sinon elle recommence.
- À la fin, un balayage supprime ce qui n'a pas été revu dans cette génération, puis le `nextSyncToken` est enregistré.
- Pendant toute la full sync, les anciennes périodes continuent de bloquer : il n'y a jamais de fenêtre sans blocage.
- Au‑delà de 40 pages, la sync s'arrête avec `too_many_events` (`sync_status = error`). Ce qui a été lu continue de bloquer.

**Sync incrémentale.**

- Elle repart du `syncToken` avec les mêmes paramètres, sans `timeMin` ni `timeMax`, conformément à la documentation Google.
- Le curseur n'avance qu'après application de toutes les pages ; rejouer les mêmes pages ne change rien.
- Un 410 (`Gone`) efface le curseur et lance une full sync, dont le balayage remplace la copie locale.

**Application d'un événement** (`public.calendar_apply_events`) :

- elle est idempotente (`unique (external_calendar_id, provider_event_id)`) ;
- une version plus ancienne (`updated`) ne remplace jamais une plus récente ;
- un événement `cancelled` est supprimé ;
- un événement vide, illisible ou hors fenêtre est ignoré.

**Événements qui bloquent.** Un événement bloque seulement s'il est occupé :

- `transparency` différent de `transparent` ;
- non refusé par le compte (`responseStatus = declined`) ;
- de type ni `workingLocation` ni `birthday`.

**Instants.**

- _Événements avec heure._ Un `dateTime` avec décalage ou `Z` est pris tel quel. Sans décalage, il est lu dans son `timeZone`, ou à défaut dans le fuseau du calendrier, par PostgreSQL.
- _Événements « journée entière »._ `[start.date, end.date)`, avec une date de fin exclusive, devient `[local_day_start(start), local_day_start(end))` dans le fuseau de l'événement, sinon du calendrier, sinon du business. Une journée de 23 h, 25 h, Havana ou une date Apia inexistante (vide) sont gérées. Le fuseau du calendrier peut différer de celui du business.

**Un seul worker par calendrier.** Un bail en base l'assure. Une demande qui arrive pendant une sync marque `resync_requested` : le worker refait une passe, avec 3 passes au plus. Ainsi, 50 notifications identiques coûtent quelques passes, pas 50.

## Notifications push et tâche périodique

- **Création des canaux.** Si `GOOGLE_CALENDAR_WEBHOOK_URL` (HTTPS) est configurée, chaque calendrier bloquant reçoit un canal `events.watch`. Le token du canal est aléatoire et n'est stocké que sous forme de hash. L'identifiant de ressource et l'expiration sont conservés.
- **`POST /api/calendar/google/webhook`.** Une notification n'est acceptée que si toutes ces conditions sont remplies :
  - le canal est le canal **courant** d'un calendrier bloquant d'une connexion active ;
  - même ressource ;
  - même token ;
  - canal non expiré.

  Le business est déduit du canal, jamais de la requête. Une notification acceptée signifie seulement « synchroniser » : la sync lit Google après la réponse, et la notification n'apporte aucune donnée. Les notifications valides, ignorées et invalides reçoivent la même réponse, `204` sans corps. Les doublons et le désordre d'arrivée sont absorbés par le bail et l'idempotence.

- **Tâche périodique `GET|POST /api/cron/calendar`.** Elle exige `Authorization: Bearer $CRON_SECRET`, à **planifier toutes les 15 minutes** au déploiement. À chaque passage, et sans dépasser 60 s :
  - premières syncs et reprises après erreur ;
  - glissement de fenêtre ;
  - renouvellement des canaux un jour avant expiration (le nouveau est créé, l'ancien arrêté) ;
  - **rattrapage** de tout calendrier non synchronisé depuis 6 heures, car Google ne garantit pas la livraison des notifications.

## Disponibilité et réservation

- **Disponibilité.** `private.compute_available_slots` ajoute les périodes occupées (`private.external_busy`) à l'occupation des rendez-vous. Un créneau est proposé seulement si `[début, début + durée + buffer)` ne chevauche ni un rendez-vous occupant ni une période externe occupée. Il doit aussi tenir dans une plage ouverte, hors fermetures et blocs. Les bornes se touchant ne se chevauchent pas : `[)`.
- **Réservation.** `private.create_public_booking_at` revalide l'instant demandé avec cette même fonction, **sous le verrou de planning**. Une période externe synchronisée entre l'affichage et la réservation est donc refusée (`slot_unavailable`).
- **Verrous.** L'application d'une page d'événements, la fin d'une full sync, la sélection, la reconnexion et la déconnexion prennent le même verrou de planning (`business_schedule:<id>`) que les réservations, blocs et horaires, en READ COMMITTED. Une réservation voit une page entière ou rien. Aucun appel réseau n'a lieu pendant la détention du verrou.
- **Agenda professionnel.** La professionnelle peut toujours placer manuellement un rendez-vous sur une période externe : elle sait ce qu'elle fait, et le conflit est signalé. Les blocs et les rendez-vous gardent leurs garanties existantes.

## Cohérence à terme et conflits

Google et PostgreSQL ne partagent pas de transaction. Une petite fenêtre est inévitable, par exemple :

1. un créneau est libre ;
2. un événement est créé directement dans Google ;
3. une cliente réserve avant que Booking ne l'apprenne.

| Ce qui arrive                              | Délai                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Notification push                          | quelques secondes en général                                          |
| Sync déclenchée après la notification      | quelques secondes                                                     |
| Sans notification (livraison non garantie) | au plus la période de rattrapage : 6 h, plus l'intervalle de la tâche |

**Atténuations :**

- notifications push ;
- rattrapage périodique ;
- `syncGoogleCalendarNowAction` ;
- plus tard, le miroir Booking → Google rendra le rendez-vous visible dans Google.

**Conflit découvert après une réservation.** La sync **n'échoue jamais** à cause d'un rendez-vous existant : l'événement est stocké, le rendez-vous reste inchangé, et le conflit est exposé par `listCalendarConflictsAction` (`public.calendar_conflicts`) pour la future UI. Il n'y a ni annulation, ni déplacement, ni email automatique.

## Déconnexion

`disconnectGoogleCalendarAction` est idempotente. Elle procède en deux temps :

1. **En local, immédiatement, dans une transaction sous le verrou.** Les périodes, les calendriers, les curseurs, les canaux et les secrets sont supprimés, et la connexion passe `disconnected`. La disponibilité n'est plus bloquée et aucun rendez-vous n'est touché. Une page de sync qui arrive après n'est pas appliquée : l'état est relu sous le verrou.
2. **Chez Google, au mieux.** Les canaux sont arrêtés et le refresh token est révoqué, ce qui révoque l'autorisation. Un échec est seulement journalisé, car les canaux expirent d'eux-mêmes.

## Server Actions (`src/features/calendar/actions/calendar.ts`)

Toutes dérivent l'utilisateur et le business de la session. Aucune n'accepte d'identifiant de business, d'utilisateur ou de connexion.

| Action                                           | Entrée                                     | Succès (`data`)                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getCalendarIntegrationStatusAction()`           | —                                          | `{ provider, available, connection: { id, status, accountEmail, lastSyncedAt, lastError, version } \| null, calendars }`                                |
| `startGoogleCalendarConnectAction()`             | —                                          | `{ authorizationUrl }`, à ouvrir en navigation pleine page                                                                                              |
| `listConnectedCalendarsAction({ refresh? })`     | `refresh: true` relit la liste chez Google | `ConnectedCalendarDto[]`                                                                                                                                |
| `updateBlockingCalendarsAction({ calendarIds })` | ensemble complet, 50 au plus               | `ConnectedCalendarDto[]`, la sync suit après la réponse                                                                                                 |
| `syncGoogleCalendarNowAction()`                  | —                                          | `{ outcomes: { [calendarId]: "synced" \| "busy" \| "skipped" \| "too_many_events" \| "budget_exceeded" \| "error" }, calendars }`, borné à environ 20 s |
| `disconnectGoogleCalendarAction()`               | —                                          | `{ disconnected: true }`                                                                                                                                |
| `listCalendarConflictsAction({ from, to })`      | ISO 8601, 400 jours au plus                | `{ appointmentId, appointmentStartsAt, appointmentEndsAt, calendarId, eventStartsAt, eventEndsAt }[]`                                                   |

`ConnectedCalendarDto` : `{ id, name, timezone, primary, accessRole, blocking, syncStatus, lastSyncedAt, lastError }`.

**Erreurs stables :**

- `calendar_not_configured` (503) ;
- `calendar_not_connected` (409) ;
- `calendar_reauth_required` (409) ;
- `calendar_provider_unavailable` (503) ;
- `calendar_not_found` (404) ;
- `calendar_scope_missing` (400) ;
- `oauth_state_invalid` (400) ;
- plus les codes communs (`unauthenticated`, `forbidden`, `validation_error`…).

## Configuration

Les variables, uniquement côté serveur, sont décrites dans `.env.example`. Si l'une manque ou est invalide, l'intégration est désactivée : _fail closed_, avec `calendar_not_configured`, un webhook muet et une tâche périodique sans effet.

| Variable                                                     | Rôle                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | client OAuth « Application Web »                                                                              |
| `GOOGLE_CALENDAR_REDIRECT_URI`                               | par défaut `<NEXT_PUBLIC_APP_URL>/api/calendar/google/callback` ; doit être déclarée telle quelle chez Google |
| `GOOGLE_CALENDAR_WEBHOOK_URL`                                | optionnelle ; URL HTTPS publique du webhook (sans elle, la tâche périodique seule synchronise)                |
| `CALENDAR_TOKEN_ENCRYPTION_KEY`                              | 32 octets base64 (`openssl rand -base64 32`)                                                                  |
| `CALENDAR_TOKEN_PREVIOUS_KEYS`                               | anciennes clés, pendant une rotation                                                                          |
| `CRON_SECRET`                                                | déjà présent ; protège `/api/cron/calendar`                                                                   |

**Déploiement :**

1. déclarer l'URI de redirection et l'écran de consentement chez Google (ces scopes sont _sensibles_ : vérification Google requise pour un usage public) ;
2. planifier `/api/cron/calendar` toutes les 15 minutes ;
3. exposer le webhook en HTTPS.

## Abstraction fournisseur

`src/features/calendar/providers/types.ts` définit `CalendarProvider`. Ce contrat couvre :

- l'URL d'autorisation, l'échange du code, le rafraîchissement et la révocation ;
- la liste des calendriers et des événements (full ou incrémentale) ;
- la création et l'arrêt des canaux push ;
- les erreurs classées : `auth_revoked`, `unauthorized`, `gone`, `rate_limited`, `unavailable`, etc.

Tout ce qui est propre à Google se trouve dans `providers/google.ts`. Le domaine (sync, connexion, webhook, tâche) et les tables restent génériques : `provider` vaut `'google'` aujourd'hui. Microsoft 365 ou CalDAV s'ajouteront par un nouvel adaptateur et une valeur de `provider`.

## Évolutions prévues

- **Miroir Booking → Google, prochaine PR.**
  - Choix d'un calendrier de destination.
  - Outbox transactionnelle des créations, déplacements et annulations.
  - Scope `calendar.events.owned` en autorisation incrémentale.
  - Marquage des événements exportés pour qu'ils ne soient pas réimportés comme indisponibilités.
- **UI.**
  - Écran de connexion et de sélection.
  - Affichage des périodes externes dans l'agenda.
  - Signalement des conflits.
