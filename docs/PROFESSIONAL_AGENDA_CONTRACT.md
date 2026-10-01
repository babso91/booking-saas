# Contrat backend — agenda professionnel V1

Contrat entre le backend et l'interface de l'agenda (`/app`). Toutes les opérations sont des Server Actions de `src/features/agenda/actions/agenda.ts`. Elles s'importent dans un Client Component et s'appellent comme une fonction asynchrone.

Le frontend n'appelle jamais Supabase directement pour lire ou modifier l'agenda.

Chaque action renvoie le même `ActionResult` que l'authentification (voir `docs/AUTH_ONBOARDING_CONTRACT.md`) :

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: AppErrorCode;
        message: string;
        fieldErrors?: Record<string, string[]>;
      };
    };
```

Aucune action ne lève d'exception vers l'UI, et aucune erreur PostgreSQL ou Supabase (SQLSTATE, message brut) n'est exposée.

## Sécurité

- **Business dérivé de la session.** Chaque action authentifie la session, puis résout le business depuis `business_members`, puis valide l'entrée.
- **Aucun identifiant de business accepté.** Un champ `businessId` envoyé par le navigateur est ignoré, retiré par la validation.
- **Double contrôle de l'appartenance.** Les fonctions SQL vérifient `auth.uid()` et l'appartenance au business avant toute lecture, en plus de RLS.
- **Identifiants d'un autre tenant.** Un identifiant (rendez-vous, bloc, cliente, prestation) appartenant à un autre business renvoie `*_not_found` ou `service_unavailable`, jamais ses données.
- **Écriture directe impossible.** Un professionnel n'a aucune politique d'écriture directe sur `appointments`. Les rendez-vous ne changent que via les fonctions de l'agenda ou la réservation publique.
- **Lecture bornée.** Aucune action ne permet de lire l'agenda d'un business arbitraire. Une plage est limitée à 42 jours, 800 rendez-vous et 500 exceptions (blocs, fermetures et ouvertures confondus). Au-delà : `validation_error` (`fieldErrors.endDate`), jamais une liste tronquée. Voir « Aucune troncature silencieuse ».
- **Session.** Une session absente donne `unauthenticated`. Un compte sans business, par exemple après retrait du membership, donne `no_business`.

## Fuseau horaire

- **Heures d'entrée.** Toutes les dates et heures reçues sont des heures murales dans le fuseau du business (`businesses.timezone`) : `date` au format `YYYY-MM-DD`, `time` au format `HH:MM`, date-heure au format `YYYY-MM-DDTHH:MM`.
- **Stockage.** La base conserve des instants `timestamptz`.
- **Autorité unique : PostgreSQL.** Toute conversion (heure murale → instant, instant → heure murale et occurrence, bornes des jours, plages d'ouverture, date du jour) est faite par PostgreSQL, avec sa base IANA, via `public.business_time` (`src/lib/time/business-time.ts`). Ni le serveur Node ni le navigateur n'utilisent leur propre tzdata pour le planning : ils peuvent en avoir une autre version (cas réel : America/Vancouver en 2027). Voir `docs/ARCHITECTURE.md` §8.
- **Sorties.** Chaque instant est renvoyé deux fois : `startsAt` (UTC, ISO 8601) et `localStartsAt` (heure murale du business, lue par PostgreSQL). L'UI affiche `local*` et ne convertit jamais elle-même ; pour placer les instants sur sa grille, elle n'utilise que `offsets` et les bornes des jours envoyés avec l'agenda.
- **Jours.** Le jour local `D` est l'intervalle semi-ouvert `[premier instant réel de D, premier instant réel de D+1)`. Le premier instant réel de `D` est le premier instant dont la date locale est `D` ou postérieure (`private.local_day_start`) ; chaque jour lu porte ses bornes réelles (`startsAt`, `endsAt`).
  - Minuit répété (America/Havana, 1er novembre 2026) : c'est la **première** occurrence.
  - Minuit sauté : c'est le premier instant après le saut.
  - Date inexistante (Pacific/Apia, 30 décembre 2011) : le jour est vide.
  - Aucune journée n'est supposée durer 24 h : on obtient 22, 23, 23,5, 24, 24,5, 25 ou 26 h selon les règles IANA.
  - Cette définition s'applique aux lectures de plage (`range`), à `workingHours.days` et aux blocs journée entière. C'est aussi celle de la réservation publique : créneaux listés par date, horizon, validation de la réservation.
  - Horaires hebdomadaires : une plage `de → à` est l'ensemble des instants du jour dont l'heure murale est dans `[de, à)` (`24:00` = fin du jour). Dans une heure répétée elle peut donner plusieurs `openRanges` (Havana, 1er novembre 2026 : `00:00 → 00:30` donne 04:00Z–04:30Z et 05:00Z–05:30Z) ; dans une heure sautée, seule la partie qui existe est ouverte. `workingHours.days[].openRanges` est exactement ce qu'utilise la disponibilité publique (`private.opening_ranges`).

### Changements d'heure et rendez-vous

Le serveur ne choisit jamais un instant à la place de la professionnelle.

- **Heure inexistante (printemps).** Une heure sautée (02:30 le dernier dimanche de mars à Paris) est refusée à la création et au déplacement : `validation_error`, `fieldErrors.time`.
- **Heure répétée (automne).** De 02:00 à 02:59 le dernier dimanche d'octobre à Paris, chaque heure existe deux fois. Il faut préciser `occurrence` :
  - `"first"` : avant le retour à l'heure d'hiver (UTC+2 à Paris) ;
  - `"second"` : après (UTC+1).
  - Sans `occurrence` dans cette heure : `ambiguous_local_time` (`fieldErrors.occurrence`), rien n'est créé ni déplacé. En dehors de cette heure, `occurrence` est ignoré.
- **Affichage.** Chaque rendez-vous porte `startOccurrence` : `"first"`, `"second"` ou `null` hors heure répétée. L'UI qui l'affiche distingue les deux occurrences, par exemple « 02:30 (heure d'été) » et « 02:30 (heure d'hiver) ». Pour proposer un créneau dans l'heure répétée, elle offre les deux choix et envoie l'`occurrence` choisie.
- **Édition sans changement d'heure.** L'instant UTC stocké est conservé **exactement**, sans aucune conversion heure murale → UTC. C'est le cas quand `date` et `time` sont absents de `updateAppointmentAction`, ou quand ils valent le `localStartsAt` chargé, avec la même `occurrence` ou sans `occurrence`. Modifier la note, la cliente ou la prestation ne peut donc jamais déplacer un rendez-vous, même situé dans l'heure répétée.
- **Règle unique `startOccurrence` → `occurrence`.** L'UI envoie **toujours** `occurrence: appointment.startOccurrence`, tel quel, sans le transformer. `occurrence` accepte `"first"`, `"second"`, `null` ou l'absence ; `null` et l'absence signifient la même chose (« pas d'occurrence précisée »). Pour un nouvel horaire choisi dans l'heure répétée, l'UI envoie le choix de la professionnelle (`"first"` ou `"second"`).
- **Recommandation UI.** N'envoyer `date` et `time` que si la professionnelle a changé l'horaire. Les renvoyer inchangés reste sans effet.
- **Cohérence avec la réservation publique.** Elle n'échange que des instants UTC. Les créneaux listés sont générés en UTC : 02:30 apparaît deux fois, comme deux instants distincts, et la cliente réserve l'instant exact. Les deux chemins aboutissent donc au même instant non ambigu ; seule la saisie par heure murale de l'agenda exige `occurrence`. Les deux découpent les jours de la même façon : un créneau listé sous une date est dans le jour réel de cette date, et il est réservable tel quel.
- **Blocs journée entière (`allDay: true`).** Ils couvrent exactement les jours locaux ci-dessus : `[premier instant de startDate, premier instant de endDate + 1)`. Ces bornes sont recalculées à chaque création et modification. Elles sont déterministes : changer le motif ne déplace rien, et un bloc enregistré sur un mauvais minuit est réaligné sur le jour réel. Une journée entière sur une date inexistante seule est vide : `validation_error`.
- **Borne à 00:00.** Pour un bloc horaire comme pour une exception des réglages, une borne saisie à `HH:MM = 00:00` désigne le début réel de ce jour. « 22:00 → 00:00 » se termine donc là où le lendemain commence vraiment.
- **Blocs : bornes existantes.** À la modification d'un bloc horaire (`allDay: false`), chaque borne est comparée séparément à la valeur affichée (`localStartsAt`, `localEndsAt`). Une borne renvoyée inchangée conserve **exactement** son instant UTC stocké, quelle que soit son occurrence. Seule une borne réellement modifiée est convertie. Changer le motif ne peut donc jamais déplacer un bloc, et changer une seule borne ne touche pas l'autre.
- **Blocs : nouvelle saisie (asymétrie voulue).** Les blocs n'ont pas de champ `occurrence`. Une heure répétée **nouvellement saisie**, autre que minuit, désigne la seconde occurrence, selon la règle du moteur (`timestamp AT TIME ZONE` de PostgreSQL, utilisée aussi par les réglages). Une heure sautée est lue avec le décalage d'avant le changement. Les bornes d'un bloc existant ne sont jamais reconverties (point précédent). Chaque bloc expose `startOccurrence` / `endOccurrence` pour l'affichage.
- **Blocs : ordre des bornes.** Il est vérifié sur les instants UTC résolus, jamais sur les heures murales. Pendant l'heure répétée, un bloc valide peut s'afficher « 02:30 → 02:30 » (de 00:30Z à 01:30Z à Paris, une heure réelle). Il se modifie normalement, par exemple en changeant seulement le motif. Une période réellement vide ou inversée après résolution est refusée : `validation_error`, `fieldErrors.endsAt`. L'UI ne doit donc pas bloquer une saisie parce que les deux heures affichées sont égales ; c'est le serveur qui tranche.

## Actions

### Lecture

| Action                              | Entrée                                      | Succès (`data`)                         |
| ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| `getAgendaAction(input)`            | `{ startDate, endDate, includeCancelled? }` | `AgendaDto`                             |
| `getAgendaAppointmentAction(input)` | `{ appointmentId }`                         | `AgendaAppointmentDto`                  |
| `listAgendaServicesAction()`        | —                                           | `{ services, bufferMinutes, currency }` |
| `searchAgendaClientsAction(input)`  | `{ query }` (2 à 100 caractères)            | `AgendaClientDto[]` (10 au maximum)     |

Paramètres de `getAgendaAction` :

- `startDate` et `endDate` sont des jours locaux **inclus**, soit 1 à 42 jours ;
- `includeCancelled` vaut `false` par défaut : les rendez-vous annulés sont masqués.

Un rendez-vous est inclus s'il chevauche la plage.

```ts
type AgendaDto = {
  timezone: string;
  today: string; // date du business au moment de la lecture (PostgreSQL)
  // Tranches de décalage UTC constant couvrant les jours lus (PostgreSQL) :
  // la grille place les instants avec elles, jamais avec Intl.
  offsets: { startsAt: string; endsAt: string; offsetSeconds: number }[];
  range: {
    startDate: string;
    endDate: string;
    startsAt: string;
    endsAt: string;
  };
  appointments: AgendaAppointmentDto[]; // triés par début
  blocks: AgendaBlockDto[]; // closed + blocked qui chevauchent la plage
  workingHours: {
    weekly: { id: string; weekday: number; startsAt: string; endsAt: string }[];
    days: {
      date: string; // jour local
      weekday: number; // 0 = dimanche … 6 = samedi
      startsAt: string; // bornes réelles du jour : [startsAt, endsAt)
      endsAt: string;
      openRanges: {
        startsAt: string;
        endsAt: string;
        localStartsAt: string;
        localEndsAt: string;
      }[];
    }[];
  };
};

