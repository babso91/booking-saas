# Contrat — intégration calendrier (V1 : Google → Booking)

Ce document décrit le backend de l'intégration calendrier livré par les migrations `20261003090000_calendar_inbound_sync.sql`, `20261004090000_calendar_sync_hardening.sql` (incarnations, claims, générations, fuseaux, équité) `20261005090000_calendar_sync_hardening_2.sql` (reprojection atomique des fuseaux, CAS des secrets, fenêtre de révocation, intervalles stricts) `20261006090000_calendar_sync_hardening_3.sql` (aucun repli sur le fuseau du business, fuseaux stricts, lignes historiques préservées, attentes de verrou bornées) et `20261007090000_calendar_sync_hardening_4.sql` (confiance dans le fuseau d'un calendrier, écriture du token rafraîchi décidée par PostgreSQL avant l'échéance). Il sert de contrat à la future UI et au déploiement.

## Principes

- **Booking SaaS reste la source de vérité des rendez-vous clientes.** Google ne crée, ne déplace et n'annule jamais un rendez-vous Booking.
- **Google est la source de vérité des événements personnels** de la professionnelle. Les périodes occupées des calendriers qu'elle sélectionne sont copiées localement (`external_calendar_events`) et bloquent la disponibilité publique.
- **Aucun appel à Google pendant une consultation ou une réservation.** La disponibilité et la transaction de réservation lisent uniquement la copie locale, indexée, dans PostgreSQL.
- **PostgreSQL reste l'autorité temporelle.** Les dates des événements « journée entière » sont converties par `private.local_day_start` dans le fuseau du calendrier. Les `dateTime` avec décalage explicite sont gardés tels quels, jamais reconstruits depuis l'heure murale.
- **Booking → Google (miroir des rendez-vous) n'est pas implémenté.** Il fera l'objet de la PR suivante (voir « Évolutions »).

## Modèle de données

