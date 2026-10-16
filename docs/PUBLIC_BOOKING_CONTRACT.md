# Réservation publique — contrat backend (PR #21)

Le parcours : une cliente, sans compte, ouvre `/b/[slug]`, choisit une prestation active puis un créneau réel, saisit ses coordonnées et confirme. Le rendez-vous est validé de façon atomique, apparaît dans l'agenda de la professionnelle, et la cliente est liée dans le CRM.

Ce document décrit le contrat que l'interface (Claude UI) doit utiliser. L'interface livrée ensuite dans cette même PR est décrite au § 8.

- **Migration :** `supabase/migrations/20261017090000_public_booking_guarantees.sql`.
- **Code :**
  - `src/app/api/bookings/route.ts` ;
  - `src/features/appointments/` ;
  - `src/lib/http.ts` (`clientKeyOf`).

## 1. Ce qui existait déjà, et qui est réutilisé tel quel

| Besoin                       | Existant                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profil public et prestations | `GET /api/public/businesses/:slug` → `{ business, services }`. Prestations **actives** seulement, aucun champ privé.                                                                                                                                                                                                                                                                                                        |
| Créneaux réels               | `GET /api/public/businesses/:slug/availability?serviceId&date=YYYY-MM-DD`. Le jour est civil, dans le fuseau du business ; les créneaux sont des instants UTC avec leur heure murale. Le calcul tient compte des horaires, fermetures, exceptions, rendez-vous, tampons, préavis minimum, horizon maximum, grille et heure d'été (testés).                                                                                  |
| Transaction de réservation   | `private.create_public_booking_at`, sous le verrou du planning. Elle revalide le créneau avec les réglages lus dans la même transaction, résout la cliente par email canonique, insère le rendez-vous avec ses instantanés (nom, durée, prix, devise, tampon, contact) et inscrit la confirmation dans l'outbox. La contrainte d'exclusion `appointments_no_overlap` reste la garantie finale contre la double réservation. |
| Cliente dans le CRM          | `private.resolve_client` : une fiche par email canonique et par business. Une fiche existante n'est jamais renommée ; seuls un nom de famille ou un téléphone **manquants** sont complétés.                                                                                                                                                                                                                                 |
| Agenda                       | Le rendez-vous `confirmed` est lu par l'agenda comme tout autre rendez-vous. Le miroir Google est lancé après la réponse, sans jamais la retarder.                                                                                                                                                                                                                                                                          |
| Validation                   | Le schéma zod donne des erreurs par champ, et la base revalide tout (prénom, email, téléphone, créneau).                                                                                                                                                                                                                                                                                                                    |

## 2. Ce qui manquait, et qui est livré

1. **Idempotence (nouvel essai ambigu).**
   - Chaque réservation porte un `requestId` (UUID, un par formulaire).
   - Même requête : le rendez-vous qu'elle a créé est renvoyé (`replayed: true`, HTTP 200), et **rien n'est écrit**, ni rendez-vous ni email. C'est vrai même si le créneau n'est plus réservable entre-temps.
   - Même `requestId` avec un autre contenu : `idempotency_conflict` (409).
   - Des requêtes identiques simultanées attendent la première sous le verrou du planning : un seul rendez-vous est créé (testé).
   - Stockage : `appointments.creation_request_id` et `creation_request_fingerprint`, déjà utilisés par la création manuelle, avec une unicité par business.
2. **Limites anti-abus, appliquées par PostgreSQL** (`private.public_booking_log`, qui ne garde que des empreintes SHA-256, jamais l'email ni l'adresse en clair) :
   - 5 nouvelles réservations par heure glissante par adresse réseau de l'appelant, tous business confondus ;
   - 10 nouvelles réservations par 24 h glissantes par email, dans un même business ;
   - les nouveaux essais (rejeux) ne comptent pas ;
   - une seule réponse pour les deux limites : `rate_limited` (429). Elle ne dit pas laquelle a joué, ni si l'email est connu.
3. **Un seul point d'entrée.** `public.create_public_booking` n'est exécutable que par `service_role`. La route `POST /api/bookings` l'appelle avec la clé de service et transmet l'adresse de l'appelant (`clientKeyOf` : premier élément de `x-forwarded-for`, sinon `x-real-ip`). Appeler le RPC avec la clé publique est refusé : les limites ne peuvent pas être contournées ainsi. Les lectures (profil, prestations, créneaux) restent publiques.

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

| Code                   | HTTP | Quand                                                                                     | Conduite UI                                                                              |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `validation_error`     | 400  | champ invalide (`fieldErrors.firstName`, `email`, `phone`, `requestId`…) ou JSON invalide | afficher sous le champ                                                                   |
| `business_not_found`   | 404  | slug inconnu                                                                              | page introuvable                                                                         |
| `service_not_found`    | 404  | prestation inconnue, inactive ou d'un autre business                                      | recharger les prestations                                                                |
| `slot_unavailable`     | 409  | créneau pris, fermé, passé, hors grille ou hors horizon (disponibilité périmée)           | « Ce créneau n'est plus disponible » ; relire la disponibilité du jour, garder la saisie |
| `idempotency_conflict` | 409  | `requestId` réutilisé pour un autre contenu                                               | régénérer le `requestId`, puis laisser renvoyer                                          |
| `rate_limited`         | 429  | trop de réservations                                                                      | message neutre, ne pas réessayer en boucle                                               |
| `internal`             | 500  | inattendu, ou clé de service absente du déploiement                                       | message générique ; renvoyer **avec le même `requestId`**                                |

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
- **Adresse réseau :** la limite par adresse repose sur `x-forwarded-for`, tel que l'hébergeur le fixe (Vercel le réécrit). Derrière un autre proxy, il faut vérifier cet en-tête. Sans en-tête, toutes les requêtes partagent la clé `unknown`.
- **Lectures non limitées :** la disponibilité et le profil n'ont pas de limite de débit propre (lectures bornées à un jour par requête).
- **Pas de captcha.** Un attaquant qui dispose de nombreuses adresses peut occuper des créneaux, dans la limite de 5 par heure et par adresse. Aucune annulation par la cliente (lien) n'existe encore.
- **Fiche existante complétée :** une réservation avec l'email d'une cliente existante peut compléter un nom de famille ou un téléphone **vides** de sa fiche (comportement existant de `resolve_client`), jamais les remplacer.
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

1. **Date civile du business :** les routes publiques ne donnent pas la date du jour chez le business, et `public.business_time` est réservé à `authenticated`. L'UI la calcule donc avec Intl, **pour la navigation seulement** (premier jour proposé). La disponibilité reste seule juge. Proposition : ajouter `today` au profil public.
2. **Heure murale de la réservation :** `PublicBookingDto` n'a pas d'heure murale (`localStartsAt`). L'UI réutilise celle du créneau envoyé. Si un rejeu répond avec un autre `startsAt` (rendez-vous déplacé depuis), l'UI ne peut pas afficher l'heure sans convertir avec Intl, ce que l'architecture interdit (§ 8 d'`ARCHITECTURE.md`). Elle indique donc « modifiées depuis par l'établissement ». Proposition : ajouter `localStartsAt` et `localEndsAt` à la réponse.
3. **« Activité indisponible » :** il n'existe pas de code dédié. Une activité sans prestation active est affichée comme « aucune prestation en ligne ».