type AgendaAppointmentDto = {
  id: string;
  version: number; // à renvoyer comme expectedVersion
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  startOccurrence: "first" | "second" | null; // voir Changements d'heure
  durationMinutes: number;
  bufferMinutes: number; // temps libre après le rendez-vous
  priceCents: number; // prix convenu à la réservation, en centimes
  currency: string; // devise de ce prix (ISO 4217)
  service: { id: string; name: string };
  client: { id: string; displayName: string };
  internalNotes: string | null;
  cancellationReason: string | null;
  source: "public" | "manual";
  createdAt: string;
  updatedAt: string;
};

type AgendaBlockDto = {
  id: string;
  version: number;
  kind: "blocked" | "closed";
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  startOccurrence: "first" | "second" | null; // affichage uniquement
  endOccurrence: "first" | "second" | null;
  reason: string | null;
};

type AgendaClientDto = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
};
```

**Prix.** `priceCents` et `currency` viennent des snapshots du rendez-vous (`price_cents_snapshot`, `currency`). Ils sont figés à la réservation et ne suivent pas les changements ultérieurs du catalogue. Un changement de prestation reprend le prix actuel de la nouvelle prestation. Il n'y a pas de paiement : c'est un prix affiché, pas un montant encaissé.

Le rendez-vous ne contient volontairement pas les coordonnées de la cliente. `searchAgendaClientsAction` renvoie l'email et le téléphone, car il faut pouvoir distinguer deux homonymes.

`workingHours.days` est calculé par PostgreSQL (`private.opening_ranges`), avec les mêmes valeurs que les créneaux publics :

- ce sont les horaires hebdomadaires plus les ouvertures exceptionnelles (`open_override`), limitées au jour réel et fusionnées (une ouverture exceptionnelle contiguë à une plage hebdomadaire forme une seule plage) ;
- règle des heures murales (voir « Fuseau horaire ») : une plage peut donner plusieurs intervalles le jour d'une heure répétée, et une plage entièrement dans l'heure sautée n'ouvre rien ce jour-là.

### Rendez-vous

| Action                              | Entrée                                                                                               | Succès (`data`)                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `createAppointmentAction(input)`    | `{ date, time, occurrence?, serviceId, client, internalNotes?, requestId? }`                         | `{ appointment: AgendaAppointmentDto, created: boolean }` |
| `updateAppointmentAction(input)`    | `{ appointmentId, expectedVersion, date?, time?, occurrence?, serviceId, clientId, internalNotes? }` | `AgendaAppointmentDto`                                    |
| `setAppointmentStatusAction(input)` | `{ appointmentId, expectedVersion, status, cancellationReason? }`                                    | `AgendaAppointmentDto`                                    |
| `cancelAppointmentAction(input)`    | `{ appointmentId, expectedVersion, reason? }`                                                        | `AgendaAppointmentDto`                                    |

Champ `client` de la création :

```ts
type AppointmentClient =
  | { type: "existing"; clientId: string }
  | {
      type: "new";
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
    };
