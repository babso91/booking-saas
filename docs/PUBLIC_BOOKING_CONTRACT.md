# Réservation publique — contrat backend (PR #21)

Le parcours : une cliente, sans compte, ouvre `/b/[slug]`, choisit une prestation active puis un créneau réel, saisit ses coordonnées et confirme. Le rendez-vous est validé de façon atomique, apparaît dans l'agenda de la professionnelle, et la cliente est liée dans le CRM.

Ce document décrit le contrat que l'interface (Claude UI) doit utiliser. L'interface livrée ensuite dans cette même PR est décrite au § 8.

- **Migrations :**
  - `supabase/migrations/20261017090000_public_booking_guarantees.sql` ;
  - `supabase/migrations/20261018090000_public_booking_hardening.sql`, la remédiation après les audits (§ 9).
- **Code :**
  - `src/app/api/bookings/route.ts` ;
  - `src/features/appointments/` ;
  - `src/lib/client-identity.ts` (identité réseau de l'appelant).

## 1. Ce qui existait déjà, et qui est réutilisé tel quel

| Besoin                       | Existant                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profil public et prestations | `GET /api/public/businesses/:slug` → `{ business, services }`. Prestations **actives** seulement, aucun champ privé.                                                                                                                                                                                                                                                                                                        |
| Créneaux réels               | `GET /api/public/businesses/:slug/availability?serviceId&date=YYYY-MM-DD`. Le jour est civil, dans le fuseau du business ; les créneaux sont des instants UTC avec leur heure murale. Le calcul tient compte des horaires, fermetures, exceptions, rendez-vous, tampons, préavis minimum, horizon maximum, grille et heure d'été (testés).                                                                                  |
| Transaction de réservation   | `private.create_public_booking_at`, sous le verrou du planning. Elle revalide le créneau avec les réglages lus dans la même transaction, résout la cliente par email canonique, insère le rendez-vous avec ses instantanés (nom, durée, prix, devise, tampon, contact) et inscrit la confirmation dans l'outbox. La contrainte d'exclusion `appointments_no_overlap` reste la garantie finale contre la double réservation. |
| Cliente dans le CRM          | Une fiche par email canonique et par business. Depuis la remédiation (§ 9.3), une réservation publique relie la fiche existante **sans jamais la modifier** (`private.resolve_public_client`).                                                                                                                                                                                                                              |
| Agenda                       | Le rendez-vous `confirmed` est lu par l'agenda comme tout autre rendez-vous. Le miroir Google est lancé après la réponse, sans jamais la retarder.                                                                                                                                                                                                                                                                          |
| Validation                   | Le schéma zod donne des erreurs par champ, et la base revalide tout (prénom, email, téléphone, créneau).                                                                                                                                                                                                                                                                                                                    |

## 2. Ce qui manquait, et qui est livré

1. **Idempotence (nouvel essai ambigu).**
   - Chaque réservation porte un `requestId` (UUID, un par formulaire).
   - Même requête : le rendez-vous qu'elle a créé est renvoyé (`replayed: true`, HTTP 200), et **rien n'est écrit**, ni rendez-vous ni email. C'est vrai même si le créneau n'est plus réservable entre-temps.
   - Même `requestId` avec un autre contenu : `idempotency_conflict` (409).
   - Des requêtes identiques simultanées attendent la première sous le verrou du planning : un seul rendez-vous est créé (testé).
   - Stockage : `appointments.creation_request_id` et `creation_request_fingerprint`, déjà utilisés par la création manuelle, avec une unicité par business.
2. **Limites anti-abus, appliquées par PostgreSQL.** Remplacées après les audits : voir § 9.2.
3. **Un seul point d'entrée.**
   - `public.create_public_booking` n'est exécutable que par `service_role`.
   - La route `POST /api/bookings` l'appelle avec la clé de service et transmet l'adresse de l'appelant **établie par l'ingress de confiance** (§ 9.1).
   - Appeler le RPC avec la clé publique est refusé.
   - Les lectures (profil, prestations, créneaux) restent publiques.

## 3. Contrat de `POST /api/bookings`

Corps JSON :

```ts
{
  slug: string;
  serviceId: string; // uuid, d'une prestation active de ce business
  startsAt: string; // instant ISO, exactement un `startsAt` renvoyé par la disponibilité
  firstName: string; // 1–120
  lastName?: string; // ≤ 120, "" = absent
  email: string; // canonicalisé (minuscules, espaces retirés)
  phone?: string; // +, chiffres, espaces, ().- ; 6–30 ; "" = absent
  requestId: string; // uuid, un par formulaire (voir § 5)
}
```

Réponse `201` (nouvelle réservation) ou `200` (rejeu), `{ data: { booking } }` :

```ts
type PublicBookingDto = {
  appointmentId: string;
  startsAt: string; // UTC ISO
  endsAt: string;
  timezone: string; // fuseau du business : afficher l'heure dans ce fuseau
  serviceName: string; // instantané au moment de la réservation
  durationMinutes: number;
  priceCents: number; // entier, en centimes
  currency: string;
  businessName: string;
  status: string; // "confirmed" ; un rejeu renvoie le statut actuel (ex. "cancelled")
  replayed: boolean;
};
```

La réponse ne contient **rien de la fiche cliente** : pas d'identifiant de cliente, pas de données du CRM. Elle est identique, que l'email ait déjà été connu ou non.

| Code                   | HTTP | Quand                                                                                                                                                   | Conduite UI                                                                               |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `validation_error`     | 400  | champ invalide (`fieldErrors.firstName`, `lastName`, `email`, `phone`, `requestId`, `startsAt`) ou JSON invalide ; la base nomme aussi le champ (§ 9.5) | afficher sous le champ                                                                    |
| `business_not_found`   | 404  | slug inconnu                                                                                                                                            | page introuvable                                                                          |
| `service_not_found`    | 404  | prestation inconnue, inactive ou d'un autre business                                                                                                    | recharger les prestations                                                                 |
| `slot_unavailable`     | 409  | créneau pris, fermé, passé, hors grille ou hors horizon (disponibilité périmée)                                                                         | « Ce créneau n'est plus disponible » ; relire la disponibilité du jour, garder la saisie  |
| `idempotency_conflict` | 409  | `requestId` réutilisé pour un autre contenu                                                                                                             | régénérer le `requestId`, puis laisser renvoyer                                           |
| `rate_limited`         | 429  | trop de réservations                                                                                                                                    | message neutre, ne pas réessayer en boucle                                                |
| `booking_unavailable`  | 503  | l'ingress de confiance n'a pas fourni d'adresse (configuration absente ou requête directe)                                                              | « Réservation momentanément indisponible » ; garder la demande, renvoi possible plus tard |
| `internal`             | 500  | inattendu, ou clé de service absente du déploiement                                                                                                     | message générique ; renvoyer **avec le même `requestId`**                                 |

## 4. Fuseau et heures

- La disponibilité donne `localStartsAt` et `localEndsAt` (heure murale du business) : les afficher tels quels, jamais l'heure du navigateur.
- Le `date` demandé est un jour civil dans le fuseau du business.
- Pour réserver, envoyer **exactement** le `startsAt` (UTC) reçu.

## 5. Passation pour l'UI (Claude UI)

1. Page `/b/[slug]` (aujourd'hui une page de fondation) : lire le profil et les prestations (`GET /api/public/businesses/:slug`). Ne proposer que ce qui est renvoyé.
2. Prestation choisie, puis jour : `GET …/availability?serviceId=…&date=…`. Liste vide : aucun créneau ce jour-là (fermé, complet, hors horizon).
3. Créneau choisi, puis coordonnées : prénom et email obligatoires, nom et téléphone facultatifs.
4. `requestId` :
   - le créer quand la cliente arrive à l'étape de confirmation (`crypto.randomUUID()`) ;
   - le **garder** tant que le contenu (prestation, créneau, coordonnées) ne change pas ;
   - en créer un nouveau si le contenu change.
5. Envoi :
   - bouton verrouillé pendant l'envoi ;
   - erreur réseau ou `internal` : renvoyer **le même corps avec le même `requestId`**. Il n'y aura jamais de doublon, et la réponse sera la réservation déjà faite (`replayed: true`).
6. Confirmation à l'écran avec la réponse : prestation, date et heure dans `timezone`, durée, prix (centimes → devise), nom du business.
   - Ne pas promettre d'email : la confirmation est seulement inscrite dans l'outbox, et aucun envoi n'est encore branché.
   - Une réponse `replayed` avec `status` différent de `confirmed` : la réservation a été modifiée depuis ; l'indiquer.
7. `slot_unavailable` : retour au choix du créneau, avec la disponibilité relue et les coordonnées conservées.

## 6. Limites connues

- **Aucun email n'est envoyé.** `email_events` (`booking_confirmation`, `pending`) est un outbox sans worker d'envoi. L'UI ne doit pas écrire « email envoyé ».
- **Adresse réseau :** voir § 9.1. Elle n'est fiable que si le proxy est configuré comme décrit ; sans configuration, les réservations sont refusées.
- **Lectures non limitées :** la disponibilité et le profil n'ont pas de limite de débit propre (lectures bornées à un jour par requête).
- **Pas de captcha, pas de vérification d'email :** voir § 9.6 (risque restant et prérequis avant un trafic public réel).
- **Fiche existante :** reliée, jamais modifiée (§ 9.3).
- **Prérequis de déploiement :** `SUPABASE_SERVICE_ROLE_KEY` doit être défini pour la route (déjà requis par la synchronisation Google). Sans elle, la réservation répond `internal`.

## 7. Tests

- **`tests/integration/public-booking-guarantees.test.ts`** (route réelle et PostgreSQL) :
  - parcours complet (agenda, CRM, instantané du prix, outbox non envoyé) ;
  - cliente existante sans réécriture ni fuite ;
  - nouvel essai identique, essais simultanés, essai après fermeture du créneau, même `requestId` avec un autre contenu, `requestId` par business, `requestId` obligatoire ;
  - concurrence sur un créneau (un seul succès) ;
  - créneaux périmés, fermés, passés, hors grille ou hors horizon ;
  - prestation inactive ou d'un autre business ;
  - saisies invalides ;
  - limites par adresse et par email, journal en empreintes.
- **Sensibilité (mutations) :**
  - sans idempotence : 5 tests échouent ;
  - RPC rouvert à `anon` : 2 tests échouent ;
  - sans limites : 2 tests échouent.
- **`tests/upgrade/public-booking-guarantees.test.ts` :** base peuplée ; rendez-vous existants intacts ; rejeu ; refus pour `anon`.
- **Suites existantes inchangées dans leur intention :** `public-booking`, `public-booking-dst`, `concurrency`, `schedule-*`, `crm-customers`, `api-routes`. Elles appellent désormais la réservation comme la route, en rôle de service, avec un `requestId`.

## 8. Interface livrée (Claude UI)

Le parcours `/b/[slug]` utilise ce contrat tel quel, sans aucun changement backend.

- **Page :** `src/app/(public)/b/[slug]/page.tsx`. Elle lit le profil et les prestations actives avec les mêmes RPC publics que `GET /api/public/businesses/:slug`. Un slug inconnu ou invalide donne `not-found.tsx` (404). La page n'est pas indexée.
- **Logique, sans présentation** (`src/features/public-booking/client/`) :
  - `use-booking-flow.ts` contient toutes les règles du parcours ;
  - `api.ts` appelle les routes et ne lève jamais d'exception : erreur réseau, délai dépassé ou réponse illisible donnent `network` ;
  - `business-time.ts` gère les jours civils et les heures murales ;
  - `contact.ts` reprend les mêmes limites que le schéma zod ;
  - `pending-booking.ts` conserve la demande non confirmée.

  Un futur mini-site de marque réutilise ce hook et ne remplace que la présentation.

- **Présentation fonctionnelle** (`src/features/public-booking/components/`) :
  - quatre étapes (prestation, créneau, coordonnées, vérification), puis la confirmation ;
  - à chaque étape, le focus va sur le titre.

### Règles appliquées

- **Créneaux :**
  - jamais calculés dans le navigateur ;
  - affichés avec `localStartsAt` ;
  - les jours vont d'aujourd'hui (date civile du business) jusqu'à `maximumBookingAdvanceDays` ;
  - une lecture qui n'est plus la dernière (autre jour ou autre prestation choisis entre-temps) est abandonnée.
- **Fuseau :** les heures sont toujours celles de l'établissement. Si l'appareil est réglé sur un autre fuseau, l'écran le précise.
- **`requestId` :**
  - un par contenu (prestation, créneau, coordonnées) ;
  - il est conservé tant que ce contenu ne change pas ;
  - la demande est écrite dans `sessionStorage` (onglet, clé `public-booking:<slug>`) **avant** l'envoi, et effacée une fois la réponse lue.
- **Réponse perdue** (réseau, `internal`, page quittée, rechargement) : « Réservation non confirmée ». La même demande peut être renvoyée **à l'identique** (même corps, même `requestId`) ou abandonnée.
- **Une autre réservation** reste bloquée tant que la précédente n'est ni renvoyée ni abandonnée.
- **`idempotency_conflict` :** l'écran l'explique ; une nouvelle demande (nouveau `requestId`) n'est envoyée que sur un choix explicite. La ligne du § 3 (« régénérer… ») est appliquée ainsi, sans renvoi automatique.
- **`slot_unavailable` :** retour aux créneaux du même jour, relus ; les coordonnées sont conservées.
- **`rate_limited` :** message neutre, aucun nouvel essai automatique.
- **`service_not_found` :** les prestations sont relues via `GET /api/public/businesses/:slug`.
- **`business_not_found` :** « Réservation indisponible ».
- **Confirmation :**
  - uniquement celle de la réponse du backend ;
  - en cas de rejeu, l'écran indique qu'il s'agit du même rendez-vous ;
  - un statut autre que `confirmed` est signalé ;
  - **aucun email n'est promis.**

### Écarts de contrat relevés (pour Claude Cloud)

1. **Date civile du business :** résolu par la remédiation. Le profil public donne `today`, la date chez le business selon l'horloge de PostgreSQL ; l'UI l'utilise, avec Intl seulement en secours (§ 9.7).
2. **Heure murale de la réservation :** `PublicBookingDto` n'a pas d'heure murale (`localStartsAt`). L'UI réutilise celle du créneau envoyé. Si un rejeu répond avec un autre `startsAt` (rendez-vous déplacé depuis), l'UI ne peut pas afficher l'heure sans convertir avec Intl, ce que l'architecture interdit (§ 8 d'`ARCHITECTURE.md`). Elle indique donc « modifiées depuis par l'établissement ». Proposition : ajouter `localStartsAt` et `localEndsAt` à la réponse.
3. **« Activité indisponible » :** il n'existe pas de code dédié. Une activité sans prestation active est affichée comme « aucune prestation en ligne ».

## 9. Remédiation après les audits

Migration additive `20261018090000_public_booking_hardening.sql`, appliquée après `20261017090000`. Les rendez-vous, les fiches clientes et les enregistrements d'idempotence (`appointments.creation_request_id`) ne sont pas modifiés. Seul le journal anti-abus `private.public_booking_log` est vidé : ses anciennes empreintes SHA-256 non salées sont supprimées, pas converties.

### 9.1 Ingress de confiance (adresse réseau de l'appelant)

**Avant :** la route lisait le premier élément de `x-forwarded-for`, que tout appelant peut écrire. Une adresse différente à chaque requête contournait la limite par adresse. Une adresse choisie permettait aussi d'épuiser le quota d'une autre personne.

**Maintenant :**

- l'application ne lit **jamais** `x-forwarded-for` ni `x-real-ip` ;
- elle lit `x-booking-client-ip` **seulement** si `x-booking-proxy-secret` est égal à `BOOKING_PROXY_SECRET` (au moins 32 caractères ; comparaison en temps constant) ;
- l'adresse doit être une IPv4 ou une IPv6 littérale :
  - pas de zone (`%eth0`), pas de liste, pas de port ;
  - une IPv4 encapsulée (`::ffff:a.b.c.d`) est traitée comme IPv4 ;
- dans tous les autres cas, la réponse est `booking_unavailable` (503), **avant** toute écriture. Elle s'applique quand le secret n'est pas configuré, est absent ou faux, ou quand l'adresse est invalide. Il n'existe plus de clé partagée `unknown`.

Le reverse proxy doit **écraser** ces deux en-têtes (jamais les transmettre depuis le client), avec l'adresse de son pair TCP.

nginx :

```nginx
location /api/bookings {
    proxy_set_header X-Booking-Client-Ip    $remote_addr;
    proxy_set_header X-Booking-Proxy-Secret "<valeur de BOOKING_PROXY_SECRET>";
    proxy_pass http://127.0.0.1:3000;
}
```

`proxy_set_header` remplace toute valeur envoyée par le client. Si nginx est lui-même derrière un répartiteur de charge, `$remote_addr` est l'adresse du répartiteur. Il faut alors `set_real_ip_from <plage du répartiteur>;` et `real_ip_header X-Forwarded-For;` (module realip), **uniquement** pour la plage de ce répartiteur.

Caddy :

```caddy
reverse_proxy 127.0.0.1:3000 {
    header_up X-Booking-Client-Ip {remote_host}
    header_up X-Booking-Proxy-Secret {env.BOOKING_PROXY_SECRET}
}
```

**Procédure de mise en place** (non effectuée : nécessite une autorisation explicite) :

1. Générer le secret hors du dépôt (`openssl rand -hex 32`). Le définir dans l'environnement de l'application et dans celui du proxy, jamais dans un fichier versionné ni dans un log de CI.
2. Configurer le proxy comme ci-dessus.
3. L'application ne doit écouter que sur une interface privée (`127.0.0.1` ou réseau interne), jamais directement sur Internet. Le secret refuse les requêtes directes, mais l'isolation réseau reste la première barrière.
4. **Vérification :**
   - via le proxy, une réservation de test répond 201 ;
   - via le proxy avec un `X-Booking-Client-Ip` forgé, le journal compte l'adresse réelle (rejeu bloqué par la limite) ;
   - en direct sur le port de l'application, la réponse est 503.
5. **Retour arrière :** retirer les deux lignes du proxy ou la variable. Les réservations répondent alors 503, sans aucune écriture, et les autres pages restent servies. Aucune donnée n'est à restaurer.

**Limite de ce document :** la topologie réelle de l'ingress (proxy, répartiteur, hébergeur) n'est pas décrite dans le dépôt et n'a pas pu être établie. Les tests prouvent le comportement du code, **pas** la configuration du proxy en production. Le déploiement de la réservation publique reste **bloqué** tant que cette configuration n'a pas été faite et vérifiée.

### 9.2 Limites anti-abus

Les limites s'appliquent aux nouvelles réservations ; les rejeux ne comptent jamais. Elles sont vérifiées sous un verrou consultatif par réseau, donc des requêtes simultanées ne peuvent pas les dépasser (testé : 8 simultanées, exactement 3 acceptées).

| Clé                               | Fenêtre         | Maximum |
| --------------------------------- | --------------- | ------- |
| réseau, tous business             | 1 h glissante   | 5       |
| réseau, tous business             | 24 h glissantes | 15      |
| réseau, dans un même business     | 24 h glissantes | 3       |
| email canonique, dans un business | 24 h glissantes | 10      |

- **Réseau :** une IPv4 (/32) ou un préfixe IPv6 /64. Un abonné reçoit en général un /64 entier : changer d'adresse dans son préfixe ne contourne rien.
- **Pas de quota global par business.** Un quota bas permettrait à un attaquant de bloquer toutes les réservations d'un business.
- **Une seule réponse :** `rate_limited` (429). Elle ne dit pas quelle limite a joué, ni si l'email est connu.
- **Risque restant :** ces limites **augmentent le coût** d'un abus, elles ne l'empêchent pas. Un attaquant disposant de nombreux réseaux (proxies résidentiels, nombreux /64) peut encore créer de fausses réservations et occuper des créneaux, au plus 3 par réseau et par business et par jour. Voir § 9.6.

### 9.3 Fiche cliente (CRM)

**Avant :** une réservation anonyme avec l'email d'une cliente existante pouvait compléter son nom de famille ou son téléphone vides.

**Maintenant** (`private.resolve_public_client`) :

- la fiche est créée si l'email est nouveau (`insert … on conflict do nothing`) ;
- sinon, la fiche existante est **reliée telle quelle, jamais modifiée** ;
- le rendez-vous garde l'instantané des coordonnées saisies (`contact_*`), visible du professionnel ;
- la réponse est identique que l'email soit connu ou non : aucune donnée de la fiche, aucun indicateur. Testé : réponses comparées champ par champ.

La création manuelle par le professionnel (`private.resolve_client`) est inchangée.

### 9.4 Données personnelles et rétention

- **Contenu du journal :** `private.public_booking_log` ne contient que des pseudonymes `network_key` et `email_key`, calculés par HMAC-SHA-256 (`private.abuse_key`).
- **Clé HMAC :** elle est générée **dans la base** (`gen_random_bytes(32)`) et stockée dans `private.abuse_hmac_keys`. Elle n'est jamais versionnée ni dérivée d'une constante. Elle est illisible pour `anon`, `authenticated` et `service_role` (testé).
- **Ce sont des pseudonymes, pas des données anonymes :** avec la clé, on peut recalculer le pseudonyme d'une adresse ou d'un email donné.
- **Rotation :** insérer une nouvelle ligne dans `private.abuse_hmac_keys`, et c'est la plus récente qui sert. Les compteurs repartent alors de zéro, au plus 24 h de limites perdues. Les anciennes clés peuvent être supprimées 48 h après.
- **Rétention : 48 h.** Chaque réservation supprime au plus 100 entrées expirées (suppression bornée, indexée). `private.purge_public_booking_log(p_before, p_limit)` peut être planifiée si un ordonnanceur existe (pg_cron n'est pas supposé disponible).
- **Idempotence non touchée :** la purge ne touche pas l'idempotence, portée par `appointments`. Un rejeu après la purge renvoie le même rendez-vous (testé).
- **Logs :** aucune donnée personnelle n'est écrite dans les logs. Seule l'absence de configuration du secret est journalisée, sans valeur.

### 9.5 Erreurs de validation de la base

PostgreSQL revalide les champs. Chaque erreur porte maintenant un `hint` qui nomme le champ, et la route le renvoie dans `fieldErrors` :

| Message PostgreSQL   | `fieldErrors` |
| -------------------- | ------------- |
| `invalid_first_name` | `firstName`   |
| `invalid_last_name`  | `lastName`    |
| `invalid_email`      | `email`       |
| `invalid_phone`      | `phone`       |
| `invalid_starts_at`  | `startsAt`    |

L'UI ramène les quatre premiers à l'étape des coordonnées, sous le champ concerné. `startsAt` reste traité à part (retour aux créneaux).

### 9.6 Risque restant et prérequis avant un trafic public réel

- **Défense partielle :** les limites (§ 9.2) **ne constituent pas** une protection complète contre les robots.
- **Défi humain :** avant d'ouvrir à un trafic public réel, il faudrait ajouter un défi humain. Cloudflare Turnstile et hCaptcha ont des offres gratuites, mais un service tiers demande une autorisation (aucun n'est ajouté).
- **Vérification par email :** la confirmation par lien, une fois le worker d'envoi en place, empêcherait qu'un rendez-vous non vérifié bloque un créneau longtemps.
- **Surveillance :** il faudrait surveiller le volume de `rate_limited` et de `booking_unavailable`.
- **Prérequis de déploiement :** proxy configuré et vérifié (§ 9.1), `BOOKING_PROXY_SECRET` défini, `SUPABASE_SERVICE_ROLE_KEY` défini.

### 9.7 Passation pour l'UI (Claude UI)

- **`today` :** `GET /api/public/businesses/:slug` renvoie `business.today` (date civile du business selon l'horloge du serveur). L'UI l'utilise déjà, avec Intl seulement en secours. La page `/b/[slug]` est dynamique, la date n'est donc jamais figée au build.
- **`booking_unavailable` (503) :** l'UI affiche l'échec générique et garde la demande en attente, avec le même `requestId`. Un renvoi plus tard est sûr.
- **Champs nommés par la base :** déjà ramenés sous le champ (`serverContactErrors`).
- **À faire côté UI, sans changement backend :** dans `src/features/public-booking/components/slot-step.tsx` (vers la ligne 95), quand le premier et le dernier jour de la semaine affichée sont identiques, le titre donne « Du X au X ». Il devrait afficher « Le X ».
- **Optionnel :** ajouter `localStartsAt` et `localEndsAt` à la réponse de réservation (écart 2 du § 8). Non fait ici.
