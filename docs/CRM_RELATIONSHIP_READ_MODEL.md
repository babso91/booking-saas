# Contrat — modèle de lecture de la relation client (CRM V1, étape 2)

Ce document est le contrat backend de l'annuaire clientes, du profil et de la timeline relationnelle. Il sert aussi de passation pour l'agent qui construira l'interface.

Cette étape est **en lecture seule** : elle ne crée aucune table, ne stocke aucun agrégat et n'écrit rien. Toutes les données viennent d'enregistrements qui existent déjà.

- **Migration :** `supabase/migrations/20261013090000_crm_relationship_read_model.sql`.
- **Code :** `src/features/crm/`.
- **Contrat amont :** l'entité cliente `public.clients` est décrite dans [`CRM_CUSTOMER_CONTRACT.md`](CRM_CUSTOMER_CONTRACT.md).

## Interface serveur

Les trois opérations sont des Server Actions de `src/features/crm/actions/crm.ts`, sur le modèle de l'agenda :

- chacune renvoie un `ActionResult<T>` (`{ ok: true, data }` ou `{ ok: false, error: { code, message, fieldErrors? } }`) ;
- aucune ne lève d'exception vers l'UI ;
- aucune n'expose de message PostgreSQL.

Les types de `data` sont exportés par `src/features/crm/types.ts`.

| Action                     | Entrée                                        | Sortie                  |
| -------------------------- | --------------------------------------------- | ----------------------- |
| `listClientsAction`        | `{ query?, filter?, sort?, limit?, cursor? }` | `DirectoryPageDto`      |
| `getClientProfileAction`   | `{ clientId }`                                | `ClientProfileDto`      |
| `listClientTimelineAction` | `{ clientId, limit?, cursor? }`               | `ClientTimelinePageDto` |

- **Aucun identifiant de business n'est accepté.** Le business vient de la session (`runBusinessAction` → `getBusinessContext`).
- **Codes d'erreur à gérer côté UI :**
  - `unauthenticated` : pas de session ;
  - `no_business` : professionnelle sans activité ;
  - `client_not_found` : identifiant inconnu, ou cliente d'une autre activité ;
  - `validation_error` : entrée ou curseur invalide, avec `fieldErrors.cursor` pour un curseur ;
  - `forbidden` : ne survient pas par les actions, seulement par un appel direct avec un autre business.

### Instants et fuseau

Chaque instant affichable est un `BusinessInstantDto` :

- `at` : instant UTC ISO ;
- `local` : heure murale `YYYY-MM-DDTHH:MM` dans le fuseau du business, lue par PostgreSQL (`public.business_time`) ;
- `occurrence` : `first` ou `second` pendant l'heure répétée d'automne, sinon `null`.

L'UI groupe par date locale avec `local.slice(0, 10)` et ne convertit jamais une date elle-même.

Chaque réponse porte `timezone` : c'est **le fuseau avec lequel ses heures murales ont réellement été calculées**. Il est renvoyé par le même appel à `business_time` que les conversions, jamais lu à part dans le contexte de session.

- **Changement de fuseau concurrent :** si le fuseau du business change entre la lecture du contexte et les conversions, la réponse annonce le nouveau fuseau, et toutes ses heures murales sont calculées dans ce fuseau. Elle reste donc cohérente (testé).
- **Un seul appel par réponse :** chaque réponse fait un seul appel à `business_time`, même quand la page est vide, donc un seul fuseau par réponse.

Le modèle de lecture ne prend **aucune décision de date civile** : seuls des instants sont comparés. Il n'y a donc ni « aujourd'hui », ni bornes de jour, ni dépendance au fuseau du serveur.

### Instant de référence (`asOf`)

Chaque réponse porte `asOf`, l'instant de référence de ses métriques (le `now()` de la transaction PostgreSQL).

**Ce que `asOf` fige : le temps, pas les données.**