```

**Création manuelle.**

- **Ce que le serveur calcule.** Il déduit du service **actif** la durée, la fin, le nom et le prix. Il déduit des réglages le buffer et la devise. Le business vient de la session. Une durée ou une fin envoyée par le navigateur est ignorée.
- **Placement.** Les horaires d'ouverture, le délai minimum et l'horizon maximum sont des règles de réservation pour les clientes. Ils ne s'appliquent pas à la professionnelle, qui peut placer un rendez-vous hors horaires ou dans le passé.
- **Chevauchements.** Ils sont toujours refusés : avec un autre rendez-vous, buffer compris, et avec un bloc ou une fermeture.
- **Nouvelle cliente.** Seul le prénom est obligatoire ; l'email et le téléphone sont facultatifs.
- **Normalisation des saisies.**
  - Les textes (prénom, nom, note, motif) sont normalisés en Unicode NFC puis débarrassés des espaces autour, côté serveur TypeScript et en SQL. « Émilie » précomposé et « E » + accent combinant sont identiques, dans la base comme dans l'empreinte d'idempotence.
  - L'email est débarrassé de ses espaces puis passé en minuscules **avant** validation : `" Test@Example.com "` est traité comme `test@example.com`.
- **Email déjà connu.** Un email déjà connu **dans ce business** réutilise la fiche existante sans la modifier, comme la réservation publique. Il n'y a pas de déduplication par téléphone ni par nom en V1.
- **`requestId` (idempotence).** C'est un UUID généré une fois par formulaire ; en générer un nouveau dès que le contenu du formulaire change. La clé est liée à l'empreinte SHA-256 de la commande canonique, stockée avec elle dans la même transaction : prestation, instant UTC de début, cliente (`clientId`, ou prénom, nom, email et téléphone normalisés) et note interne.
  - **Même clé, même commande** (retry, double clic) : le rendez-vous initial est renvoyé avec `created: false`, sans rien créer.
  - **Même clé, autre commande** : `idempotency_conflict` (`fieldErrors.requestId`). Rien n'est créé, pas même une nouvelle cliente, et l'ancien rendez-vous n'est jamais renvoyé comme réponse à cette autre commande.
  - **Concurrence** : les créations sont sérialisées par le verrou de planning. Deux soumissions simultanées de la même clé donnent une seule création : la seconde reçoit soit le même résultat (même commande), soit `idempotency_conflict` (commande différente).
  - Une clé n'est liée qu'après une création réussie : si la première tentative échoue (par exemple `schedule_conflict`), la clé reste libre.
  - Un retry identique après une modification du rendez-vous renvoie le rendez-vous dans son état actuel.
  - Sans `requestId`, une seconde soumission identique est refusée par le chevauchement (`schedule_conflict`).
- **Atomicité.** Tout se fait dans une seule transaction : création de la nouvelle cliente, contrôles, rendez-vous. Si le rendez-vous est refusé (`schedule_conflict`, `idempotency_conflict`…), la cliente créée pour lui n'est pas conservée.
- **Emails.** Aucun email n'est envoyé : les notifications ne font pas partie de la V1.

**Modification et déplacement** (`updateAppointmentAction`) :

- **État complet.** L'entrée est l'état complet des champs modifiables, tel qu'affiché dans le formulaire. `internalNotes` absent ou `null` efface la note.
- **Horaire.** `date` et `time` sont facultatifs, mais vont ensemble. Absents, ou égaux au `localStartsAt` chargé, ils conservent l'instant exact (voir Changements d'heure).
- **Statut.** L'heure, la prestation et la cliente ne se modifient que si le rendez-vous est `confirmed` ; sinon `appointment_not_editable`. La note interne se modifie toujours.
- **Même prestation.** La durée, le prix et le buffer réservés sont conservés, même si le catalogue a changé depuis.
- **Nouvelle prestation.** La durée, le nom et le prix sont repris de la prestation (qui doit être active). Le buffer et la devise viennent des réglages actuels.
- **Déplacement vers un créneau occupé.** Il donne `schedule_conflict`, et le rendez-vous reste inchangé.

## Statuts

| Depuis      | Vers autorisé                       | Remarque                                                        |
| ----------- | ----------------------------------- | --------------------------------------------------------------- |
| `confirmed` | `cancelled`, `completed`, `no_show` | `completed` / `no_show` seulement si le rendez-vous a commencé  |
| `no_show`   | `confirmed`, `completed`            | correction                                                      |
| `completed` | `confirmed`                         | correction, refusée si des points de fidélité ont été attribués |
| `cancelled` | —                                   | terminal : créer un nouveau rendez-vous                         |

- Toute autre transition donne `invalid_status_transition`.
- Redemander le statut actuel est un succès sans effet, ce qui absorbe un double clic.
- **Occupation.** Seule l'annulation libère le créneau : la contrainte `appointments_no_overlap` ignore les lignes `cancelled`. `completed` et `no_show` continuent d'occuper leur créneau.
- **Annulation.** Elle ne supprime jamais la ligne. `cancellationReason` est enregistré.

## Blocs d'indisponibilité

| Action                     | Entrée                                            | Succès (`data`)  |
| -------------------------- | ------------------------------------------------- | ---------------- |
| `createBlockAction(input)` | `BlockInput`                                      | `AgendaBlockDto` |
| `updateBlockAction(input)` | `{ blockId, expectedVersion, block: BlockInput }` | `AgendaBlockDto` |
| `deleteBlockAction(input)` | `{ blockId, expectedVersion }`                    | `undefined`      |

```ts
type BlockInput =
  | {
      allDay: false;
      startsAt: "YYYY-MM-DDTHH:MM";
      endsAt: "YYYY-MM-DDTHH:MM";
      reason?: string;
    }
  | {
      allDay: true;
      startDate: "YYYY-MM-DD";
      endDate: "YYYY-MM-DD";
      reason?: string;
    }; // jours inclus