| Table                            | Contenu                                                                                                                                                                                                                                                                                                                 | Accès                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_connections`           | Un compte par fournisseur et par business : `provider`, compte (`provider_account_id`, `account_email`), `status` (`active`, `reauth_required`, `disconnected`), `scopes`, `last_synced_at`, `last_error` (code stable), `version`, `credential_generation` (incarnation des identifiants), `revocation_pending_until`. | Lecture par les membres (RLS), sauf `provider_account_id`, `connected_by`, `credential_generation` et `revocation_pending_until`. Aucune écriture directe. |
| `private.calendar_secrets`       | Refresh token et access token **chiffrés** (AES‑256‑GCM, clé uniquement dans l'environnement serveur).                                                                                                                                                                                                                  | Aucun rôle d'API ; seulement les fonctions `security definer` réservées au `service_role`.                                                                 |
| `external_calendars`             | Calendriers visibles du compte : nom, fuseau, `is_primary`, `access_role`, `selected_for_blocking`, `sync_status` (voir « Statuts »), `last_synced_at`, `last_error`.                                                                                                                                                   | Lecture par les membres. La sélection passe par `calendar_set_blocking`.                                                                                   |
| `private.external_calendar_sync` | Curseur de sync (`sync_token`), génération committée et dernière génération allouée, fenêtre, full sync en cours (page, génération, début), claim du worker (`claim_id`, bail), backoff (`next_attempt_at`, `failure_count`, `last_attempt_at`), canal push (id, ressource, **hash** du token, expiration).             | Aucun rôle d'API.                                                                                                                                          |
| `external_calendar_events`       | Périodes des calendriers sélectionnés : instants UTC `[starts_at, ends_at)`, `all_day`, `busy`, identifiants fournisseur (événement, série), `etag`, `updated`, génération. Aucun titre, aucune description, aucun participant.                                                                                         | Lecture par les membres (instants seulement).                                                                                                              |
| `private.calendar_oauth_states`  | États OAuth : **hash** du `state`, utilisateur, business, vérificateur PKCE chiffré, expiration à 10 minutes.                                                                                                                                                                                                           | Aucun rôle d'API.                                                                                                                                          |

Index : `gist (business_id, busy_window) where busy` pour le chevauchement. La disponibilité l'utilise en _Bitmap Index Scan_ (voir « Performance »).

## Stockage des secrets

- **Chiffrement.** AES‑256‑GCM (`src/lib/crypto/secret-box.ts`), IV aléatoire de 96 bits. Les données associées lient le chiffré à son propriétaire : `calendar-token:<provider>:<business_id>` pour les tokens, `oauth-verifier:<hash du state>` pour le vérificateur PKCE. Un chiffré copié vers un autre business ne se déchiffre pas.
- **Clé.** `CALENDAR_TOKEN_ENCRYPTION_KEY` : 32 octets en base64, présente uniquement dans l'environnement serveur. La base ne voit que du chiffré.
- **Rotation.** Chaque chiffré porte l'identifiant de sa clé. Une rotation sûre :
  1. Mettre la nouvelle clé dans `CALENDAR_TOKEN_ENCRYPTION_KEY` et l'ancienne dans `CALENDAR_TOKEN_PREVIOUS_KEYS` (liste séparée par des virgules), puis déployer.
  2. **Rechiffrement paresseux des deux secrets.** À chaque lecture des identifiants d'une connexion (sync, rafraîchissement de la liste, tâche périodique), si le refresh token **ou** l'access token est chiffré avec une autre clé que la clé courante, les deux sont réécrits sous la clé courante (`calendar_reencrypt_secrets`). L'écriture est un _compare-and-set_ sur la ligne lue (incarnation **et** `secret_version`) : si un rafraîchissement a écrit un nouveau token entre la lecture et la réécriture, le rechiffrement ne fait rien et le nouveau token, avec sa vraie expiration, reste en place. Les refresh tokens sont donc réécrits eux aussi, sans attendre une reconnexion.
  3. Vérifier qu'il ne reste aucun chiffré de l'ancienne clé : `select count(*) from private.calendar_secrets where split_part(refresh_token_ciphertext, '.', 2) = '<id>' or split_part(access_token_ciphertext, '.', 2) = '<id>'` (l'identifiant est celui affiché par `secretKey(...).id`). La tâche périodique touche chaque calendrier bloquant au moins toutes les 6 heures ; une connexion **sans calendrier bloquant** n'est lue que lorsqu'on l'utilise : il faut alors attendre ce compteur à zéro, ou demander une reconnexion.
  4. Retirer l'ancienne clé seulement quand le compteur est à zéro. Une connexion dont un secret n'est plus déchiffrable échoue (sync en `error`) : il faut la reconnecter.

  Le test `encryption key rotation` (intégration) vérifie la réécriture des deux secrets et le fonctionnement après retrait de l'ancienne clé.

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
  4. l'`id_token` est contrôlé : **audience unique**, égale à notre client (chaîne, ou liste réduite à `[client]`) — Google : « Verify that the value of the aud claim in the ID token is equal to your app's client ID » ; aucune autre audience n'est acceptée, même accompagnée de `azp = client` ; `azp`, s'il est présent, égal au client ; `iss` Google, `sub` non vide, `exp` non dépassé et `iat` non futur (tolérance de 5 minutes), `email` éventuel de type chaîne ;
  5. les scopes sont vérifiés ;
  6. la liste des calendriers est lue ;
  7. connexion, secrets et calendriers sont enregistrés **dans une seule transaction**.

  Aucune connexion partielle ne peut subsister. La réponse est toujours une redirection vers `/app?calendar=<résultat>`, jamais une redirection ouverte. Les résultats possibles sont : `connected`, `denied`, `invalid_state`, `scope_missing`, `provider_unavailable`, `not_configured`, `disconnect_in_progress`, `error`.

- **Refus et `state` manquant.** Un refus (`error=access_denied`) ou un code absent consomme le `state`. Un `state` absent, inconnu, expiré, rejoué, émis pour un autre utilisateur, ou dont l'utilisateur a perdu l'accès au business donne `invalid_state` ou `error`, sans rien enregistrer.
- **Reconnexion du même compte.**
  - La même ligne est réutilisée, sans doublon possible : contrainte `unique (business_id, provider)`. Deux onglets aboutissent donc au même résultat.
  - Les tokens sont remplacés, les calendriers rafraîchis et la sélection conservée. Les calendriers sélectionnés repartent en full sync.
  - Si Google n'envoie pas de refresh token, l'ancien est conservé.
- **Autre compte, ou reconnexion après déconnexion.** L'ancien contenu (calendriers et périodes) est supprimé, puis le nouveau compte est enregistré.
- **Chaque connexion ou reconnexion crée une nouvelle incarnation** (voir ci-dessous) : toute opération démarrée avec les identifiants précédents devient sans effet.

## Incarnations et autorité des workers

Deux identifiants rendent toute réponse tardive inoffensive. Chaque écriture les vérifie **en SQL, atomiquement**, sous le verrou de planning quand elle touche aux périodes.

- **Incarnation de connexion** (`calendar_connections.credential_generation`, UUID). Elle change à chaque connexion, reconnexion et déconnexion. Toute opération distante la capture d'abord ; ses écritures sont conditionnées par elle :

  | Opération                    | Écriture conditionnée                                   | Si l'incarnation a changé                       |
  | ---------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
  | rafraîchissement du token    | `calendar_store_access_token(id, generation, …)`        | token ni stocké ni utilisé (`StaleCredentials`) |
  | `invalid_grant`              | `calendar_mark_reauth_required(id, generation, …)`      | la connexion courante reste `active`            |
  | liste des calendriers        | `calendar_save_calendars(id, generation, …)`            | liste ignorée, calendriers courants intacts     |
  | rechiffrement après rotation | `calendar_reencrypt_secrets(id, generation, …)`         | rien n'est réécrit                              |
  | sync (pages, curseur, canal) | par le claim, révoqué à chaque changement d'incarnation | rien n'est écrit (`superseded`)                 |
  | déconnexion                  | `calendar_disconnect(id, generation)`                   | la nouvelle connexion n'est pas déconnectée     |

  Le _single-flight_ du rafraîchissement est indexé par `(connexion, incarnation)` : un appelant d'une incarnation ne reçoit jamais le token d'une autre.

  **Atomicité.** Une vérification préalable dans une autre table ne suffit pas sous READ COMMITTED : un écrivain qui a passé le contrôle puis attend un verrou écrirait après la reconnexion. Les écritures de secrets sont donc un _compare-and-set_ sur la ligne `private.calendar_secrets` elle-même, qui porte `credential_generation` et `secret_version` (`update … where credential_generation = $gen [and secret_version = $version]`, puis contrôle du nombre de lignes), précédé d'un verrou partagé sur la ligne de connexion, relue après toute attente. PostgreSQL réévalue la condition sur la version validée de la ligne : l'écrivain périmé écrit zéro ligne. Testé avec deux transactions réelles (reconnexion non validée, écrivain de l'ancienne incarnation bloqué, validation, puis `false` et secrets de B intacts) pour le rafraîchissement, le rechiffrement et `invalid_grant`, dans les deux ordres.

  **Ordre des verrous.**

  1. verrou de planning du business (consultatif, `business_schedule:<id>`) ;
  2. ligne `calendar_connections` ;
  3. ligne `private.calendar_secrets` ;
  4. lignes `external_calendars` ;
  5. lignes `private.external_calendar_sync` ;
  6. lignes `external_calendar_events`.

  | Opération                                           | 1   | 2                        | 3        | 4   | 5            | 6   |
  | --------------------------------------------------- | --- | ------------------------ | -------- | --- | ------------ | --- |
  | connexion, reconnexion (`calendar_save_connection`) | ✓   | `for update`             | écriture | ✓   | ✓            | ✓   |
  | déconnexion (`calendar_disconnect`)                 | ✓   | `for update`             | suppr.   | ✓   | (cascade)    | ✓   |
  | rafraîchissement du token                           |     | `for share`              | CAS      |     |              |     |
  | rechiffrement (rotation)                            |     | `for share`              | CAS      |     |              |     |
  | `invalid_grant`                                     |     | écriture CAS             | écriture |     |              |     |
  | liste des calendriers (`calendar_save_calendars`)   | ✓   | `for update`             |          | ✓   | ✓            | ✓   |
  | changement de fuseau (liste ou page)                | ✓   | (liste)                  |          | ✓   | ✓            | ✓   |
  | claim (`calendar_claim_sync`)                       | ✓   |                          |          | ✓   | ✓            |     |
  | page, fin de full sync, fin d'incrémentale          | ✓   | (fin : `last_synced_at`) |          | ✓   | `for update` | ✓   |
  | début de full sync, reset, canal (claim vérifié)    |     |                          |          |     | `for update` |     |
  | libération (`calendar_release_sync`)                | ✓   | (écriture `last_error`)  |          | ✓   | `for update` |     |
  | sélection (`calendar_set_blocking`)                 | ✓   | `for update`             |          | ✓   | ✓            | ✓   |
  | réservation, blocs, horaires                        | ✓   |                          |          |     |              |     |

  Règles : (1) précède toujours tout le reste ; (2) précède toujours (3). Une transaction **sans** le verrou de planning ne prend que 2 puis 3 (token, rechiffrement, `invalid_grant`) ou une seule ligne 5 (écritures de sync à claim vérifié), et n'attend plus rien ensuite. Les lignes 4–6, ainsi que les mises à jour de la connexion en fin de passe (`last_synced_at`, `last_error`, prises après les lignes 4–5), ne sont écrites que sous le verrou de planning, qui sérialise ces transactions pour un business. Un cycle d'attente à deux transactions est donc impossible : entre deux détenteurs du verrou de planning, l'un attend l'autre sur ce verrou avant tout le reste ; un non-détenteur prend 2 puis 3, ou une seule ligne 5 ; tenant 3 ou 5, il n'attend plus rien, et tenant 2 il n'attend que 3, qu'aucun détenteur du verrou de planning ne peut tenir sans tenir déjà 2 en mode exclusif : quiconque attend un non-détenteur finit donc par passer. Les tests à deux transactions vérifient les deux ordres (écrivain d'abord, puis reconnexion ; reconnexion d'abord, puis écrivain) sans interblocage.

- **Claim de sync** (`external_calendar_sync.claim_id`). `calendar_claim_sync` délivre un claim quand aucun bail vivant n'existe. **Le bail ne sert qu'à l'acquisition** ; l'autorité d'écrire est le claim. Pages, début et fin de full sync, fin d'incrémentale, réinitialisation du curseur, enregistrement de canal et libération exigent le claim courant, un calendrier toujours sélectionné et une connexion active. Une reconnexion, une déconnexion, une désélection (même suivie d'une resélection) ou un changement de fuseau révoquent le claim. Un worker dont le bail a expiré et qu'un autre a remplacé n'écrit donc plus rien, même s'il reçoit encore des réponses de Google ; un canal créé par lui est arrêté (`orphan`) **avec le token d'accès qui l'a créé**, gardé en mémoire le temps de la passe (jamais persisté) : après une reconnexion, les identifiants de l'ancienne incarnation n'existent plus en base.

- **Échéance globale.** Une passe de sync a une échéance absolue (budget, 25 s par défaut). Chaque appel Google reçoit le temps restant : délai de tentative réduit à ce temps, aucune attente de retry au-delà, aucun appel après. Le bail dure le budget plus 30 s : une passe se termine toujours avant que son bail puisse être repris.
- **Rafraîchissement partagé.** Un rafraîchissement de token est partagé par les appelants de la même incarnation et a son propre budget (30 s), indépendant de celui qui l'a lancé. Chaque appelant borne seulement **sa propre attente** à son échéance (`awaitWithDeadline`) : un worker dont le budget expire s'arrête (`stale`), le rafraîchissement continue pour les autres. Testé : rafraîchissement bloqué, worker à 1,5 s qui sort à l'heure, second appelant servi ensuite, un seul appel `/token`.

  **Budget complet.** Le budget couvre toute la chaîne :
  1. **lecture des identifiants** : bornée par l'échéance de l'appelant. Le rechiffrement paresseux qu'elle peut déclencher est opportuniste : en cas d'échec ou de refus, la lecture continue ;
  2. **appel `/token`** : borné par le budget partagé ;
  3. **écriture CAS du résultat**, décidée par PostgreSQL avant l'échéance, sur sa propre horloge :
     - le serveur envoie seulement la **durée restante**, mesurée avec l'horloge monotone (`performance.now()`), jamais une heure absolue ;
     - dès son démarrage, `calendar_store_access_token` calcule `db_deadline = clock_timestamp() + durée restante − 250 ms`. La marge est retranchée, donc l'échéance base est un peu plus tôt que celle du serveur, pour couvrir le trajet serveur → base ;
     - la fonction prend ses verrous dans l'ordre global (ligne de connexion `for share`, puis ligne des secrets `for update`) ;
     - une fois tous les verrous tenus, plus rien n'est attendu : elle vérifie `clock_timestamp() < db_deadline`, puis seulement écrit ; la condition est répétée dans l'`UPDATE` ;
     - résultat : `stored`, `stale` (autre incarnation) ou `expired`.

     La garantie exacte est : **PostgreSQL prend la décision d'autoriser l'écriture avant la deadline DB**. Le `COMMIT` physique peut finir un instant après. `lock_timeout = 3 s` borne en plus toute attente de verrou ;

  4. **libération de l'entrée _single-flight_** : garantie au plus tard à la fin du budget.

  **Annulation (`withDeadline`).** Un appel base dont l'échéance est déjà passée n'est jamais lancé. S'il la dépasse en cours de route, l'appelant reçoit le dépassement et la requête est annulée côté client (`AbortSignal`, `abortSignal()` de PostgREST). Sa résolution ou son rejet tardif reste consommé : jamais de `unhandledRejection`. Cette annulation ne remplace pas les protections SQL : un délai côté TypeScript n'annule pas forcément une requête déjà partie. Ce que l'appelant a cessé d'attendre ne peut donc qu'échouer (verrou, échéance base) ou réussir sans dommage (CAS sur l'incarnation, token valide de la même incarnation avec sa propre expiration). Tests :
  - ligne de connexion verrouillée pendant une lecture avec rotation de clé : sortie à l'échéance ; sans échéance, réponse après l'abandon du rechiffrement ;
  - écriture bloquée : l'appelant sort à l'heure, le refresh partagé échoue au `lock_timeout`, rien n'est écrit, puis un nouveau refresh démarre et enregistre ;
  - échéance dépassée pendant l'attente du verrou des secrets (deux transactions réelles : échéance 0,5 s, verrou relâché vers 2 s) : `expired`, aucune modification (token, expiration, version) ; côté serveur, le refresh partagé se termine à son budget, rien n'est écrit plus tard et un nouveau refresh fonctionne ;
  - échéance déjà passée : l'appel base n'est jamais lancé ; échéance dépassée en cours : signal annulé, aucun rejet non géré.

- **Tentative de full sync et claim.** La **génération identifie la tentative logique** (sa fenêtre et son curseur de page sont persistés) ; le **claim protège les écritures de la passe en cours**. Une tentative peut donc être reprise par une autre passe, avec un autre claim, tant qu'elle a moins d'une heure. Cette heure est notre propre plafond, pas une garantie de Google sur la durée de vie d'un `pageToken` : si Google refuse le curseur repris (410 ou 400), la tentative est abandonnée sans balayage et une nouvelle full sync, avec une génération neuve, repart de la page 1.

## Token d'accès

`getAccessToken` (`src/features/calendar/data/tokens.ts`) est le seul point qui fournit un access token :

- le token stocké est réutilisé tant qu'il lui reste plus d'une minute ;
- sinon un seul rafraîchissement a lieu par connexion, incarnation et processus (_single-flight_), sans _stampede_ ;
- après un 401, un rafraîchissement forcé est tenté, une seule fois ;
- `invalid_grant` (révocation ou expiration chez Google) fait passer la connexion en `reauth_required`, **seulement si l'incarnation est toujours celle qui a reçu l'erreur**. Les périodes déjà copiées continuent de bloquer, comme dernier état connu, jusqu'à la reconnexion ou la déconnexion.

## Appels à Google

`src/features/calendar/providers/http.ts` encadre chaque appel :

- délai de 10 s par tentative ;
- au plus 3 nouvelles tentatives, uniquement pour 429, 5xx, timeout ou erreur réseau ;
- backoff exponentiel avec _jitter_, plafonné à 4 s ;
- respect de `Retry-After` dans la limite de ce plafond.

Les 4xx ne sont jamais retentés. Un 403 `rateLimitExceeded` est classé `rate_limited`. Aucune boucle n'est infinie. Une échéance optionnelle borne l'appel entier, retries compris.

**Validation stricte des réponses** (`protocol`). Une réponse 2xx est rejetée, sans rien appliquer, si :

- le corps n'est pas un objet JSON ;
- une page d'événements n'a pas **exactement un** de `nextPageToken` et `nextSyncToken` (`{}`, dernière page sans curseur, deux curseurs, curseur vide) ;
- `items` n'est pas un tableau, ou un élément n'est pas un objet avec un `id` non vide ;
- un événement non annulé n'a pas `start` et `end` du même type (`date` `AAAA-MM-JJ` existante, ou `dateTime` RFC 3339 valide : heure 00–23, minutes et secondes valides, décalage ±14:00 au plus) ;
- un `dateTime` n'a ni décalage ni `timeZone` (règle de Google) ;
- un champ dont dépend le blocage est mal typé ou inconnu : `status` (`confirmed`, `tentative`, `cancelled`), `transparency` (`opaque`, `transparent`), `eventType` (chaîne non vide ; un type inconnu bloque, sens sûr), `recurringEventId`, `etag`, `updated` (RFC 3339 avec décalage) ;
- `attendees` n'est pas un tableau d'objets, un `self` n'est pas un booléen (`"false"` ou `1` sont refusés, jamais interprétés), ou un `responseStatus` n'est pas `needsAction`, `declined`, `tentative` ou `accepted` ;
- la liste des calendriers est vide, malformée, ou plus longue que les 4 pages lues (une liste tronquée supprimerait des calendriers existants) ;
- une réponse de token n'a pas d'`access_token` ou un `expires_in` invalide ; une réponse `watch` n'a pas la ressource, l'id ou l'expiration attendus.

Un événement dont PostgreSQL ne sait pas lire une borne (`dateTime` sans décalage ni fuseau) fait aussi échouer la page entière (`invalid_input`) : jamais supprimé, jamais considéré libre. Dans tous ces cas la passe s'arrête en `error` (`provider_protocol`) : **aucun événement de la page appliqué, aucun ancien événement supprimé, aucun balayage**, copie locale et curseur conservés, ancienne génération intacte (testé).

**Bornes incohérentes : jamais de rollback de page.** Un intervalle vide ou inversé n'est pas une erreur de protocole : seules ses bornes **résolues** comptent, jamais les heures murales. Chaque borne est résolue dans son propre fuseau (`10:00 America/New_York → 09:00 America/Los_Angeles` couvre bien 14:00Z → 16:00Z) ; une borne dans un fuseau inconnu donne une plage de possibles (−14 h / +12 h). PostgreSQL bloque toujours l'**enveloppe** : du plus petit au plus grand instant possible des deux bornes.

- bornes résolues inversées (ou heures murales inversées dans un même fuseau inconnu) : l'enveloppe est bloquée, l'événement est marqué approximatif, compté dans `adjusted` et journalisé (`calendar_event_bounds_adjusted`, identifiant du calendrier et nombre, rien d'autre) ; la page passe ;
- journée entière inversée : de minuit UTC+14 du jour de fin à minuit UTC−12 du jour de début ;
- intervalle **certainement** vide (deux instants exacts identiques, ou même date civile) : information sûre de Google, l'événement n'occupe plus de temps. Rien n'est créé, et sa copie existante est supprimée explicitement, en incrémental comme en full sync : jamais gardée avec des bornes périmées, jamais laissée au balayage ;
- même heure murale dans un fuseau inconnu, sans décalage : **pas** vide (une heure répétée ou une transition inconnue peut séparer les instants). L'enveloppe bloque, marquée approximative.

L'adaptateur TypeScript ne rejette plus ces intervalles ; il les transmet à PostgreSQL (testé : contre-exemple New York / Los Angeles, et un événement réellement inversé parmi 249 valides qui n'empêche plus la page d'avancer).

À distinguer : une **date civile valide qui n'existe pas localement** (Apia, 30 décembre 2011) n'est pas une erreur de protocole. Sa projection est vide et, selon la politique existante, elle n'occupe aucun temps.

## Sélection des calendriers bloquants

`updateBlockingCalendarsAction({ calendarIds })` remplace l'ensemble de la sélection, en une transaction sous le verrou de planning :

- **Calendriers retirés.** Ils perdent immédiatement leurs périodes et leur curseur ; leurs canaux push sont arrêtés.
- **Calendriers ajoutés.** Ils passent `pending`, puis la full sync tourne après la réponse.
- **Calendriers d'un autre business.** Ils sont refusés (`calendar_not_found`).
- **Calendriers « disponibilités seulement »** (`accessRole = freeBusyReader`). Leurs événements ne sont pas lisibles : ils sont refusés (`calendar_not_selectable`, DTO `selectable: false`). Un calendrier dont l'accès est réduit ainsi chez Google est retiré de la sélection, avec ses périodes, au rafraîchissement suivant de la liste.
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

- Elle est paginée par 250 événements, avec au plus 40 pages par passe.
- Chaque page est appliquée dans sa propre transaction, avec le curseur de page.
- **Générations jamais réutilisées.** Une full sync qui commence en page 1 reçoit une génération neuve (`allocated_generation + 1`, jamais une valeur déjà donnée à une tentative, même abandonnée). Seule une vraie reprise (curseur de page enregistré, tentative de moins d'une heure, par la passe qui détient le claim courant, quelle qu'elle soit) continue la génération de la tentative. Un curseur de page refusé (410/400), une tentative trop ancienne, un 410 sur le `syncToken`, un changement de fuseau ou une incrémentale trop longue redémarrent en page 1, avec une génération neuve.
- À la fin, la dernière page doit porter un `nextSyncToken` (sinon : erreur de protocole). Le balayage supprime toute ligne de génération **inférieure** à celle de la tentative, donc aussi ce qu'une tentative abandonnée avait importé ; puis le curseur, la génération et la fenêtre sont enregistrés.
- Pendant toute la full sync, les anciennes périodes continuent de bloquer : il n'y a jamais de fenêtre sans blocage.
- Au‑delà de 40 pages, la passe s'arrête en `incomplete` (`too_many_events`) : ce qui a été lu s'ajoute à l'ancienne copie et bloque, **sans balayage** ; la passe suivante (après backoff) reprend la pagination si la tentative a moins d'une heure, sinon recommence avec une génération neuve, toujours sans balayer avant la dernière page. Une copie partielle n'est jamais `synced`.

**Sync incrémentale.**

- Elle repart du `syncToken` avec les mêmes paramètres, sans `timeMin` ni `timeMax`, conformément à la documentation Google.
- Le curseur n'avance qu'après application de toutes les pages ; rejouer les mêmes pages ne change rien.
- Un 410 (`Gone`) efface le curseur et lance une full sync (génération neuve), dont le balayage remplace la copie locale.
- Le curseur de page d'une incrémentale n'est pas conservé : au-delà de 40 pages de changements, le curseur est effacé et une full sync (génération neuve) remplace la copie. La dernière page doit porter le nouveau `nextSyncToken` ; l'ancien n'est jamais réutilisé à sa place.

**Application d'un événement** (`public.calendar_apply_events`) :

- elle est idempotente (`unique (external_calendar_id, provider_event_id)`) ;
- une version plus ancienne (`updated`) ne remplace jamais une plus récente ;
- un événement `cancelled` est supprimé ;
- un événement vide (fin ≤ début) ou hors fenêtre est ignoré ;
- un événement sans identifiant ou illisible fait échouer la page entière (jamais ignoré en silence : il peut être occupé).

**Événements qui bloquent.** Un événement bloque seulement s'il est occupé :

- `transparency` différent de `transparent` ;
- non refusé par le compte (`responseStatus = declined`) ;
- de type ni `workingLocation` ni `birthday`.

**Instants.**

- _Événements avec heure._ Un `dateTime` avec décalage ou `Z` est pris tel quel. Sans décalage, il est lu par PostgreSQL dans son propre `timeZone`, qui est alors obligatoire (règle de Google). Il n'y a pas de repli sur le fuseau du calendrier.
- _Événements « journée entière »._ `[start.date, end.date)`, avec une date de fin exclusive, devient `[local_day_start(start), local_day_start(end))` dans le fuseau de l'événement, sinon dans celui du calendrier. Une journée de 23 h, 25 h, Havana ou une date Apia inexistante (vide) sont gérées. Le fuseau du calendrier peut différer de celui du business.

**Aucun repli sur le fuseau du business.** Google documente `calendarList.timeZone` comme « Optional ». Un repli sur `businesses.timezone` rendrait la copie dépendante d'un fuseau dont les changements ne sont pas suivis : un changement Paris → New York laisserait `03/10 01:00Z` réservable sous une journée entière du 2 octobre. Ce repli est donc supprimé :

- un calendrier sans fuseau connu de PostgreSQL n'est pas sélectionnable (`selectable: false`, `calendar_not_selectable`), sans toucher aux disponibilités existantes ;
- une journée entière n'est placée exactement que dans son propre fuseau ou celui de son calendrier ; sans fuseau connu et fiable, elle est élargie à tous les fuseaux (voir ci-dessous) ;
- rien dans la copie ne dépend du fuseau du business, dont un changement ne déplace donc aucune période (testé).

**Fuseaux inconnus : jamais de repli, jamais de gel.** Un fuseau **absent** suit les règles ci-dessus. Un fuseau **présent mais inconnu** de PostgreSQL n'est jamais remplacé par un autre fuseau, ni ignoré, ni rejeté en silence. Il peut s'agir d'une faute de frappe ou, plus probablement, d'un fuseau IANA plus récent que la tzdata de la base, comme `America/Ciudad_Juarez`. La règle est la même pour un événement et pour un calendrier :

- **décalage explicite** : l'instant exact est pris dans le décalage ;
- **pas de décalage** : la période est **élargie à tous les fuseaux possibles**, de UTC+14 à UTC−12. Pour une heure murale, `[début − 14 h, fin + 12 h)` en UTC ; pour une journée entière, de minuit à UTC+14 le jour de début jusqu'à minuit à UTC−12 le jour de fin. On bloque un peu trop, jamais trop peu.

Seul reste une erreur de protocole un `dateTime` sans décalage **ni** fuseau (Google en exige un) ; des bornes inversées suivent la règle de l'enveloppe ci-dessus. Une date civile valide qui n'existe pas dans un fuseau connu (Apia) n'occupe aucun temps.

Les récurrences ne dépendent d'aucun fuseau chez nous : Google développe lui-même les séries (`singleEvents=true`), chaque occurrence arrive avec ses propres bornes et il n'y a aucun moteur RRULE ici.

**Confiance dans le fuseau d'un calendrier** (`external_calendars.timezone_trust`, `trusted` ou `untrusted`). Quand la liste des calendriers, ou une page d'événements, donne pour le calendrier un fuseau inconnu, le calendrier passe `untrusted` :

- **pas de gel** : il continue d'être synchronisé ;
  - ses événements avec décalage restent exacts ;
  - ses journées entières sans fuseau propre sont élargies tout de suite pour la copie existante, puis par une full sync ;
  - un nouveau rendez-vous pris dans Google bloque donc toujours ;
- **statut** : il ne passe jamais `synced` mais `degraded` (synchronisé avec une marge, `last_error = untrusted_timezone`). Le DTO expose `timezoneTrusted: false` et `syncStatus: "degraded"`. Les libellés (`src/features/calendar/client/sync-status-copy.ts`) affichent « Synchronisé avec une marge : fuseau horaire non reconnu », avec `healthy: false`. Aucune logique ne lit `degraded` comme `synced`. `protecting` reste vrai : la copie est complète et ne bloque que davantage ;
- **sélection** : il n'est pas sélectionnable tant qu'il est `untrusted` ;
- **journalisation** : le fuseau reçu est journalisé (`calendar_timezone_untrusted`, nom IANA et identifiant du calendrier, rien de secret), si bien qu'une tzdata en retard se voit tout de suite ;
- **relecture périodique** : la tâche périodique relit la liste des calendriers des connexions qui ont un calendrier `untrusted`, au plus toutes les 6 heures par connexion (`calendar_list_checked_at`). La sélection des connexions dues n'horodate rien : chaque connexion est horodatée au moment où son traitement commence vraiment (`calendar_begin_calendar_list_check`), même s'il échoue ensuite ; celles que le budget de la tâche ne permet pas d'atteindre restent dues.

Seule une liste des calendriers avec un fuseau connu de PostgreSQL rétablit `trusted` ; une page d'événements ne le fait jamais, même avec un fuseau valide. Le rétablissement se passe ainsi :

- les journées entières sont reprojetées **exactement** dans la même transaction ;
- le calendrier passe `stale` et une full sync à génération neuve précède le retour à `synced` ;
- jamais de retour silencieux à l'ancien fuseau.

Testé en SQL et de bout en bout, relecture par la tâche périodique comprise. **Manque connu** : il n'existe pas encore d'écran des calendriers connectés ni de notification ou d'email pour les erreurs de sync ; seuls le DTO, les libellés et les journaux le signalent.

## Statuts

| `sync_status` | Sens                                                                                                                                   | Copie locale                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pending`     | sélectionné, jamais synchronisé (ou reconnexion en attente)                                                                            | vide, ou celle d'avant la reconnexion               |
| `syncing`     | une passe détient le claim                                                                                                             | inchangée jusqu'à la fin                            |
| `synced`      | dernière passe complète : la copie correspond au curseur                                                                               | complète pour la fenêtre                            |
| `degraded`    | dernière passe complète, mais avec marge : fuseau non fiable (`untrusted_timezone`) ou événements approximatifs (`approximate_events`) | complète, périodes incertaines élargies             |
| `stale`       | copie connue en retard : fuseau changé, passe interrompue par son budget, passe sans résultat                                          | gardée, bloque ; full sync ou reprise due           |
| `error`       | dernière passe en échec (Google indisponible, protocole, token…), `last_error` porte le code                                           | gardée, bloque                                      |
| `incomplete`  | calendrier au-delà de la sync bornée (`too_many_events`)                                                                               | ancienne copie + pages lues, bloque, jamais balayée |