- **Une seule valeur par appel :** les comptes, le prochain rendez-vous et le filtre « à venir » sont tous calculés au même instant, donc ils ne se contredisent pas.
- **Une seule valeur par pagination :** le curseur transporte l'`asOf` de la première page, et toutes les pages suivantes l'utilisent. Un rendez-vous ne passe donc pas de « à venir » à « passé » au fil des pages, simplement parce que l'horloge avance.
- **Pas un instantané de la base :** chaque page relit les données telles qu'elles sont au moment de sa requête. Les fiches, rendez-vous, écritures ou emails créés, modifiés ou supprimés entre deux pages sont vus tels qu'ils sont devenus (voir « Garanties de pagination »).

## Définitions (une seule source)

Les métriques par cliente sont définies une seule fois, dans `public.crm_client_activity`. L'annuaire et le profil appellent tous deux cette fonction, et un test vérifie qu'ils donnent les mêmes valeurs pour chaque cliente.

Les statuts sont ceux de Booking et de l'Agenda (`public.appointment_status`).

| Métrique                                         | Définition exacte                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `completedCount`                                 | rendez-vous `completed` (marqués effectués ; possible seulement une fois commencés)               |
| `cancelledCount`                                 | rendez-vous `cancelled`, passés ou futurs                                                         |
| `noShowCount`                                    | rendez-vous `no_show`                                                                             |
| `pastConfirmedCount`                             | `confirmed` dont le début est ≤ `asOf` : en attente d'un statut, **jamais** comptés comme visites |
| `upcomingCount`                                  | `confirmed` dont le début est > `asOf`                                                            |
| `firstCompletedVisitAt` / `lastCompletedVisitAt` | début du premier / dernier rendez-vous `completed`                                                |
| `nextAppointment`                                | le rendez-vous à venir au début le plus proche (puis par `id`)                                    |
| `favoriteService`                                | prestation la plus souvent `completed` ; à égalité, la visite la plus récente, puis `serviceId`   |
| `completedServiceValue`                          | voir « Argent »                                                                                   |

Précisions :