```

- **Stockage.** Un bloc est une `availability_exception` de type `blocked`, créée par l'agenda. L'agenda affiche, modifie et supprime aussi les fermetures `closed` créées dans les réglages. Les ouvertures exceptionnelles `open_override` n'y sont pas modifiables : `block_not_found`.
- **Chevauchement.** Un bloc qui chevaucherait un rendez-vous non annulé est refusé avec `schedule_conflict`. Un rendez-vous n'est jamais déplacé ni annulé automatiquement.
- **Adjacence.** Un bloc peut commencer exactement à la fin d'un rendez-vous : le buffer n'est exigé qu'entre deux rendez-vous.

## Concurrence

- **Verrou de planning.** Toute écriture qui ajoute de l'occupation (création, déplacement, changement de prestation, création ou déplacement de bloc) prend le verrou de planning du business. C'est le même verrou que la réservation publique : deux écritures concurrentes sont sérialisées, et la seconde voit la première.
- **Garanties finales.** Elles sont en base :
  - la contrainte d'exclusion GiST `appointments_no_overlap`, buffer compris ;
  - les triggers rendez-vous ↔ blocs.
- **Résultat.** Deux créations simultanées du même créneau donnent un seul rendez-vous et un `schedule_conflict`. Il en va de même pour un rendez-vous et un bloc créés simultanément.
- **Édition obsolète.** Chaque rendez-vous et chaque bloc porte une `version`, incrémentée à chaque modification quel que soit le chemin. Les modifications, changements de statut, déplacements et suppressions exigent `expectedVersion`, la version chargée par l'UI. Si l'élément a changé entre-temps, l'action renvoie `stale_appointment` ou `stale_block` et rien n'est écrasé. L'UI doit alors recharger l'élément et le proposer à nouveau.

## Aucune troncature silencieuse

PostgREST plafonne toute réponse à 1000 lignes (`max_rows`) sans le signaler. Chaque liste de l'agenda est donc demandée avec un plafond explicite + 1 ligne, et un dépassement est refusé :

| Liste                                                  | Plafond | Dépassement                                                   |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------- |
| rendez-vous de la plage                                | 800     | `validation_error` (`fieldErrors.endDate`) : réduire la plage |
| exceptions de la plage (blocs, fermetures, ouvertures) | 500     | `validation_error` (`fieldErrors.endDate`) : réduire la plage |
| plages hebdomadaires                                   | 84      | `internal` (impossible via l'API des horaires)                |
| prestations actives                                    | 500     | `internal`                                                    |

Une disponibilité affichée ne peut donc jamais être fausse parce qu'une partie des blocs ou des ouvertures manque.

## Codes d'erreur

| Code                        | HTTP | Quand                                                                                      |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `unauthenticated`           | 401  | pas de session                                                                             |
| `no_business`               | 403  | session sans business (membership retiré)                                                  |
| `forbidden`                 | 403  | business non autorisé (ne devrait pas arriver via les actions)                             |
| `validation_error`          | 400  | entrée invalide, plage trop longue ou trop chargée, heure inexistante ; voir `fieldErrors` |
| `appointment_not_found`     | 404  | rendez-vous inconnu de ce business                                                         |
| `block_not_found`           | 404  | bloc inconnu de ce business (ou ouverture exceptionnelle)                                  |
| `client_not_found`          | 404  | cliente inconnue de ce business                                                            |
| `service_unavailable`       | 409  | prestation inconnue de ce business ou désactivée                                           |
| `schedule_conflict`         | 409  | chevauchement avec un rendez-vous (buffer compris) ou un bloc                              |
| `stale_appointment`         | 409  | rendez-vous modifié depuis son chargement                                                  |
| `stale_block`               | 409  | bloc modifié depuis son chargement                                                         |
| `invalid_status_transition` | 409  | transition de statut non autorisée                                                         |
| `appointment_not_editable`  | 409  | déplacement ou changement d'un rendez-vous non confirmé                                    |
| `idempotency_conflict`      | 409  | `requestId` déjà utilisé pour une autre commande de création                               |
| `ambiguous_local_time`      | 400  | heure répétée à l'automne sans `occurrence` ; voir `fieldErrors.occurrence`                |
| `internal`                  | 500  | erreur inattendue ; détail uniquement dans les logs serveur                                |

## Hors périmètre V1

- Google et Microsoft Calendar ;
- drag and drop ;
- plusieurs employées ;
- paiement ;
- emails de notification ;
- fidélité ;
- CRM complet ;
- statistiques ;
- liste d'attente.

L'intégration calendrier aura son propre modèle d'événements externes (`docs/ARCHITECTURE.md`, §8 bis). Elle ne passera pas par ces tables.