**`degraded` dans un calendrier fiable.** Chaque événement porte `approximate` : vrai quand sa période a été élargie (fuseau propre inconnu, calendrier non fiable, ligne historique sans dates civiles) ou ajustée (bornes inversées). Une passe complète d'un calendrier fiable qui contient au moins un tel événement finit `degraded` avec `last_error = approximate_events`, jamais `synced`. Le libellé est alors « Synchronisé avec une marge ».

**Priorité des statuts.** `degraded` n'est posé que par une passe complète réussie : `error` et `incomplete` restent prioritaires en SQL, et `describeSyncStatus` n'affiche la marge de fuseau que si le statut est `degraded` (testé : `error` ou `incomplete` sur un calendrier non fiable ne parlent jamais de « marge »).

La connexion a son propre statut : `active`, `reauth_required` (copie gardée, plus de sync), `disconnected` (tout supprimé).

**Activation d'un calendrier bloquant.** Un calendrier tout juste sélectionné n'a, par définition, aucune copie complète antérieure : si sa première passe est `error` ou `incomplete`, seuls les événements déjà lus bloquent. Il n'est donc considéré **protecteur** qu'après sa première sync complète : le DTO expose `protecting` (`blocking` et `last_synced_at` renseigné). Une désélection remet `last_synced_at` à vide. Tant que `protecting` est faux, l'UI doit afficher « activation en cours » et ne jamais présenter l'intégration comme protégeant les disponibilités. Le produit ne bloque pas tout Booking pour autant.

