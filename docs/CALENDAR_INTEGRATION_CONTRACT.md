# Contrat — intégration calendrier (V1 : Google ⇄ Booking)

Ce document décrit le backend de l'intégration calendrier livré par les migrations `20261003090000_calendar_inbound_sync.sql`, `20261004090000_calendar_sync_hardening.sql` (incarnations, claims, générations, fuseaux, équité) `20261005090000_calendar_sync_hardening_2.sql` (reprojection atomique des fuseaux, CAS des secrets, fenêtre de révocation, intervalles stricts) `20261006090000_calendar_sync_hardening_3.sql` (aucun repli sur le fuseau du business, fuseaux stricts, lignes historiques préservées, attentes de verrou bornées) `20261007090000_calendar_sync_hardening_4.sql` (confiance dans le fuseau d'un calendrier, écriture du token rafraîchi décidée par PostgreSQL avant l'échéance), puis `20261010090000_calendar_outbound_core.sql` (miroir Booking → Google, voir « Miroir Booking → Google »). Il sert de contrat à la future UI et au déploiement.

## Principes

- **Booking SaaS reste la source de vérité des rendez-vous clientes.** Google ne crée, ne déplace et n'annule jamais un rendez-vous Booking.
- **Google est la source de vérité des événements personnels** de la professionnelle. Les périodes occupées des calendriers qu'elle sélectionne sont copiées localement (`external_calendar_events`) et bloquent la disponibilité publique.
- **Aucun appel à Google pendant une consultation ou une réservation.** La disponibilité et la transaction de réservation lisent uniquement la copie locale, indexée, dans PostgreSQL.
- **PostgreSQL reste l'autorité temporelle.** Les dates des événements « journée entière » sont converties par `private.local_day_start` dans le fuseau du calendrier. Les `dateTime` avec décalage explicite sont gardés tels quels, jamais reconstruits depuis l'heure murale.
- **Booking → Google : un miroir pratique, jamais une autorité.** Les rendez-vous sont copiés dans un calendrier secondaire que Booking crée lui-même. Une modification faite dans Google ne modifie jamais le rendez-vous Booking, et une panne de Google ne fait jamais échouer une réservation.

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
- intervalle **certainement** vide (un même instant donné par deux bornes **avec décalage explicite**, ou même date civile) : information sûre de Google, l'événement n'occupe plus de temps. Rien n'est créé, et sa copie existante est supprimée explicitement, en incrémental comme en full sync : jamais gardée avec des bornes périmées, jamais laissée au balayage. Même garde de fraîcheur qu'une mise à jour : une représentation plus ancienne (`updated`) ne supprime jamais une version plus récente, qui est gardée et marquée vue dans la génération courante (le balayage la conserve) ;
- même instant **sans** décalage (heure murale résolue par PostgreSQL) : pas certainement vide, puisque 02:30 existe deux fois à Paris le 25 octobre. Chaque borne sans décalage est élargie à tous les fuseaux et l'enveloppe bloque, marquée approximative ;
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
- le miroir Booking → Google, une fois activé, rend le rendez-vous visible dans Google (voir « Miroir Booking → Google »).

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

## Miroir Booking → Google (outbound)

**Booking reste la source de vérité absolue.** Google Calendar n'est qu'un miroir pratique. V1 :

- nouveau rendez-vous → événement Google ;
- déplacement, changement de prestation, de cliente ou de prénom → même événement mis à jour ;
- annulation → événement supprimé chez Google ;
- `completed` et `no_show` restent dans Google ;
- Google indisponible → Booking fonctionne normalement, le miroir rattrape plus tard.

Le backfill des rendez-vous jamais enrôlés et la réconciliation après une modification manuelle dans Google (#11b) sont décrits plus bas. Hors périmètre V1 : choix d'un calendrier existant, plusieurs calendriers, nettoyage des doublons ou des événements créés à la main, toute écriture Google → Booking.

### Scope et autorisation incrémentale

Scope retenu : `https://www.googleapis.com/auth/calendar.app.created` (« Make secondary Google calendars, and see, create, change, and delete events on them »). D'après la documentation de Google, il est accepté par `calendars.insert`, `events.insert`, `events.patch`, `events.update`, `events.delete` et `events.list`, uniquement sur les calendriers créés par l'application : Booking ne peut écrire dans aucun autre calendrier. Aucun scope plus large (`calendar.events`, `calendar`) n'est demandé.

Ce scope ne permet pas de choisir l'id d'un calendrier ni de lister les calendriers (`calendarList.list` exige un scope `calendarlist`). La récupération après une réponse perdue utilise donc le scope de lecture déjà accordé par la connexion (`calendar.calendarlist.readonly`) : aucun élargissement.

L'autorisation d'écriture s'ajoute à la connexion existante (`startGoogleCalendarWriteAuthorizationAction`) :

- l'URL ne demande que `openid` (pour prouver le compte qui répond) et le scope d'écriture, avec `include_granted_scopes=true`, `login_hint` = l'id du compte connecté, `access_type=offline`, `prompt=consent`, PKCE ;
- l'état OAuth porte un objet (`purpose = 'write'`), consommé par le même callback ;
- **même compte obligatoire** : le `sub` de l'id_token doit être exactement `provider_account_id`. Sinon, refus (`calendar_account_mismatch`, résultat `account_mismatch`) avant toute écriture : aucun secret, scope ou calendrier de l'autre compte n'est stocké, la connexion d'origine et ses calendriers sont intacts (testé) ;
- l'incarnation (`credential_generation`) est **conservée** : calendriers sélectionnés, état de sync et identifiants restent valides. Les scopes sont fusionnés ; le nouveau refresh token (autorisation combinée) remplace l'ancien, et s'il n'y en a pas, l'ancien est gardé ;
- si la professionnelle décoche le scope d'écriture, `calendar_scope_missing` ; rien n'est activé ;
- l'autorisation réussie active l'outbound (intention explicite de la professionnelle).

### Calendrier dédié

À l'activation, Booking crée `Rendez-vous — <nom du business>`, unique destination du business. Aucun calendrier personnel n'est jamais choisi implicitement, il n'y a pas de sélecteur en V1. Son id Google est stocké (`private.calendar_outbound.provider_calendar_id`) et ajouté à l'historique des calendriers créés (`private.calendar_outbound_calendars`).

**Création sans doublon automatique.** Google ne fournit aucune primitive d'idempotence forte pour `calendars.insert` : l'id d'un calendrier secondaire ne peut pas être choisi, et une réponse perdue peut cacher un calendrier créé que `calendarList` ne montre pas encore. Après un résultat réellement ambigu, Booking privilégie donc l'absence de doublon automatique plutôt qu'une recréation agressive.

1. **Un seul créateur à la fois** : claim et bail de 2 min en SQL.
2. **Toujours chercher d'abord, décider ensuite.** Le worker lit la liste des calendriers et construit l'ensemble complet des cibles possibles avant toute décision :
   - les calendriers déjà adoptés par ce business pour ce compte (id dans son historique) : preuve locale, valides tels quels ;
   - les **candidats** dont la description porte `booking-saas:<marqueur du business>:<nonce>`, quel que soit le nonce. Le nonce est propre à chaque tentative de création et ne donne aucune priorité. Un candidat déjà attribué à un autre business (ou à ce business sous un autre compte Google) est écarté **avant tout envoi**, sentinelle comprise (`calendar_outbound_attributed_elsewhere`).
3. **Le marqueur ne prouve rien.** Une description peut être copiée. Un candidat n'est valide qu'après une **preuve positive** : l'écriture d'un événement sentinelle (id propre à la tentative, aucune donnée personnelle, `sendUpdates=none`, supprimé aussitôt). Avec nos scopes, seuls les calendriers créés par l'application acceptent une écriture : `calendar.app.created` ne couvre que ceux-là, et les autres scopes sont en lecture seule. Un calendrier personnel portant un marqueur copié répond 403 et n'est jamais adopté. La documentation de Google accepte aussi `calendar.app.created` pour `calendars.update`, mais cette preuve modifierait les métadonnées visibles du calendrier ; l'événement sentinelle teste exactement la capacité dont l'outbound dépend. **Décision**, une fois toutes les preuves faites : exactement une cible valide (historique et candidats prouvés réunis) est adoptée, et seulement si SQL l'attribue à ce business (voir « Un calendrier Google, un seul business »). Plusieurs cibles valides ne sont jamais départagées arbitrairement, même si l'une vient de l'historique ou porte le nonce de la tentative en cours : `action_required` (`calendar_creation_uncertain`). Au-delà de 5 candidats, l'ensemble n'est pas décidable dans une étape : `calendar_creation_uncertain` aussi.
4. **Au plus un insert par tentative.** `creation_requested_at` est enregistré et commité avant `calendars.insert`, et `mark_creation_requested` ne l'accorde qu'une fois par tentative. Le client HTTP ne relance jamais cet appel.
5. **Échec certain** (requête refusée : 4xx, 429, ou token indisponible avant tout envoi) : `creation_requested_at` est effacé, et la tentative peut renvoyer un insert plus tard (backoff de 30 s à 1 h).
6. **Résultat ambigu** (timeout, réseau, 5xx, réponse illisible) : plus aucun insert automatique pour cette tentative. Seules des recherches bornées suivent (5, espacées de 1 à 16 min), puis `action_required` (`calendar_creation_uncertain`).
7. **Action explicite de la professionnelle** (réactiver) : nouvelle génération et nouveau nonce. La nouvelle tentative recommence par la recherche et adopte un calendrier perdu devenu visible (preuve faite) ; elle n'envoie un nouvel insert que si rien n'est trouvé.

Testé :

- réponse perdue, calendrier invisible pendant plusieurs passages et deux workers concurrents : un seul insert, puis adoption du même calendrier quand il apparaît ;
- jamais visible : 4 recherches, puis `calendar_creation_uncertain`, toujours un seul insert ; la réactivation retrouve le calendrier sans en créer un second ;
- échec certain (400, 429) : nouvel insert permis, un seul calendrier ;
- trois initialisations concurrentes : un seul calendrier ;
- deux calendriers créés par l'application portent le marqueur et passent la preuve (celui de la tentative en cours et celui d'une tentative antérieure) : `calendar_creation_uncertain`, aucun n'est adopté ;
- un calendrier de l'historique et un autre candidat prouvé : `calendar_creation_uncertain` (l'historique ne court-circuite pas l'ambiguïté) ; l'autre retiré, une nouvelle tentative retrouve le premier.