- **Une date passée ne prouve rien.** Un rendez-vous `confirmed` passé n'est jamais une visite. Un `cancelled` ou un `no_show` ne l'est jamais non plus.
- **Date de visite et date de clôture sont distinctes.** La date d'une visite est le **début** du rendez-vous (`starts_at`). L'instant où il a été marqué effectué est un fait distinct : `completed_at`, exposé comme `completedAt` dans la timeline, et `null` s'il n'a pas été enregistré (par exemple pour les rendez-vous antérieurs à l'agenda).
- **Aucun agrégat n'est stocké.** Tout est recalculé en base à chaque lecture.
- **Nom de la prestation favorite :** `favoriteService.currentName` est le nom **actuel** de la prestation, qui a pu être renommée. Chaque rendez-vous garde son propre nom historique (`service.name` dans la timeline et dans les rendez-vous à venir). `active` indique si la prestation est encore réservable.

### Argent

Le seul prix historique fiable est `appointments.price_cents_snapshot`, avec `currency` : le prix enregistré sur le rendez-vous à la réservation, ou au changement de prestation par l'agenda.

- `completedServiceValue` vaut, **par devise**, la somme de ces prix sur les rendez-vous `completed`, avec leur nombre.
- C'est la **valeur des prestations réalisées**, **pas** un encaissement. Rien en base n'enregistre un paiement, donc l'UI ne doit jamais l'intituler « chiffre d'affaires », « payé » ou « encaissé ».
- **Prix et statuts exclus :**
  - les prix actuels des prestations ne sont jamais utilisés, si bien qu'un changement de tarif ne réécrit pas l'historique ;
  - les rendez-vous annulés, `no_show` et `confirmed` passés n'entrent pas dans le calcul.
- Plusieurs devises ne sont **jamais additionnées** : une entrée par devise. Une liste vide signifie qu'il n'y a pas de rendez-vous effectué, et ce n'est pas un « 0 € » à afficher comme un fait.

## Annuaire — `listClientsAction`

Une page des clientes du business, avec leur résumé relationnel.

```ts
type DirectoryPageDto = {
  asOf: string;
  timezone: string;
  totalCount: number; // clientes du business correspondant à la recherche et au filtre
  clients: DirectoryClientDto[];
  nextCursor: string | null; // null : dernière page
};
type DirectoryClientDto = {
  id: string;
  displayName: string; // "Prénom Nom", fiche actuelle
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: BusinessInstantDto;
  completedCount: number;
  lastCompletedVisitAt: BusinessInstantDto | null;
  upcomingCount: number;
  nextAppointment: { id: string; startsAt: BusinessInstantDto } | null;
};
```

### Recherche

`query` est normalisé en NFC, puis débarrassé de ses espaces aux extrémités. Une requête vide renvoie toutes les clientes ; la longueur maximale est de 100 caractères.

- **Correspondance :** sous-chaîne insensible à la casse (`ILIKE`) dans :
  - le prénom et le nom ;
  - « prénom nom » et « nom prénom » ;
  - l'email ;
  - le téléphone.
- **Chiffres du téléphone :** si la requête contient au moins 3 chiffres, ces chiffres sont aussi cherchés dans les chiffres du téléphone (`0612` trouve `06 12 34 56 78`).
- **Pas d'interprétation :** les accents comptent ; `%` et `_` sont littéraux ; la requête est un paramètre et n'est jamais interprétée comme du SQL.
- **Distinct de l'identité :** cette recherche est indépendante de la normalisation d'identité des emails (`private.canonical_email`), qui reste inchangée.

### Filtres

`filter` accepte :

- `all` (par défaut) ;
- `upcoming` : au moins un rendez-vous à venir ;
- `no_upcoming` ;
- `visited` : au moins une visite effectuée ;
- `never_visited`.

Il n'y a aucun état de cycle de vie (« à risque », « VIP »…).

### Tris

`sort` accepte les valeurs suivantes. Chacun est complété par `id` croissant, ce qui donne un ordre total :

| `sort`             | Ordre                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| `name` (défaut)    | « prénom nom » en minuscules, croissant                                    |
| `newest`           | fiche la plus récente d'abord                                              |
| `last_visit`       | dernière visite effectuée la plus récente d'abord ; jamais venues à la fin |
| `next_appointment` | prochain rendez-vous le plus proche d'abord ; sans rendez-vous à la fin    |
| `most_visits`      | plus de visites effectuées d'abord                                         |

### Pagination

- **Keyset :** la page suivante commence strictement après la dernière ligne lue, avec `limit` entre 1 et 100 (25 par défaut).
- **Curseur lié à sa lecture :** le curseur est opaque et lié à la recherche, au filtre et au tri qui l'ont produit. Le réutiliser avec d'autres paramètres donne `validation_error`.
- **Garanties :** voir « Garanties de pagination » ci-dessous, communes à l'annuaire et à la timeline.

### `totalCount`

- **Défini indépendamment de la page :** c'est le nombre de clientes du business qui correspondent à la recherche et au filtre au moment où la requête s'exécute. Le curseur ne l'influence pas.
- **Calculé dans la même instruction SQL que la page,** il ne dépend donc pas de ses lignes. Une page vide (curseur après la dernière cliente, ou clientes supprimées entre deux pages) porte quand même le vrai total. Par exemple : deux clientes, page 1 = Anna ; Zoé est supprimée ; la page 2 est vide avec `totalCount = 1`.
- **Pas figé :** c'est le compte **actuel**, recalculé à chaque page. Il peut changer d'une page à l'autre si des fiches sont créées, supprimées ou modifiées entre-temps.
- **Jamais de fuite :** pour un autre business, la réponse est une erreur `forbidden`, jamais un compte.

## Profil — `getClientProfileAction`

```ts
type ClientProfileDto = {
  asOf: string;
  timezone: string;
  client: {
    id;
    displayName;
    firstName;
    lastName;
    email;
    phone;
    createdAt: BusinessInstantDto;
    updatedAt: string;
  }; // fiche ACTUELLE
  overview: {
    completedCount;
    cancelledCount;
    noShowCount;
    pastConfirmedCount;
    upcomingCount;
    firstCompletedVisitAt: BusinessInstantDto | null;
    lastCompletedVisitAt: BusinessInstantDto | null;
    favoriteService: {
      serviceId: string;
      currentName: string | null;
      active: boolean | null;
      completedCount: number;
    } | null;
    completedServiceValue: {
      currency: string;
      amountCents: number;
      appointmentCount: number;
    }[];
  };
  nextAppointment: AppointmentSummaryDto | null; // = upcoming[0]
  upcoming: AppointmentSummaryDto[]; // au plus 5 ; upcomingCount donne le total
};
type AppointmentSummaryDto = {
  id: string;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: BusinessInstantDto;
  endsAt: BusinessInstantDto;
  service: { id: string; name: string; durationMinutes: number }; // nom enregistré sur le rendez-vous
  price: { amountCents: number; currency: string }; // prix enregistré, pas un paiement
};
```

- **Réponse bornée :** le profil ne contient jamais l'historique, qui se lit page par page dans la timeline. Il s'ouvre donc aussi vite pour une cliente qui a des milliers d'événements.
- **Rendez-vous à venir à part :** ils sont séparés de l'historique, pour que l'UI puisse épingler `nextAppointment` en haut du profil.

## Timeline — `listClientTimelineAction`

L'histoire de la relation, du plus récent au plus ancien, une page bornée à la fois.

```ts
type ClientTimelinePageDto = {
  asOf: string;
  timezone: string;
  events: ClientTimelineEvent[];
  nextCursor: string | null;
};
type ClientTimelineEvent =
  AppointmentTimelineEvent | LoyaltyTimelineEvent | EmailTimelineEvent;
// Champs communs : id (stable), kind, occurredAt (BusinessInstantDto)
```

L'UI fait un `switch (event.kind)`. Chaque type a des champs explicites, sans blob JSON.

### Types d'événements implémentés

Un événement correspond à **un fait métier enregistré**, et rien n'est inventé.

| `kind`        | Source                         | `occurredAt`                             | Contenu                                                                                                                                                                                                                   |
| ------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appointment` | `appointments`                 | début du rendez-vous                     | statut, horaires, prestation et prix **enregistrés sur le rendez-vous**, `source` (`public` ou `manual`), `completedAt` (marquage, ou `null`), `cancellationReason`, `contact` = **instantané** de contact du rendez-vous |
| `loyalty`     | `loyalty_events` (grand livre) | création de l'écriture                   | `type` (`appointment_completed`, `manual_adjustment`, `reward_redeemed`, `correction`), `pointsDelta` (+/−), `reason`, `appointmentId`, `redemption`                                                                      |
| `email`       | `email_events` (outbox)        | enregistrement de l'email (`created_at`) | `type`, `status`, `scheduledFor`, `sentAt`, `recipientEmail`, `appointmentId`                                                                                                                                             |

#### Rendez-vous

La timeline contient **tous** les rendez-vous de la cliente, sauf ceux à venir (`confirmed` et début > `asOf`), qui figurent dans le profil.

- **Annulé futur :** il n'est pas « à venir », donc il apparaît dans la timeline, à sa date prévue.
- **Instantané de contact :** il montre ce qui a été soumis pour ce rendez-vous, même si la fiche a changé depuis. La fiche actuelle est dans le profil.

#### Fidélité

Une écriture du grand livre donne un événement.

- **Un seul fait pour un échange :** un échange de récompense (`reward_redemptions`) est rattaché à l'écriture qu'il référence (`loyalty_event_id`, unique) et apparaît dans `entry.redemption`. Il n'est **jamais** un second événement.
- **Domaine dormant :** aucun parcours de l'application n'écrit encore dans ce grand livre. La timeline affiche les écritures qui existent en base, rien d'autre.

#### Emails

Statuts exposés :

| Statut en base | `status` exposé | Sens                                                                                |
| -------------- | --------------- | ----------------------------------------------------------------------------------- |
| `pending`      | `scheduled`     | enregistré, **pas encore envoyé**                                                   |
| `processing`   | `sending`       | en cours d'envoi                                                                    |
| `sent`         | `sent`          | remis au fournisseur ; la livraison n'est **pas** suivie (aucun statut « délivré ») |
| `failed`       | `failed`        | échec                                                                               |
| `cancelled`    | `cancelled`     | annulé                                                                              |

- **Champs jamais exposés :** le payload, l'identifiant fournisseur, le texte d'erreur et la clé de déduplication.
- **Pas encore d'envoi :** aucun worker n'envoie encore ces emails ; les confirmations de réservation restent donc `scheduled`.

### Identité, ordre et curseur

- **Identité :** `id = "<kind>:<uuid de la source>"`, stable d'une lecture à l'autre ; deux tables ne peuvent donc pas entrer en collision.
- **Ordre :** `occurredAt` décroissant, puis `id` décroissant octet par octet. L'ordre est total, et deux événements au même instant restent toujours dans le même ordre.
- **Pagination :**
  - keyset, `limit` entre 1 et 100 (20 par défaut) ;
  - le curseur porte l'`asOf` de la première page, la position (instant exact à la microseconde, `id`) et la cliente ;
  - il est refusé pour une autre cliente ;
  - garanties : voir ci-dessous.

## Garanties de pagination (annuaire et timeline)

Les données sont **vivantes** : `asOf` fige l'instant de référence, pas le contenu de la base. Il n'existe aucun instantané entre deux requêtes.

**Données inchangées entre les pages** (aucune création, modification ou suppression qui touche l'ordre ou le filtre) :

- ordre déterministe et total ;
- aucun doublon ;
- aucun élément sauté ;
- curseur stable : la même suite de pages à chaque relecture ;
- `totalCount` identique sur toutes les pages.

**Données modifiées pendant une pagination :**

| Situation                                                                                                              | Effet sur la pagination déjà commencée                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Une cliente déjà lue est renommée et passe **après** le curseur (Anna → Zora)                                       | elle est relue : doublon                                                                                                                                             |
| B. Une cliente pas encore lue est renommée et passe **avant** le curseur (Zoé → Aaron)                                 | elle n'apparaît pas dans les pages restantes : omission                                                                                                              |
| C. Un nouvel événement dont la position est **après** le curseur dans l'ordre décroissant                              | il apparaît dans une page suivante. Exemple : la page 1 se termine sur un rendez-vous annulé futur, et un email enregistré maintenant est plus ancien que ce curseur |
| D. Un événement antidaté, enregistré après la page 1 avec un `occurredAt` plus ancien que le curseur                   | il apparaît dans une page suivante                                                                                                                                   |
| Un événement plus récent que la première page (au-dessus du curseur)                                                   | il n'apparaît pas dans les pages suivantes                                                                                                                           |
| Une fiche ou un événement qui change de filtre (par exemple un nouveau rendez-vous à venir), ou un rendez-vous déplacé | il peut entrer, sortir, être relu ou manquer                                                                                                                         |

Ces quatre cas (A à D) sont couverts par des tests de régression.

**Pour retrouver une vue cohérente :** repartir de la première page (sans curseur). On obtient une vue fraîche, avec un nouvel `asOf`.

Le backend ne déduplique pas les pages. Toute présentation (par exemple ignorer un `id` déjà affiché) relève de l'UI.

## Curseurs : validation stricte

Un curseur n'est accepté que s'il est exactement ce que le backend produit. Tout le reste donne `validation_error` avec `fieldErrors.cursor`, avant tout appel à la base, et jamais une erreur `internal`.

- **Encodage :**
  - alphabet base64url seulement, sans `=` ;
  - encodage canonique : ré-encoder donne le même texte, donc ni suffixe parasite ni bits invalides ;
  - au plus 1 024 caractères et 768 octets décodés ;
  - UTF-8 valide.
- **Document JSON :** un objet strict de la version (`v: 1`) et du type (`clients` ou `timeline`) attendus, sans clé supplémentaire. Le tri et le filtre doivent appartenir à leurs listes.
- **Instants :**
  - exactement le format écrit par PostgreSQL : `YYYY-MM-DDTHH:MM:SS`, jusqu'à 6 décimales, puis `Z` ou `±HH:MM[:SS]` avec un décalage d'au plus 15 h 59 ;
  - vérifiés champ par champ sur le calendrier grégorien : `2026-02-30` est refusé, `2024-02-29` accepté, `2025-02-29` et `1900-02-29` refusés ;
  - **conservés tels quels**, sans repasser par `Date`, ce qui préserve les microsecondes ;
  - `-infinity` n'est accepté que pour `last_visit`, `infinity` que pour `next_appointment`.
- **Identifiants :** syntaxe UUID `8-4-4-4-12` hexadécimale, quelle que soit la version. Les événements doivent être de la forme `appointment|loyalty|email:<uuid>`.
- **Comptes (`most_visits`) :** entiers sûrs entre 0 et 2 147 483 647 (le type `integer` de PostgreSQL). `2147483648`, `-1`, `1.5`, `NaN` et `Infinity` sont refusés.
- **Lien avec la lecture :** un curseur produit pour une autre recherche, un autre filtre, un autre tri ou une autre cliente est refusé.
- **Aucun droit :** un curseur valide n'autorise rien. Chaque page revérifie la session, le business et la cliente.

### Ajouter un type d'événement plus tard

Il n'y a ni table d'événements générique, ni event sourcing. Pour une nouvelle source (soins post-prestation, avis, parrainage, photo, note…) :

1. ajouter une branche à l'`union all` de `public.crm_client_timeline` : `'<kind>:' || id`, la date, et un `jsonb_build_object` des champs ;
2. ajouter son schéma zod et son adaptateur dans `src/features/crm/data/timeline.ts` ;
3. ajouter un membre à `ClientTimelineEvent` dans `src/features/crm/types.ts`.

L'UI ignore les `kind` qu'elle ne connaît pas encore, ou affiche un repli. Les sources prévues n'existent pas encore et **ne doivent pas** être simulées.

## Sécurité

- **RLS comme autorité :** les fonctions SQL `crm_*` sont `SECURITY INVOKER`. La RLS de `clients`, `appointments`, `services`, `loyalty_events`, `reward_redemptions`, `rewards` et `email_events` reste donc l'autorité.
- **Vérifications explicites :** chaque fonction vérifie aussi l'appartenance au business (`forbidden` sinon) et filtre chaque ligne par ce business. Une cliente d'une autre activité donne `client_not_found`.
- **Droits :** `EXECUTE` est accordé à `authenticated` seulement, jamais à `anon`. Le site public de réservation ne peut donc pas lire le CRM.
- **Lecture seule :** les fonctions sont `STABLE` et ne peuvent rien écrire. Un test vérifie qu'aucune lecture ne modifie les rendez-vous, les fiches, la fidélité, les emails ou les miroirs Google.
- **Curseurs :** un curseur ne donne aucun droit. Chaque page revérifie la session, le business et la cliente.
- **Aucun compte client :** pas d'utilisateur Auth, de mot de passe ou de lien magique pour les clientes.

## Performance

- **Calcul côté base :** tout est calculé en base en un appel par opération, plus un appel à `business_time` pour les heures murales. Il n'y a ni N+1, ni requête par ligne, ni chargement des rendez-vous dans le navigateur.
- **Index :**
  - existants : `appointments_client_starts_at_idx (business_id, client_id, starts_at desc)` et `loyalty_events_client_ledger_idx` ;
  - ajouté : `email_events_client_timeline_idx (business_id, client_id, created_at desc, id)`. Les index existants des emails ne servaient que le worker et la déduplication ; sans ce nouvel index, chaque page de timeline lirait tous les emails du business.
- **Mesures locales** (3 000 clientes, 15 000 rendez-vous, 20 000 emails, session réelle d'un membre, RLS active) :

  | Lecture                                                 | Durée        |
  | ------------------------------------------------------- | ------------ |
  | Page d'annuaire (page et total dans une même requête)   | ≈ 175–195 ms |
  | Page d'annuaire avec recherche                          | ≈ 215 ms     |
  | Page d'annuaire vide après le curseur (total seulement) | ≈ 170 ms     |
  | Profil                                                  | ≈ 3–5 ms     |
  | Page de timeline d'une cliente à 2 000 emails           | ≈ 30 ms      |

- **Coût de l'annuaire :** il vient surtout des politiques RLS existantes, qui appellent `is_business_member(business_id)` pour chaque ligne (≈ 37 ms sans RLS). Une réécriture ensembliste de ces politiques, commune à toute l'application, est hors périmètre.

## Limites connues

- Il n'y a ni paiement, ni encaissement, ni valeur vie client : seulement la valeur des prestations réalisées, aux prix enregistrés.
- Il n'y a ni date d'annulation, ni date de création d'un `no_show` : un rendez-vous est daté par son début.
- Un rendez-vous effectué avant l'agenda a `completedAt = null`.
- La fidélité et les emails ne sont encore produits par aucun parcours de l'application, à l'exception des confirmations de réservation, qui restent `scheduled`.
- La recherche n'ignore pas les accents.

## Passation pour l'agent UI

1. **Liste.** Appeler `listClientsAction({ query, filter, sort, limit: 25 })`.
   - Afficher `totalCount` comme le nombre **actuel** de clientes correspondantes. Il peut changer d'une page à l'autre, et une page vide peut avoir un total non nul.
   - Pour « charger plus », rappeler avec `cursor: page.nextCursor` et **les mêmes** `query`, `filter` et `sort`.
   - Quand la recherche, le filtre ou le tri change, repartir sans curseur.
   - Ne jamais promettre un instantané : si les données changent pendant le défilement, une cliente peut apparaître deux fois ou manquer (voir « Garanties de pagination »). Rafraîchir revient à repartir de la première page.
   - Si `validation_error` porte sur `cursor`, repartir de la première page.
2. **Profil.** À l'ouverture, appeler en parallèle `getClientProfileAction({ clientId })` et `listClientTimelineAction({ clientId })`.
   - Épingler `nextAppointment` en haut.
   - Afficher `overview` avec les intitulés exacts de ce document (« visites effectuées », « valeur des prestations réalisées », jamais « payé »).
   - `pastConfirmedCount > 0` peut inviter la professionnelle à indiquer le résultat de ces rendez-vous dans l'agenda.
3. **Timeline.**
   - Grouper par `occurredAt.local.slice(0, 10)`.
   - Faire un `switch (event.kind)`, avec un repli pour un `kind` inconnu.
   - Pour la suite, rappeler avec `nextCursor`. Un événement créé pendant le défilement peut apparaître plus bas (s'il est plus ancien que le curseur) ou seulement après un rafraîchissement.
   - L'en-tête du profil montre la fiche **actuelle** ; un événement de rendez-vous montre son **instantané**.
4. **Champs absents.** `email`, `phone`, `lastName`, `favoriteService`, `lastCompletedVisitAt`, `completedAt`, `sentAt` et `rewardName` peuvent être `null`. Il faut alors afficher l'absence, jamais une valeur inventée.
5. **Dates.** Ne jamais formater une date avec le fuseau du navigateur : utiliser `local`, et `occurrence` pour l'heure répétée d'automne. Afficher le `timezone` de **la même réponse** : c'est celui de ses heures murales.