**Politique de disponibilité.** La disponibilité utilise toujours les périodes connues localement, quel que soit le statut : une passe qui échoue ne vide jamais la copie. Seul `synced` garantit que tous les événements de la fenêtre sont connus ; dans les autres statuts, des événements que la sync n'a pas pu lire peuvent manquer, et **rien ne prétend qu'ils sont couverts** (le statut et `last_error` l'indiquent à l'UI).

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
  - renouvellement des canaux un jour avant expiration, **sans trou** : le nouveau canal est créé puis enregistré (ses notifications sont acceptées dès lors), une sync de rattrapage couvre ce qui a changé pendant le renouvellement, et seulement ensuite l'ancien est arrêté ;
  - **rattrapage** de tout calendrier non synchronisé depuis 6 heures, car Google ne garantit pas la livraison des notifications.

  **Équité.** Un calendrier en échec (`error`, `incomplete`) attend un backoff exponentiel (5 min × 2^échecs, plafonné à 6 h, `next_attempt_at`) avant d'être repris ; l'ordre est le tourniquet (`last_attempt_at` le plus ancien d'abord). Des calendriers cassés ne monopolisent donc jamais la tâche : le test `50 failing calendars never starve a healthy 51st` le vérifie.

## Disponibilité et réservation

- **Disponibilité.** `private.compute_available_slots` ajoute les périodes occupées (`private.external_busy`) à l'occupation des rendez-vous. Un créneau est proposé seulement si `[début, début + durée + buffer)` ne chevauche ni un rendez-vous occupant ni une période externe occupée. Il doit aussi tenir dans une plage ouverte, hors fermetures et blocs. Les bornes se touchant ne se chevauchent pas : `[)`.
- **Réservation.** `private.create_public_booking_at` revalide l'instant demandé avec cette même fonction, **sous le verrou de planning**. Une période externe synchronisée entre l'affichage et la réservation est donc refusée (`slot_unavailable`).
- **Verrous.** L'application d'une page d'événements, la fin d'une full sync, la sélection, la reconnexion et la déconnexion prennent le même verrou de planning (`business_schedule:<id>`) que les réservations, blocs et horaires, en READ COMMITTED. Une réservation voit une page entière ou rien. Aucun appel réseau n'a lieu pendant la détention du verrou.
- **Agenda professionnel.** La professionnelle peut toujours placer manuellement un rendez-vous sur une période externe : elle sait ce qu'elle fait, et le conflit est signalé. Les conflits utilisent la **plage occupée** du rendez-vous (`occupied_window`, buffer compris), la même que la disponibilité. Les blocs et les rendez-vous gardent leurs garanties existantes.

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

`disconnectGoogleCalendarAction` est idempotente et limitée à l'incarnation lue au départ. Elle procède en deux temps :

1. **En local, immédiatement, dans une transaction sous le verrou.** Les périodes, les calendriers, les curseurs, les canaux et les secrets sont supprimés, la connexion passe `disconnected` et reçoit une nouvelle incarnation (toute opération en cours devient sans effet). La disponibilité n'est plus bloquée et aucun rendez-vous n'est touché.
2. **Chez Google, au mieux, dans la fenêtre fixée par la déconnexion.** Les canaux sont arrêtés et le refresh token est révoqué, ce qui révoque l'autorisation. Un échec est seulement journalisé, car les canaux expirent d'eux-mêmes.

**Succès de l'action.** Une fois la transaction locale validée, l'action réussit. La préparation de la révocation (`calendar_begin_revocation`), l'arrêt des canaux, `/revoke` et `calendar_revocation_done` sont au mieux : un échec est journalisé, jamais renvoyé à l'UI. Testé pour chacun de ces échecs : action réussie, connexion déconnectée, secrets supprimés, aucune période restante.

**Révocation tardive.** Chez Google, révoquer un token révoque l'autorisation du compte pour l'application : une révocation qui arriverait après une reconnexion du même compte révoquerait la nouvelle. Le droit de révoquer est donc lié à la déconnexion elle-même, jamais à l'heure où le code appelant reprend la main :

- la transaction de déconnexion fixe `revocation_authorized_until = commit + 1 min` et `revocation_pending_until = commit + 2 min` ;
- `calendar_begin_revocation(id, incarnation de déconnexion)` renvoie le temps restant, mesuré par PostgreSQL, seulement si la connexion est toujours déconnectée **dans cette incarnation** (aucune reconnexion depuis) et si la fenêtre est ouverte ; sinon `null` et aucun appel Google ne part ;
- il est vérifié avant tout appel distant, puis **une dernière fois juste avant `/revoke`** ; chaque appel est borné par cette fenêtre ;
- une reconnexion est refusée (`calendar_disconnect_in_progress`, au démarrage comme au callback, résultat `disconnect_in_progress`) jusqu'à `revocation_pending_until`, une minute après la fin de la fenêtre ; `calendar_revocation_done` lève les deux bornes dès la fin de la révocation.

Testé : réponse de la déconnexion retardée de 3 minutes, reconnexion du même compte (ou d'un autre) pendant ce délai, puis reprise de l'ancien code : aucun appel `/revoke` ni `channels/stop`.

## Server Actions (`src/features/calendar/actions/calendar.ts`)

Toutes dérivent l'utilisateur et le business de la session. Aucune n'accepte d'identifiant de business, d'utilisateur ou de connexion.

| Action                                           | Entrée                                     | Succès (`data`)                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getCalendarIntegrationStatusAction()`           | —                                          | `{ provider, available, connection: { id, status, accountEmail, lastSyncedAt, lastError, version } \| null, calendars }`                                 |
| `startGoogleCalendarConnectAction()`             | —                                          | `{ authorizationUrl }`, à ouvrir en navigation pleine page                                                                                               |
| `listConnectedCalendarsAction({ refresh? })`     | `refresh: true` relit la liste chez Google | `ConnectedCalendarDto[]`                                                                                                                                 |
| `updateBlockingCalendarsAction({ calendarIds })` | ensemble complet, 50 au plus               | `ConnectedCalendarDto[]`, la sync suit après la réponse                                                                                                  |
| `syncGoogleCalendarNowAction()`                  | —                                          | `{ outcomes: { [calendarId]: "synced" \| "busy" \| "skipped" \| "superseded" \| "incomplete" \| "stale" \| "error" }, calendars }`, borné à environ 20 s |
| `disconnectGoogleCalendarAction()`               | —                                          | `{ disconnected: true }`                                                                                                                                 |
| `listCalendarConflictsAction({ from, to })`      | ISO 8601, 400 jours au plus                | `{ appointmentId, appointmentStartsAt, appointmentEndsAt, calendarId, eventStartsAt, eventEndsAt }[]`                                                    |

`ConnectedCalendarDto` : `{ id, name, timezone, primary, accessRole, selectable, blocking, protecting, syncStatus, lastSyncedAt, lastError }`. Avec `refresh: true`, les calendriers bloquants devenus `stale` (fuseau changé) sont resynchronisés après la réponse.

**Erreurs stables :**

- `calendar_not_configured` (503) ;
- `calendar_not_connected` (409) ;
- `calendar_reauth_required` (409) ;
- `calendar_provider_unavailable` (503) ;
- `calendar_not_found` (404) ;
- `calendar_scope_missing` (400) ;
- `calendar_not_selectable` (400) ;
- `calendar_disconnect_in_progress` (409) ;
- `conflict` (409) : la connexion a changé pendant l'opération (reconnexion ou déconnexion concurrente) ;
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

## Performance

Le script `scripts/perf/calendar-busy-explain.sql` (dans une transaction annulée, base locale intacte) crée un business avec N périodes réparties sur la fenêtre de 400 jours et 20 autres businesses de 2 500 périodes, puis exécute `EXPLAIN (ANALYZE, BUFFERS)` de la requête de `private.external_busy` :

```sh
docker exec -i supabase_db_booking-saas psql -U postgres -v events=2000 < scripts/perf/calendar-busy-explain.sql
docker exec -i supabase_db_booking-saas psql -U postgres -v events=10000 < scripts/perf/calendar-busy-explain.sql
```

Mesures locales (PostgreSQL 17, Supabase CLI) :

| Périodes du business (total table) | Requête                      | Plan                                                             | Tampons   | Exécution |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------------- | --------- | --------- |
| 2 000 (52 022)                     | un jour (liste des créneaux) | Bitmap Index Scan `external_calendar_events_busy_idx`, 5 lignes  | 4 (hit)   | 0,08 ms   |
| 2 000                              | `external_busy`, 30 jours    | —                                                                | 14 (hit)  | 0,36 ms   |
| 2 000                              | fenêtre entière (pire cas)   | Bitmap Index Scan, 1 800 lignes                                  | 79 (hit)  | 1,0 ms    |
| 10 000 (60 022)                    | un jour                      | Bitmap Index Scan `external_calendar_events_busy_idx`, 24 lignes | 5 (hit)   | 0,10 ms   |
| 10 000                             | `external_busy`, 30 jours    | —                                                                | 33 (hit)  | 0,53 ms   |
| 10 000                             | fenêtre entière (pire cas)   | Bitmap Index Scan, 9 000 lignes                                  | 346 (hit) | 4,7 ms    |

L'index GiST est utilisé dans tous les cas (aucun _Seq Scan_), et le coût d'un jour de créneaux ne dépend pas du volume total : il ne lit que les périodes du jour.

## Abstraction fournisseur

`src/features/calendar/providers/types.ts` définit `CalendarProvider`. Ce contrat couvre :

- l'URL d'autorisation, l'échange du code, le rafraîchissement et la révocation ;
- la liste des calendriers et des événements (full ou incrémentale) ;
- la création et l'arrêt des canaux push ;
- les erreurs classées : `auth_revoked`, `unauthorized`, `gone`, `rate_limited`, `unavailable`, `protocol`, etc. ;
- une échéance par appel (`{ deadline }`) et des réponses validées (jamais une page ou une liste partielle).

Tout ce qui est propre à Google se trouve dans `providers/google.ts`. Le domaine (sync, connexion, webhook, tâche) et les tables restent génériques : `provider` vaut `'google'` aujourd'hui. Microsoft 365 ou CalDAV s'ajouteront par un nouvel adaptateur et une valeur de `provider`.

## Limites connues

- **Canaux d'un compte remplacé.** Quand un autre compte remplace la connexion, les canaux de l'ancien compte ne sont pas arrêtés chez Google (ses identifiants sont remplacés dans la même transaction) : leurs notifications sont ignorées (réponse 204 uniforme) jusqu'à leur expiration (au plus 7 jours).
- **Calendriers sans fuseau.** Un calendrier que Google liste sans fuseau, ou avec un fuseau inconnu de PostgreSQL, ne peut pas être sélectionné. S'il l'était déjà, il continue d'être synchronisé avec une marge (`degraded`) jusqu'à ce qu'un fuseau connu revienne. Si la tzdata de PostgreSQL ne connaît pas un fuseau récent, la marge dure jusqu'à la mise à jour de PostgreSQL.
- **Lignes historiques.** Jusqu'à la full sync que la migration force, les journées entières stockées avant les dates civiles gardent leur fenêtre UTC. Elles sont élargies si le fuseau change entre-temps : sur-blocage temporaire.
- **Première version de `20261005090000` : non supportée.** Elle n'a été exécutée que localement et sur des bases CI éphémères, jamais sur `main` ni sur une base persistante (production ou staging). Elle a été corrigée directement dans cette PR. Le seul chemin d'upgrade supporté est `20261004090000` → `20261005090000` corrigée → migrations suivantes, et il est vérifié par `npm run test:upgrade`. Une base de développement qui a appliqué l'ancienne version doit être réinitialisée (`npm run db:reset`).
- **Fenêtre de révocation.** La révocation n'est tentée que dans la minute qui suit la déconnexion ; au-delà (serveur très lent), elle est abandonnée et l'autorisation reste valide chez Google jusqu'à ce que la professionnelle la retire elle-même.

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