**Un calendrier Google, un seul business.** Invariant : un `provider_calendar_id` connu ne peut être attribué qu'à un seul business. La sentinelle prouve seulement « créé par notre application » : pour deux businesses connectés au même compte Google, avec la même application OAuth, elle réussit pour les deux. Elle ne prouve pas « créé pour ce business ». L'attribution est donc décidée par PostgreSQL, atomiquement :

- clé primaire `(provider, provider_calendar_id)` de `private.calendar_outbound_calendars` : une seule ligne, donc un seul business, par calendrier ;
- `calendar_outbound_adopt_calendar` insère l'attribution (`on conflict do nothing`), puis relit le propriétaire validé. Même business et même compte Google : adoption (`adopted`). Sinon : `attributed_elsewhere`, et rien n'est adopté, rejoué ni exclu ;
- deux adoptions concurrentes du même id : la seconde attend sur la clé la fin de la transaction de la première. La première validée gagne, l'autre est refusée ; si la première est annulée, la seconde l'obtient. Jamais une décision prise sur une lecture antérieure ;
- la vérification côté worker (`calendar_outbound_attributed_elsewhere`) n'est qu'une précaution : elle évite toute écriture, sentinelle comprise, dans le calendrier d'un autre business. La garantie reste la clé ;
- l'historique n'est jamais purgé lors d'un changement d'incarnation : il garde l'attribution et le filtre inbound. Il ne disparaît qu'avec son business (réattribution après la suppression d'un business : hors périmètre V1) ;
- pour un autre business du même compte Google, ce calendrier reste un calendrier ordinaire : sélectionnable, et bloquant s'il est choisi (aucun faux filtre inbound).

Testé :

- deux businesses sur le même compte Google ; le calendrier de A porte le marqueur et le nonce exacts de B, et la sentinelle réussirait. B ne l'adopte jamais, ni par son worker ni par un appel SQL avec toute son autorité ; A le garde ; aucune écriture de B ne l'atteint ; B le garde comme source bloquante ;
- sans réponse perdue, B l'ignore et crée son propre calendrier ;
- adoption concurrente du même id par deux businesses, en vraies transactions (commit et rollback de la première) : un seul l'obtient ;
- un calendrier déjà attribué au même business est retrouvé normalement, sans nouvelle attribution.

**Jamais une source de disponibilité, mais seulement sur preuve.** `booking_outbound` reflète uniquement la connaissance locale établie : l'id figure dans l'historique des calendriers que l'application a créés ou adoptés après preuve (`private.calendar_outbound_calendars`), calculé par trigger. Un tel calendrier :

- n'est pas sélectionnable (`calendar_not_selectable`, garde SQL) ;
- perd son état de sync et ses périodes copiées ;
- est exposé dans le DTO avec `bookingCalendar: true`.

Un rendez-vous Booking ne revient donc jamais comme indisponibilité externe (testé de bout en bout). Une description modifiée ne change rien pour un id connu. Un id inconnu ne devient jamais « Booking » à cause de sa description. Testé : un calendrier personnel bloquant qui porte une copie exacte du marqueur reste sélectionné, garde ses périodes occupées et continue de bloquer ; il n'est jamais adopté, sa preuve étant refusée. Le vrai calendrier, prouvé, est adopté puis exclu.

### Desired state (outbox)

`private.appointment_calendar_mirrors`, une ligne par rendez-vous :

| Colonne                                                                      | Rôle                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `appointment_id`, `business_id`, `provider`                                  | rendez-vous (sans clé étrangère : un rendez-vous supprimé garde son miroir jusqu'à la suppression de l'événement) |
| `event_id`                                                                   | id Google déterministe                                                                                            |
| `provider_calendar_id`                                                       | calendrier où l'événement peut exister, enregistré **avant** toute écriture Google                                |
| `desired_revision`, `applied_revision`                                       | changements pertinents enregistrés / dernier appliqué chez Google                                                 |
| `attempts`, `next_attempt_at`, `last_error`                                  | reprises avec backoff borné                                                                                       |
| `claim_id`, `lease_until`, `claim_generation`, `claim_credential_generation` | autorité capturée par le worker                                                                                   |
| `repair_generation`, `repaired_generation`                                   | dérive constatée par la réconciliation / dernière réparation appliquée (#11b)                                     |
| `applied_at`                                                                 | dernière application réussie chez Google (une page listée avant elle peut la précéder)                            |
| `seen_scan`                                                                  | dernier scan complet qui a listé l'événement                                                                      |

L'état souhaité n'est pas recopié : le worker le dérive du rendez-vous au moment où il le traite (le dernier état gagne, les états intermédiaires ne sont jamais envoyés). La connexion et le calendrier cible se lisent dans `private.calendar_outbound`, sans stockage redondant.

**Enregistrement.** Un trigger sur `appointments` (après insertion, modification ou suppression) couvre tous les chemins : réservation publique, création manuelle, modification, déplacement, statut, annulation, et toute écriture future. Il ne fait qu'une insertion ou une incrémentation locale dans la transaction du rendez-vous, n'appelle jamais Google et ne prend aucun verrou nouveau sur la configuration. Seuls comptent `starts_at`, `ends_at`, `status`, `service_name_snapshot`, `client_id` (une note interne ne déclenche rien). Un renommage du prénom de la cliente incrémente ses miroirs existants. Un nouveau miroir n'est créé que si l'outbound est inscrit (`creating`, `active`, `action_required`) ; un miroir existant suit toujours son rendez-vous.

**Traitement.** Après la réponse (`runAfterResponse`, best effort) des actions agenda et de la réservation publique, puis par la tâche périodique (`/api/cron/calendar`, rattrapage durable). Si le process meurt après le commit, le miroir reste dû ; un claim abandonné expire (bail de 2 min).

### Événement Google

- id : `bk` + uuid du rendez-vous en hexadécimal (34 caractères, alphabet base32hex `a-v0-9` exigé par Google, 5 à 1024 caractères, unique par calendrier). Stable, jamais dérivé d'une donnée modifiable ;
- début `starts_at`, fin `ends_at` du rendez-vous : instants UTC de PostgreSQL, sans conversion dans Node. Le buffer n'allonge jamais l'événement visible (14:00–15:00 chez Google, 14:00–15:15 bloqué dans Booking) ;
- titre `Prénom — Prestation` ; `status: confirmed`, `transparency: opaque` ;
- `extendedProperties.private` : `origin = booking-saas`, `appointmentId`, `revision`. Aucun secret, aucune donnée personnelle de plus ; la base locale reste l'autorité ;
- jamais de participant, de description, de note interne, de téléphone, d'email ni de donnée CRM ou fidélité ; `sendUpdates=none` sur chaque écriture (aucune invitation ni notification).

### Création, mise à jour, annulation

**Champs gérés par Booking** (une seule définition, `eventBody` dans `providers/google.ts`, partagée par l'insertion, la mise à jour partielle, la restauration et la comparaison de la réconciliation) : `summary`, `start.dateTime`, `end.dateTime`, `status` (`confirmed`, ou l'absence), `transparency` (`opaque`), et les clés `origin`, `appointmentId` et `revision` de `extendedProperties.private`. Tout le reste appartient à la professionnelle : description, lieu, couleur, rappels, participants, visibilité, visioconférence, autres propriétés privées. Booking ne le lit, ne le compare ni ne l'efface jamais, sauf lors d'une restauration (voir ci-dessous).

- **État actif** (`confirmed`, `completed`, `no_show`) :
  - **mise à jour ordinaire** : si l'événement a pu être écrit dans le calendrier cible, `events.patch` avec les seuls champs gérés. Une seule requête, jamais de lecture avant. La réponse est réduite à `fields=id,status` et donne le statut après l'écriture. La sémantique de patch de Google est la suivante : un champ non envoyé est inchangé, un objet imbriqué est fusionné clé par clé, `null` retire une clé, un tableau est remplacé. Conséquences :
    - les champs de la professionnelle restent ;
    - `extendedProperties.private` est fusionné : les clés de Booking sont écrites, les autres sont gardées ;
    - `start` et `end` sont envoyés avec `date: null`, ce qui retire une date « journée entière » posée à la main. Un `timeZone` nommé est gardé : avec un décalage explicite, il ne change pas l'instant ;
  - **événement absent** : un 404 du patch (jamais écrit, ou purgé) bascule sur `events.insert` avec l'id déterministe. Un **409** à l'insertion (id déjà présent : insertion dont la réponse s'est perdue, ou événement supprimé dont Google garde l'id) n'est pas une erreur. L'événement repasse par la mise à jour partielle, puis par la restauration s'il le faut ;
  - **restauration, chemin distinct** : un événement supprimé chez Google se reconnaît sans lecture préalable. Soit le patch le laisse `cancelled` (statut renvoyé par la réponse), soit il répond 410. Booking le réécrit alors entièrement par `events.update` (PUT) avec `status: confirmed` et le même id. C'est le seul cas où un PUT est envoyé (la sentinelle de création mise à part). Il recrée l'événement canonique : les champs manuels d'un événement supprimé ne sont pas promis. La documentation de Google indique que, dans le calendrier de l'organisateur, un événement annulé garde ses détails « so that they can be restored (undeleted) », sans nommer la méthode. La documentation ne dit pas qu'un patch suffit à restaurer, d'où ce chemin dédié, et le writer converge que le patch restaure, laisse annulé ou réponde 410 (testé dans les trois cas). Une restauration réelle reste à valider manuellement (voir plus bas) ;
  - **coût** : `events.patch` coûte 3 unités de quota contre 1 pour `events.update`. C'est accepté : une seule requête par écriture, contre une lecture et un remplacement s'il fallait reconstruire l'événement complet pour préserver ses champs.
- **Annulé ou supprimé** : `events.delete` si l'événement a pu être écrit dans le calendrier cible ; 404 ou 410 est un succès logique. Rien n'est appelé pour un rendez-vous annulé avant d'avoir été envoyé.
- **Réponse perdue** : le client HTTP relance automatiquement les insertions (sûr grâce à l'id déterministe), et le calendrier cible est enregistré avant l'appel : une insertion perdue puis annulée est bien supprimée (testé).

### Générations et concurrence

`private.calendar_outbound.generation` change à chaque changement d'autorité : activation ou réactivation, désactivation, passage en `action_required`, déconnexion, autre compte Google. Un worker capture avec son claim la génération outbound, l'incarnation des identifiants et la révision ; SQL revérifie le tout avant d'enregistrer un résultat, **succès comme erreur** : `complete_mirror`, `fail_mirror`, `mark_action_required` (claim du miroir, génération, identifiants, compte) ; `mark_creation_requested`, `adopt_calendar`, `creation_failed` (claim de création, génération, identifiants, compte). Sinon : `superseded`, aucune écriture locale. Un worker périmé ne peut ni effacer la cible courante, ni passer la configuration en `action_required`, ni toucher à l'état de reprise (testé : 403 tardif et échec de création tardif après une reconnexion du même compte).

**Gardes strictes.** Les gardes d'autorité renvoient strictement vrai ou faux, jamais `NULL` : `creation_claim_valid` (`coalesce(…, false)` et comparaison `=` : un claim libéré, `creation_claim_id` nul, n'est jamais accepté), `has_write_scope` (même avec un élément nul), `mirror_claim_valid` (jamais pour un claim nul). Les appelants testent `is not true`. Testé : un worker dont le claim a expiré revient après que le claim suivant a été libéré (colonne nulle). La garde répond `false`, et ni adoption, ni insert, ni état de reprise, ni `action_required`, ni cible, ni génération ne changent.

**Transitions globales décidées sur une réponse Google.** L'autorité est tenue de la vérification jusqu'à l'écriture, dans l'ordre global des verrous : connexion (`for share`), ligne outbound (`for update`), miroir. `mark_action_required` verrouille la connexion avant de lire la génération des identifiants, le compte et l'incarnation ; les étapes de création le font déjà (`creation_claim_valid`). Une reconnexion (nouvelle génération d'identifiants, même compte compris) est donc soit commitée avant la vérification, qui la voit (worker périmé : rien n'est écrit), soit mise en attente jusqu'à la fin de la transition. Elle ne peut plus s'intercaler entre la vérification et l'écriture. Testé avec de vraies transactions entrelacées, dans les deux ordres : la transition de N puis N+1, ou N+1 d'abord et le worker n'écrit rien. Une erreur de N ne s'applique jamais à N+1. Même vérification pour `creation_failed`.

**Activation.** `calendar_outbound_enable` verrouille la ligne de connexion (`for share`) avant la ligne outbound, dans l'ordre global, et n'utilise que les valeurs lues sous ce verrou. Deux cas en concurrence avec une reconnexion vers un autre compte :

- la reconnexion est commitée d'abord : l'activation l'attend et active le compte B ;
- l'activation est commitée d'abord : la reconnexion l'attend puis la désactive (`account_changed`), et une activation normale répare.

Jamais d'état `creating` mêlant A et B. Testé avec de vraies transactions entrelacées. Les ids déterministes rendent sans danger une écriture Google tardive ou en double.

Testé : création puis annulation avant le worker (aucun appel) ; création puis deux déplacements (une seule insertion, à l'heure finale) ; trois workers sur le même rendez-vous (un événement) ; révision enregistrée pendant l'appel Google (reste due, le dernier état gagne) ; worker en cours puis déconnexion, reconnexion, désactivation, `action_required` ou réactivation sur un nouveau calendrier (réponse tardive sans autorité) ; claim abandonné (expire, puis converge).

### Erreurs et reprises

| Erreur                                                                                                                                | Portée        | Effet                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| réseau, réponse perdue, 5xx, 429, 403 de limite (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`) | rendez-vous   | reprise avec backoff (30 s × 2ⁿ, ±20 %, au plus 6 h) ; une limite (429 ou 403) arrête le business pour ce passage |
| 401                                                                                                                                   | —             | token rafraîchi une fois, puis reprise                                                                            |
| `invalid_grant`                                                                                                                       | connexion     | `reauth_required` (contrat inbound) : plus aucun appel, état `reconnect`                                          |
| autre 403 (permission : calendrier non créé par l'app, scope retiré, `insufficientPermissions`, `forbiddenForNonOrganizer`…)          | configuration | `action_required` (`write_authorization_required`)                                                                |
| 404 sur le calendrier (vérifié par `calendars.get`)                                                                                   | configuration | `action_required` (`calendar_deleted`)                                                                            |
| 404 / 410 sur un événement à supprimer                                                                                                | rendez-vous   | succès                                                                                                            |
| 409                                                                                                                                   | rendez-vous   | réconciliation par mise à jour                                                                                    |
| réponse invalide                                                                                                                      | rendez-vous   | reprise                                                                                                           |

Une erreur de configuration arrête tout le business à la première occurrence. Ses autres miroirs ne sont ni tentés ni retentés un par un. Testé avec 200 rendez-vous et un calendrier supprimé : 2 appels (l'insertion en 404 et la vérification du calendrier), puis plus aucun. Équité : au plus 10 miroirs par business et par passage, les plus anciens d'abord. Dans la tâche périodique, chaque sens a une échéance réelle, pas seulement un test du temps entre deux opérations. L'inbound (listes et syncs) s'arrête à 60 % du budget, quoi qu'il attende (appel Google ou base) : son signal est annulé (les appels base de l'orchestrateur sont annulables), la tâche cesse d'attendre et l'outbound démarre avec le reste du budget. Une réponse ou un échec tardif est consommé, jamais un rejet non géré. L'outbound s'arrête de même à l'échéance du passage, et il ne commence qu'après l'inbound, qu'il ne peut donc pas affamer. Une erreur de l'inbound ne le prive pas non plus de son tour : elle est signalée après lui. Un appel abandonné peut encore aboutir en base ; toutes les écritures inbound et outbound sont des claims ou des compare-and-set SQL, sans effet nuisible en retard. Testé : RPC inbound qui ne répond pas (vraie attente de verrou) pendant presque tout le budget, syncs lentes, outbound lent, réponses et échecs tardifs. Une erreur Google ne modifie jamais le rendez-vous.

### Calendrier dédié supprimé : `action_required`

Décision V1 : Booking ne recrée **jamais** le calendrier de lui-même, car la suppression peut être volontaire.

- au prochain appel Google qui constate l'absence du calendrier, l'outbound passe `action_required` (`calendar_deleted`), sous une nouvelle génération ;
- les rendez-vous ne sont jamais touchés ; aucun autre calendrier n'est choisi ;
- **pendant `action_required`, Booking fonctionne normalement.** Créations, déplacements et annulations continuent d'enregistrer leur état souhaité, coalescé (un compteur de révision par rendez-vous, jamais une file d'opérations). Aucun appel Google n'est fait : aucun claim n'est accordé tant que l'état reste `action_required` ;
- **réactivation explicite** (`reactivateCalendarOutboundAction`) :
  1. nouvelle génération (les anciens workers perdent toute autorité) ;
  2. création ou récupération d'un calendrier dédié, selon la stratégie idempotente ;
  3. **replay** : tous les miroirs déjà enrôlés dont le rendez-vous doit toujours exister convergent vers le nouveau calendrier, qu'ils aient été synchronisés avant la suppression, modifiés ou créés pendant `action_required` (voir « Nouvelle incarnation : replay des miroirs enrôlés »).

### Nouvelle incarnation : replay des miroirs enrôlés

Invariant : après chaque nouvelle incarnation, le nouveau calendrier finit par contenir **tous les rendez-vous actifs déjà enrôlés** dans l'outbound, pas seulement ceux qui ont changé depuis. Une nouvelle incarnation, c'est l'adoption d'un calendrier dédié différent de celui où les événements avaient été écrits :

- **calendrier supprimé** : `action_required`, puis réactivation et nouveau calendrier ;
- **autre compte Google** : passage du compte A au compte B, puis activation explicite et nouveau calendrier chez B.

Mécanisme, dans la transaction qui adopte le calendrier (`calendar_outbound_adopt_calendar`) :

- la génération outbound a déjà changé à l'activation : les claims et workers de l'ancienne incarnation n'ont plus d'autorité ;
- chaque miroir **de ce business** dont le rendez-vous existe et n'est pas annulé, et dont l'événement n'est pas dans le nouveau calendrier, repasse à `applied_revision = 0`. Sa dernière révision souhaitée est gardée ;
- tous les miroirs en attente deviennent dus ; le worker normal les insère avec le même id déterministe. Il n'y a pas d'architecture de replay séparée ;
- un rendez-vous annulé ou supprimé n'est jamais recréé dans le nouveau calendrier, pas même pour y être supprimé ensuite ;
- si le calendrier adopté est le même (même compte, retrouvé par son marqueur), rien n'est rejoué : ses événements y sont déjà.

**Replay ≠ backfill.**

- Le replay part uniquement des miroirs déjà enrôlés de ce business, en joignant leurs rendez-vous par clé primaire ; il ne parcourt jamais la table des rendez-vous.
- Un rendez-vous sans miroir (antérieur à la toute première activation, créé pendant une désactivation) n'est pas découvert par le replay : c'est le backfill, ci-dessous, par la tâche périodique suivante.

Testé :

- **calendrier supprimé** : A synchronisé et inchangé, B déplacé pendant `action_required`, C annulé, D créé. Après réactivation : A, B (dernière heure) et D dans le nouveau calendrier, une insertion chacun ; C non recréé ; le rendez-vous jamais enrôlé n'est pas découvert ; le miroir d'un autre business est intact ;
- **compte A → B** : A1 et A2 inchangés sont rejoués chez B avec les mêmes ids, sans doublon. Le worker de A en cours devient no-op ; aucune écriture vers le calendrier A ; ses événements y restent.

### Backfill des rendez-vous jamais enrôlés (#11b)

Un rendez-vous n'a de miroir que s'il a été écrit pendant que l'outbound était inscrit. Restent sans miroir : les rendez-vous antérieurs à la première activation, ceux créés pendant une désactivation volontaire, et ceux qu'un code plus ancien aurait manqués. `calendar_outbound_backfill` les inscrit :

- **qui** : tout rendez-vous du business dont l'événement doit exister (statut ≠ `cancelled`, même prédicat que le writer) et qui **n'est pas terminé** (`ends_at > now()`), sans miroir. Jamais d'historique ;
- **quand** : uniquement par la tâche périodique (`processOutbound` sans `businessId`). Jamais dans la transaction d'activation, de réactivation, d'un rendez-vous ou d'une requête ; le kick après une action ne l'exécute pas ;
- **comment** : par lots bornés (5 businesses, 100 rendez-vous par business et par passage), dans un ordre déterministe (fin la plus proche, puis id), `insert … on conflict do nothing`. Le miroir créé est un miroir ordinaire (révision 1) : le writer normal l'applique, avec le même claim, les mêmes reprises, le même classement d'erreurs et le même modèle de worker périmé. Aucun second writer ;
- **planning** : `calendar_outbound.backfill_next_at`. `null` = dû (nouvelle ligne, et chaque nouvelle génération : activation, réactivation, désactivation, via un trigger), lot plein ou reste à inscrire = dû au passage suivant, sinon vérification de sécurité 6 h plus tard ;
- **états** : `creating`, `active` et `action_required` inscrivent (inscription locale seulement, aucun appel Google tant que l'état n'est pas `active`) ; `disabled` n'inscrit rien.

**Concurrence.** La ligne outbound de chaque business est verrouillée (`for update skip locked`) et son statut relu sous le verrou :

- deux backfills : le second passe au business suivant ; jamais deux inscriptions ;
- trigger contre backfill : la clé du miroir les départage. Un rendez-vous annulé pendant son inscription attend la fin du backfill, puis incrémente la révision : le writer dérive l'absence au moment du claim et n'écrit rien ;
- désactivation contre backfill : une désactivation commitée avant est vue ; une désactivation ultérieure attend la fin du lot. Les miroirs inscrits suivent alors l'outbound désactivé comme tout miroir existant (aucun appel) ;
- changement d'incarnation : un miroir inscrit pendant `creating` est appliqué au calendrier adopté ensuite.

Index : `appointments_outbound_backfill_idx (business_id, ends_at) where status <> 'cancelled'`. Sans lui, chaque passage relit tout l'historique du business pour trouver les quelques rendez-vous non terminés.

Testé : rendez-vous antérieurs à l'activation (terminés et annulés exclus) ; créé pendant une désactivation, inscrit après la réactivation et jamais pendant ; lots bornés et ordre déterministe ; `action_required` sans appel Google ; inscription pendant `creating` ; deux backfills, annulation et désactivation concurrentes en vraies transactions.

### Dérive et réconciliation (#11b)

La tâche périodique relit le calendrier dédié **courant** de chaque business actif et corrige ce qui a été modifié à la main chez Google.

**Lecture** (`listOwnedEvents`) : `events.list` avec des paramètres fixes, identiques à chaque requête d'une même lecture comme Google l'exige :

- `showDeleted=true`, `maxResults=250`, sans borne de temps ni `singleEvents` (incompatibles avec un sync token) ;
- masque de champs limité à ce que Booking possède : id, statut, titre, début, fin, transparence, propriétés privées. Jamais de description, de participants ni de notes.

Le déroulé :

1. un **scan complet** d'abord, paginé ;
2. puis des lectures **incrémentales** avec le `nextSyncToken` ;
3. un `410` (token expiré) ou un curseur refusé efface le curseur, et le passage suivant refait un scan complet.

L'état est privé (`private.calendar_outbound_reconciliation`, une ligne par business) : curseur, scan en cours, prochaine lecture, claim et reprises. Il est valable pour un calendrier et une génération outbound seulement : tout autre calendrier ou génération (réactivation, nouvelle incarnation) le réinitialise. Il est séparé de l'inbound : rien de ce qui est lu ici ne devient une indisponibilité, `external_calendar_events` n'est jamais touché. Les tokens de sync ne quittent jamais le serveur : ni DTO, ni navigateur, ni log.

**Comparaison.** Seuls comptent les événements dont l'id est l'id déterministe d'un miroir **de ce business** (`bk` + uuid) ; l'autorité vient du miroir local et de l'id, jamais des métadonnées distantes. Sont ignorés : les événements de la professionnelle, les ids ressemblants sans miroir, les sentinelles, et l'événement d'un autre business copié ici (aucun nettoyage de doublon). Pour chaque événement retenu, `reconciliation_snapshot` fournit l'état local et `ownedEventDiffers` compare avec ce que le writer enverrait maintenant, **avec le même sérialiseur** (`outboundEvent` + corps Google). La comparaison porte sur :

- la présence : annulé = absent ;
- le statut (`confirmed`) et le titre ;
- les deux instants, comparés comme instants : tout décalage RFC 3339 accepté, précision sous la seconde ignorée ; une borne « journée entière » ou sans décalage diffère ;
- la transparence : absente = `opaque`, la valeur par défaut que Google omet ;
- les propriétés privées `origin` et `appointmentId`. `revision` est informative et n'est pas comparée.

Les champs que Booking n'écrit pas (description, couleur, rappels) ne sont jamais comparés. Un rendez-vous terminé n'est pas comparé non plus : l'historique n'est pas réparé. Un miroir dont une révision est en attente, ou dont une écriture est en cours, **est** comparé, avec ce que Booking dit maintenant (voir ci-dessous).

**Réparation**, dans le writer existant :

- une dérive incrémente `repair_generation`, jamais `desired_revision`. Le miroir redevient dû et le writer normal le traite avec le même claim, les mêmes reprises et le même classement d'erreurs ;
- `complete_mirror(…, p_repair_generation)` acquitte au plus la génération capturée par son claim (`greatest` et `least` : compare-and-set). Un succès ancien n'efface donc jamais une dérive plus récente ;
- présent → mise à jour partielle des champs gérés (`events.patch`), puis restauration (`events.update`) seulement si l'événement est supprimé chez Google : une dérive des seuls champs gérés n'efface jamais ce que la professionnelle a ajouté ;
- absent → `events.delete`. Avec une réparation, la suppression se fait dans la cible même si aucune écriture n'y était enregistrée.

**Une dérive observée n'est jamais perdue.** Le curseur enregistré avec une page consomme chez Google les changements qu'elle contient : une modification lue puis ignorée ne revient jamais dans une lecture incrémentale. Invariant : un changement de Google dont les champs gérés diffèrent de l'état Booking n'est acquitté par le curseur que si une demande de réparation qui le couvre est enregistrée dans la même transaction. La page n'est enregistrée qu'avec toute l'autorité du claim, en une seule transaction PostgreSQL (`calendar_outbound_reconciliation_page`) : réparations, marques du scan et curseur ensemble. Si l'enregistrement échoue, rien n'est enregistré ; le claim expire, et la page est relue depuis l'ancien curseur.

La demande est donc enregistrée quel que soit l'état du writer :

- révision en attente ;
- écriture en cours chez Google ;
- écriture appliquée après la demande de la page (`applied_at >= page_started_at`).

Un writer en vol acquitte au plus la génération de réparation capturée par son claim, donc la nouvelle reste due après son succès, et le writer normal réécrit ensuite les champs gérés. Une page lue avant qu'une écriture Booking n'arrive chez Google ne se distingue pas d'une modification manuelle faite après : elle produit au plus une mise à jour redondante et idempotente. La lecture suivante renvoie alors l'écriture de Booking elle-même, identique : pas de boucle.

Une réparation ne fait que réappliquer ce que Booking dit au moment du claim du writer. Elle ne fait jamais de l'état distant un état souhaité, n'acquitte jamais une révision et ne ressuscite jamais un rendez-vous annulé dans Booking : un rendez-vous annulé entre-temps est supprimé chez Google.

**Événements manquants.** Une suppression faite chez Google après le dernier curseur revient dans la lecture incrémentale suivante, comme un événement `cancelled` (Google renvoie les entrées supprimées depuis le token précédent). Elle est alors une dérive observée comme les autres. L'absence d'un événement que Google ne liste pas du tout est une **inférence**, faite seulement dans un scan complet : au premier passage, ou après un `410`. Elle est décidée **uniquement à la fin d'un scan complet réussi**, par la page qui porte le `nextSyncToken`. Est alors réparé tout miroir qui remplit toutes ces conditions (gardes propres à l'inférence, qui n'existent pas pour une dérive observée) :

- son rendez-vous est actif et non terminé ;
- il a été écrit dans ce calendrier avant le début du scan ;
- il n'a rien en attente ;
- il n'a pas été vu par le scan.

Un scan qui échoue en cours de route ne décide rien : il reprend à sa page, ou recommence après un `410`. Ses premières pages ne valent jamais un scan complet.

**Erreurs**, classées comme pour le writer :

| Erreur                                     | Effet                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| 5xx, réseau, réponse perdue ou invalide    | reprise avec backoff (1 min × 2ⁿ, ±20 %, au plus 6 h), curseur gardé |
| 429, 403 de quota                          | idem (`rate_limited`), jamais `action_required`                      |
| 410, curseur refusé                        | curseur effacé, scan complet au passage suivant                      |
| autre 403                                  | `action_required` (`write_authorization_required`)                   |
| 404 et calendrier absent (`calendars.get`) | `action_required` (`calendar_deleted`)                               |

Une transition vers `action_required` est unique et globale : l'ordre des verrous est connexion, outbound, réconciliation, miroirs, et elle se fait sous une nouvelle génération qui rend périmés tous les autres workers, writers compris. Sans authentification valide (`reauth_required`), le passage ne fait rien.

**Workers périmés.** Le claim capture le calendrier, la génération outbound et l'incarnation des identifiants. Toute écriture locale revérifie aussi le compte et le scope d'écriture (`reconciliation_claim_valid`). Si l'un d'eux a changé (désactivation, reconnexion, autre compte, réactivation sur un nouveau calendrier), une page tardive n'enregistre rien : ni réparation ni curseur.

**Planning et limites.** Un calendrier est relu au plus tôt 30 minutes après sa dernière lecture complète (`private.reconciliation_interval()`). Par passage de la tâche (toutes les 15 min) : 5 businesses au plus, le plus ancien dû d'abord, chacun une fois ; 4 pages de 250 événements au plus par business. Une lecture plus longue reprend au passage suivant, à sa page, sous le même scan.

Testé : chaque dérive est détectée en incrémental puis réparée, ce qui couvre titre, début, fin, transparence, journée entière, `tentative`, métadonnées altérées ou retirées et suppression. Aussi testé :

- absence de dérive pour un autre décalage, des millisecondes, un fuseau nommé, des champs non gérés ou la révision ;
- un annulé recréé chez Google est retiré ; un annulé supprimé chez Google n'est jamais ressuscité ;
- un annulé avant toute écriture mais présent dans la cible est retiré ;
- les événements inconnus et ceux d'un autre business sont ignorés ;
- les rendez-vous passés ne sont pas réparés ;
- un événement absent de toute liste est trouvé par le scan complet qui suit un 410 ;
- dérive observée pendant qu'une réponse du writer est en attente, puis lecture suivante vide : réparé quand même ;
- dérive observée sur une page demandée avant une écriture terminée entre-temps (`applied_at >= page_started_at`) : réparée ;
- page lue avant l'écriture : au plus une mise à jour redondante, puis stable ;
- R1 en vol, R2 observée : R1 acquittée seule, R2 réparée ensuite ;
- échec de l'enregistrement d'une page : le curseur ne bouge pas, le changement est relu ;
- modification entre deux pages d'un scan complet : vue par la lecture incrémentale suivante ;
- un scan en échec partiel ne décide rien, puis reprend ;
- une lecture longue est bornée et reprise ;
- un miroir écrit après le début du scan n'est jamais déclaré manquant ;
- la matrice d'erreurs (5xx, 429, 403 de quota, réponse perdue, page invalide, 403 réel, calendrier supprimé) ;
- quatre changements d'autorité pendant une lecture ;
- courses : dérive pendant une écriture, modification locale pendant une réparation, succès ancien contre dérive récente, suppression chez Google avec annulation dans Booking, modification suivie d'un nouveau calendrier ;
- verrous en vraies transactions ;
- deux businesses sur le même compte Google ;
- aucune fonction appelable par `authenticated` ou `anon`.

### Équité dans l'outbound (tâche périodique)

L'outbound garde au moins 40 % du budget de la tâche (`INBOUND_SHARE`, inchangé). À l'intérieur de cette part :

1. créations de calendriers dédiés ;
2. backfill : SQL seul, d'abord, pour que ses miroirs soient écrits dans le même passage ;
3. écritures dues (révisions et réparations), prioritaires jusqu'à `OUTBOUND_WRITE_SHARE` (75 %) du temps restant. Elles sont réclamées par petits lots (10, au plus 3 par business) et uniquement parmi ce qui était dû au début du passage : jamais une boucle sur ce que le passage rend dû ;
4. réconciliation, avec au moins le reste, et tout le temps que les écritures laissent ;
5. de nouveau les écritures avec le temps que la réconciliation laisse, si elles avaient été coupées ou si des réparations viennent d'être enregistrées.

**Budget.** La part de la réconciliation se déduit de ce qu'il lui faut pour démarrer. Une page exige 3 s restantes (`RECONCILIATION_PAGE_MIN_MS`), et une passe 3,5 s (`RECONCILIATION_MIN_START_MS` : le claim plus une page). La réserve vaut au moins `RECONCILIATION_RESERVE_MS` = minimum de démarrage + 0,5 s de marge d'ordonnancement, ou 25 % du budget outbound si c'est plus. Elle n'est accordée que si le budget peut aussi contenir une écriture (1,5 s). Un budget plus court ne réserve rien : les écritures gardent leur priorité, et la réconciliation ne démarre pas sans ses 3,5 s.

Au plus petit budget réel (50 s de tâche, 30 s d'inbound, 0,5 s de marge, soit 19,5 s), cela donne 14,625 s d'écritures et 4,875 s de réconciliation. Testé avec le vrai ordonnanceur et le vrai réconciliateur.

**Échéance ou panne.** Ce qui a gagné la course est donné explicitement par `withinDeadline` (`{ expired: true }`, ou la valeur, ou l'erreur réelle inchangée), jamais déduit de l'horloge au moment où l'on regarde le résultat :

- un timer qui se déclenche une milliseconde avant que l'horloge n'atteigne l'échéance reste l'échéance ;
- une vraie panne une milliseconde avant l'échéance reste une panne, journalisée ou remontée ;
- une panne qui arrive après l'échéance est consommée sans bruit.

Une erreur survenue alors que le passage entier a été abandonné par la tâche (signal parent annulé) n'est pas journalisée une seconde fois : la tâche a déjà signalé cet abandon.

La phase prioritaire (créations, backfill, écritures) a une **échéance réelle**, comme les deux sens de la tâche, qui couvre aussi ses appels base de données (claim, découverte du travail dû, libérations). À l'échéance, son signal est annulé et l'orchestrateur cesse d'attendre. Une réponse ou un échec tardif est consommé, jamais un rejet non géré. Ce qui arrive en retard reste sans danger : un claim accordé trop tard n'est jamais utilisé, son bail (2 min) expire et le miroir est réclamé de nouveau, et tout résultat enregistré passe par l'autorité du claim. Une erreur de la phase prioritaire (erreur base, `statement_timeout` sur un verrou) est journalisée et ne supprime jamais le tour de la réconciliation. Testé : claim qui ne répond pas, réponse et échec tardifs, et claim bloqué par un vrai verrou PostgreSQL. Chaque appel Google porte l'échéance de sa phase. Un claim qu'un passage ne traitera pas (business arrêté, temps écoulé) est rendu tout de suite (`calendar_outbound_release_mirror`), sans attendre son bail. Un business arrêté (limite, `action_required`, autorité perdue) n'est plus réclamé dans le passage. Le kick après une action n'exécute que créations et écritures (un seul claim, comme avant).

### `action_required`, désactivation et déconnexion

| État                                  | Inscription des nouveaux rendez-vous                                                           | Appels Google                                                | Sortie                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `action_required`                     | oui (trigger et backfill ; rejoués après réactivation)                                         | aucun                                                        | action explicite de la professionnelle                           |
| `disabled` (désactivation volontaire) | non ; les miroirs existants suivent leur rendez-vous ; le backfill rattrape après réactivation | aucun                                                        | réactivation explicite                                           |
| déconnexion                           | non (`disabled`, génération remplacée)                                                         | aucun                                                        | reconnexion puis activation explicite                            |
| autre compte Google à la reconnexion  | non (`disabled`, `account_changed`)                                                            | aucun avec les nouveaux identifiants sur l'ancien calendrier | activation explicite : nouveau calendrier dans le nouveau compte |

**Déconnexion.** Elle ne supprime pas les événements chez Google de façon synchrone. En V1, des événements peuvent rester visibles chez Google si le nettoyage distant n'est plus possible. Booking reste propre : rendez-vous intacts, workers invalidés, aucune écriture Google après la perte d'autorité (testé).

**Reconnexion avec le même compte.** L'outbound actif continue avec le même calendrier, sous la nouvelle incarnation. Après une déconnexion, l'activation retrouve l'ancien calendrier par son marqueur : jamais un second (testé).

**Autre compte.** Les identifiants B ne sont jamais utilisés avec le calendrier A, et les workers de A deviennent no-op. L'activation explicite chez B crée un nouveau calendrier et rejoue tous les rendez-vous actifs enrôlés (testé). Les événements restés dans le calendrier de A ne sont pas nettoyés : limite V1.

### Statut pour l'UI (`CalendarOutboundStatusDto`)

`{ provider, available, googleConnected, writeAuthorized, enabled, state, health, calendarCreated, actionRequired, reason, pendingCount, errorCount, lastError }`, distinct du statut inbound.

- `state` : `disabled | creating | active | action_required` ;
- `health` : `disabled | healthy | pending | retrying | action_required` ;
- `actionRequired` : `authorize_write | reconnect | reactivate | enable_again | null` ;
- `reason` : `calendar_deleted | write_authorization_required | account_changed | reauth_required | null`.

`pendingCount` et `errorCount` comptent aussi les réparations dues (l'événement diffère de Booking tant qu'elles ne sont pas appliquées) : une dérive apparaît comme `pending`, puis `retrying` si la réparation échoue. Aucun nouvel état. Aucun token (ni de sync), secret ni id fournisseur n'y figure.

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
| `getCalendarOutboundStatusAction()`              | —                                          | `CalendarOutboundStatusDto`                                                                                                                              |
| `startGoogleCalendarWriteAuthorizationAction()`  | —                                          | `{ authorizationUrl }` (autorisation incrémentale du scope d'écriture)                                                                                   |
| `enableCalendarOutboundAction()`                 | —                                          | `{ status, authorizationUrl }` ; sans scope d'écriture, `authorizationUrl` à ouvrir, sinon `null` et le calendrier dédié est créé après la réponse       |
| `reactivateCalendarOutboundAction()`             | —                                          | idem, après `action_required`                                                                                                                            |
| `disableCalendarOutboundAction()`                | —                                          | `CalendarOutboundStatusDto`                                                                                                                              |
| `retryCalendarOutboundAction()`                  | —                                          | `CalendarOutboundStatusDto` ; reprise immédiate de ce qui attend un backoff                                                                              |

`ConnectedCalendarDto` : `{ id, name, timezone, primary, accessRole, selectable, bookingCalendar, blocking, protecting, syncStatus, lastSyncedAt, lastError }`. Avec `refresh: true`, les calendriers bloquants devenus `stale` (fuseau changé) sont resynchronisés après la réponse.

**Erreurs stables :**

- `calendar_not_configured` (503) ;
- `calendar_not_connected` (409) ;
- `calendar_reauth_required` (409) ;
- `calendar_provider_unavailable` (503) ;
- `calendar_not_found` (404) ;
- `calendar_scope_missing` (400) ;
- `calendar_not_selectable` (400) ;
- `calendar_disconnect_in_progress` (409) ;
- `calendar_write_authorization_required` (409) : le scope d'écriture n'est pas accordé ;
- `calendar_account_mismatch` (409) : l'autorisation d'écriture a été donnée par un autre compte Google ;
- `conflict` (409) : la connexion a changé pendant l'opération (reconnexion ou déconnexion concurrente) ;
- `oauth_state_invalid` (400) ;
- plus les codes communs (`unauthenticated`, `forbidden`, `validation_error`…).

## Écran de réglages (`/app/settings/calendar`)

Une seule connexion Google, deux fonctions présentées séparément, jamais fusionnées en un statut global :

- **Disponibilités** (Google → Booking) : liste des calendriers à cocher (`updateBlockingCalendarsAction`, ensemble complet). Le calendrier dédié de Booking (`bookingCalendar`) n'y figure jamais. Un calendrier sélectionné n'est présenté comme bloquant qu'une fois `protecting` ; avant, « Activation en cours… ». Les états `degraded`, `stale`, `error`, `incomplete` rappellent que les événements déjà connus continuent de bloquer.
- **Rendez-vous** (Booking → Google) : aucun choix de calendrier destination. `health` et `actionRequired` sont traduits de façon exhaustive (`src/features/calendar/client/settings-copy.ts`) ; `reactivate` n'est jamais lancé automatiquement.
- Le retour d'OAuth (`/api/calendar/google/callback`) ramène sur cet écran avec `?calendar=<résultat>`, affiché une fois puis retiré de l'adresse.
- Après une action, l'écran relit l'état serveur ; quand quelque chose s'installe côté serveur (calendrier dédié en création, première sync), il relit au plus cinq fois (3 s, 8 s, 20 s, 45 s, 90 s), puis au retour sur l'onglet. Pas de polling.
- Une lecture ne s'applique que si aucune action ni lecture plus récente n'a commencé depuis son départ (version client incrémentée avant et après chaque action) : une réponse tardive ne peut jamais réécrire la sélection, qui est envoyée comme un ensemble complet.
- Si une lecture ultérieure échoue, les dernières données restent affichées, avec un avertissement et « Réessayer ». Une erreur pendant une confirmation (désactivation, déconnexion) s'affiche dans le dialogue.
- Le calendrier dédié est nommé « Calendrier de rendez-vous Booking » : son nom réel chez Google n'est fourni par aucun DTO.
- Aucun identifiant fournisseur, scope, génération ni code d'erreur brut n'est affiché.

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

- **Heure répétée sans décalage.** Un événement non vide dont une borne est donnée sans décalage pendant l'heure répétée d'un retour à l'heure d'hiver (une nuit par an, entre 2 h et 3 h à Paris) est placé sur l'instant que choisit PostgreSQL ; l'autre lecture possible n'est pas bloquée. Seul un intervalle de durée nulle dans ce cas est traité (jamais considéré vide, voir plus haut).
- **Canaux d'un compte remplacé.** Quand un autre compte remplace la connexion, les canaux de l'ancien compte ne sont pas arrêtés chez Google (ses identifiants sont remplacés dans la même transaction) : leurs notifications sont ignorées (réponse 204 uniforme) jusqu'à leur expiration (au plus 7 jours).
- **Calendriers sans fuseau.** Un calendrier que Google liste sans fuseau, ou avec un fuseau inconnu de PostgreSQL, ne peut pas être sélectionné. S'il l'était déjà, il continue d'être synchronisé avec une marge (`degraded`) jusqu'à ce qu'un fuseau connu revienne. Si la tzdata de PostgreSQL ne connaît pas un fuseau récent, la marge dure jusqu'à la mise à jour de PostgreSQL.
- **Lignes historiques.** Jusqu'à la full sync que la migration force, les journées entières stockées avant les dates civiles gardent leur fenêtre UTC. Elles sont élargies si le fuseau change entre-temps : sur-blocage temporaire.
- **Première version de `20261005090000` : non supportée.** Elle n'a été exécutée que localement et sur des bases CI éphémères, jamais sur `main` ni sur une base persistante (production ou staging). Elle a été corrigée directement dans cette PR. Le seul chemin d'upgrade supporté est `20261004090000` → `20261005090000` corrigée → migrations suivantes, et il est vérifié par `npm run test:upgrade`. Une base de développement qui a appliqué l'ancienne version doit être réinitialisée (`npm run db:reset`).
- **Outbound : événements laissés chez Google.** Après une déconnexion, une désactivation ou un changement de compte, les événements déjà copiés restent dans l'ancien calendrier dédié (celui du compte A, par exemple) : aucun nettoyage distant en V1. Le nouveau calendrier, lui, reçoit tous les rendez-vous actifs enrôlés.
- **Outbound : restauration d'un événement supprimé.** Elle réécrit l'événement canonique (`events.update`, `status: confirmed`, même id) quand une mise à jour partielle ne l'a pas restauré. La documentation de Google dit que ces événements peuvent être restaurés, sans nommer la méthode. Ce comportement est vérifié contre le faux Google seulement : voir la validation manuelle ci-dessous, obligatoire avant l'ouverture aux clientes. Les champs ajoutés à la main sur un événement ensuite supprimé chez Google ne sont pas conservés par la restauration.
- **Outbound : délai de correction.** Une modification ou une suppression manuelle dans Google est corrigée au plus tard environ 45 minutes après elle (30 min d'intervalle, passage toutes les 15 min), plus les reprises. Les suppressions arrivent par la lecture incrémentale (Google renvoie les entrées supprimées depuis le token précédent), y compris celles faites pendant la lecture paginée d'un scan complet. Un token devenu invalide répond `410` et provoque un nouveau scan complet. Aucun scan complet périodique n'est fait : le protocole de synchronisation ne l'exige pas.
- **Outbound : rendez-vous passés.** Ni backfill ni réparation pour un rendez-vous terminé : l'historique chez Google reste tel quel.
- **Outbound : création au résultat ambigu.** Si le calendrier créé n'apparaît pas dans la liste pendant les recherches bornées (environ 15 min), l'outbound attend la professionnelle (`calendar_creation_uncertain`) plutôt que de risquer un doublon. Sa réactivation cherche encore avant de créer.
- **Outbound : refresh token ancien.** Si Google n'envoie pas de nouveau refresh token, l'ancien est gardé ; un token d'accès rafraîchi sans le scope d'écriture fait passer l'outbound en `action_required` (`authorize_write`), jamais en boucle.
- **Fenêtre de révocation.** La révocation n'est tentée que dans la minute qui suit la déconnexion ; au-delà (serveur très lent), elle est abandonnée et l'autorisation reste valide chez Google jusqu'à ce que la professionnelle la retire elle-même.

### Validation manuelle avec un vrai compte Google (avant l'ouverture aux clientes)

Le faux Google des tests modélise le comportement documenté. Les points suivants doivent être vérifiés une fois avec un vrai compte, sur un environnement de préproduction (tâche périodique déclenchée à la main, `POST /api/cron/calendar`) :

1. **Restauration.** Annuler un rendez-vous puis le reconfirmer : le même événement, même id, revient `confirmed`. Puis supprimer l'événement à la main dans Google : la réconciliation suivante le restaure, sans doublon. Noter ce que `events.patch` fait à l'événement supprimé (statut renvoyé `cancelled`, `confirmed`, ou 410) et vérifier que l'événement est bien `confirmed` après le passage (via `events.update` si le patch ne suffit pas).
2. **Écriture concurrente d'un id supprimé.** Après une suppression manuelle, `events.insert` avec le même id répond bien 409, et la mise à jour partielle ou la restauration qui suit rend l'événement `confirmed`.
3. **Lecture complète.** `events.list` avec `showDeleted=true`, sans borne de temps et avec `calendar.app.created` seul pour l'écriture, répond sur le calendrier dédié. La dernière page porte `nextSyncToken` et aucune autre ne le porte.
4. **Incrémental.** Après une modification manuelle (titre, heure, transparence « Disponible »), la lecture avec le sync token renvoie l'événement. Après une suppression manuelle, elle le renvoie `cancelled`.
5. **Format des instants.** Les `dateTime` renvoyés par Google portent un décalage (et pas seulement `timeZone`). Un événement non modifié ne produit aucune dérive : vérifier dans les logs qu'aucun `outbound_drift_detected` n'apparaît sur un calendrier intact.
6. **Transparence par défaut.** Un événement `opaque` est renvoyé sans `transparency`, et passer l'événement en « Disponible » donne `transparent`.
7. **Propriétés privées.** `extendedProperties.private` est renvoyé tel qu'écrit, avec le masque `extendedProperties/private`.
8. **Expiration du token.** Un sync token invalide répond 410 et le passage suivant refait un scan complet. Pour le provoquer, utiliser un token altéré en base de préproduction uniquement.
9. **Calendrier supprimé.** Supprimer le calendrier dédié : la réconciliation ou le writer passent `action_required` (`calendar_deleted`) une seule fois, puis plus aucun appel. La réactivation crée ou retrouve un calendrier et y rejoue les rendez-vous actifs.
10. **Quotas.** Sur un compte de test, des 403 `rateLimitExceeded` ou des 429 mènent à des reprises, jamais à `action_required`. Vérifier aussi qu'une description, une couleur, des rappels et une propriété privée étrangère ajoutés à la main restent après un déplacement du rendez-vous dans Booking et après une réparation du titre (`events.patch`).

Si l'un de ces points contredit la stratégie retenue (en particulier la restauration d'un événement supprimé, ou la conservation des champs manuels par `events.patch`), c'est un blocage à traiter avant l'ouverture, pas une note de checklist.

## Évolutions prévues

- **Outbound.**
  - Nettoyage des événements laissés dans un ancien calendrier dédié.
- **UI.**
  - Affichage des périodes externes dans l'agenda.
  - Signalement des conflits.
