# Catalogue : catégories, prestations, options

Le catalogue conçu dans le laboratoire Experience Engine (`proto/experience-engine` : `docs/EXPERIENCE_ENGINE.md` § 2 bis, `src/features/experience-lab/catalog/model.ts`) devient une fonctionnalité persistante du SaaS. Ce n'est pas un second catalogue : la table `services` reste la source de vérité unique, et le laboratoire en reprenait déjà les limites. Cette tranche lui ajoute les catégories et les options.

Migration : `supabase/migrations/20261103090000_service_catalog.sql` (additive).

## 1. Ce qui appartient à qui

- **Le catalogue est une donnée métier**, jamais une donnée de design. Aucun univers du mini-site ne le possède : changer d'univers ne change ni ses catégories, ni ses prestations, ni ses options.
- **Aucun métier n'est codé.** Aucune catégorie n'est imposée ni prédéfinie, et une prestation peut ne pas en avoir. Les options sont des questions et des réponses libres (testé avec trois catalogues sans rapport : cils, henné, épilation).
- **Isolation stricte par établissement :**
  - lecture sous RLS (membres seulement) ;
  - écritures uniquement par des fonctions qui vérifient l'appartenance ;
  - clés étrangères composites `(id, business_id)` : une catégorie ou une réponse d'un autre établissement n'existe pas pour celui-ci.

## 2. Modèle

| Table                      | Champs                                                                                               | Écriture                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `service_categories`       | `name` (1–60), `visible`, `display_order`, `version`                                                 | fonctions `*_service_category` seulement |
| `services` (existante)     | inchangée, plus `category_id` (facultatif) et `options_revision`                                     | comme avant (RLS, actions existantes)    |
| `service_options`          | `question` (1–120), `required`, `display_order`                                                      | `set_service_options` seulement          |
| `service_option_choices`   | `label` (1–60), `price_delta_cents` (0–9 999 999), `duration_delta_minutes` (0–240), `display_order` | `set_service_options` seulement          |
| `appointments` (existante) | plus `options_snapshot` (jsonb, `[]` par défaut)                                                     | réservation et agenda                    |

- **Prestations existantes :**
  - identifiants, colonnes, limites et actions inchangés ;
  - `ServiceDto` gagne `categoryId` ;
  - la `version` change aussi avec la catégorie et les options. C'est le jeton de comparaison d'un éditeur.
- **Supprimer une catégorie** garde ses prestations, sans catégorie : rien de ce qu'elle a réservé ou tarifé n'est perdu. Pour les retirer aussi, elle supprime (jamais réservée) ou désactive (déjà réservée) chacune, comme avant.
- **Groupe d'options :**
  - une seule réponse par groupe en V1 ;
  - `required` : une réponse est obligatoire ;
  - facultatif : sans réponse, rien n'est ajouté. Une réponse explicite « Aucun supplément » (0 €, 0 min) est la sienne à créer si elle veut l'afficher.
  - De 1 à 20 réponses par groupe, 20 groupes au plus.
- **Durée maximale.** Une prestation avec ses réponses les plus longues ne dépasse jamais 720 min. C'est vérifié :
  - à l'enregistrement des options ;
  - quand la durée de la prestation change (déclencheur) ;
  - à chaque devis.
- **Prix maximal.** Le prix de la prestation plus ses réponses les plus chères tient toujours dans le prix d'un rendez-vous (`integer`, 2 147 483 647 centimes), calculé en `bigint`. C'est vérifié à l'enregistrement des options et quand le prix de la prestation change (déclencheur), sinon refus `validation_error`. Une configuration impossible à réserver ne peut pas être enregistrée.
- **Identifiants.** Ils sont toujours comparés en `uuid` : un même identifiant écrit en majuscules et en minuscules est un doublon, refusé avant toute écriture.

## 3. Une seule règle de prix et de durée

`private.quote_options(business, service, choiceIds)` est **la** règle. Elle est utilisée par tous les chemins qui proposent, réservent ou modifient un rendez-vous :

| Chemin                | Fonction                                                     |
| --------------------- | ------------------------------------------------------------ |
| Créneaux publics      | `get_available_slots` → `private.available_slots`            |
| Devis public          | `quote_public_service`                                       |
| Réservation publique  | `create_public_booking` → `private.create_public_booking_at` |
| Agenda : création     | `agenda_create_appointment`                                  |
| Agenda : modification | `agenda_update_appointment`                                  |

- **Prix total** = prix de la prestation + suppléments des réponses choisies. **Durée totale** = durée + durées des réponses. Le navigateur n'envoie que des identifiants de réponses, jamais un montant ni une durée.
- **Refus, sans rien écrire :**

  | Cas                                                           | Code                        |
  | ------------------------------------------------------------- | --------------------------- |
  | doublon, deux réponses au même groupe, plus de 50             | `validation_error`          |
  | une réponse qui n'est pas (ou plus) l'une de cette prestation | `option_choice_unavailable` |
  | un groupe obligatoire sans réponse                            | `options_required`          |

- **Créneaux et revalidation.** Les créneaux sont calculés pour la durée totale, par le calcul existant (`compute_available_slots`). Celui-ci tient compte des horaires, des fermetures et blocages, des rendez-vous existants et de leurs tampons, des périodes occupées des agendas externes, du préavis, de l'horizon, et des changements d'heure (minutes réelles). La réservation refait exactement le même calcul, avec la même durée, sous le verrou de l'agenda. La contrainte d'exclusion reste la garantie finale contre les doubles réservations.
- **Ce qu'elle a vu (facultatif).** `expectedPriceCents` et `expectedDurationMinutes` : si le serveur arrive à autre chose, rien n'est réservé (`quote_changed`). Sans ces champs, le prix du serveur s'applique, comme pour une prestation aujourd'hui.

## 4. Visibilité et publication

**Stratégie retenue : effet immédiat, publication par l'état, comme les prestations aujourd'hui.**

- Une prestation est réservable en ligne si elle est **active** et si elle est **sans catégorie ou dans une catégorie visible**.
- Une catégorie masquée retire ses prestations de la page publique, des créneaux et de la réservation en ligne. La professionnelle peut toujours les réserver dans son agenda.
- Il n'y a pas de brouillon de catalogue côté serveur. Chaque écriture est atomique et validée : les options d'une prestation sont remplacées d'un bloc, et une valeur invalide est refusée en entier. Un prix « à moitié tapé » ne peut donc pas devenir réservable, tant que l'interface n'envoie que des valeurs validées (à l'enregistrement, pas à chaque frappe).
- Le brouillon et la publication du laboratoire restent ceux du **design** du site (`site_versions`, hors de cette tranche).

Voir § 9 pour la décision V1.

## 5. Concurrence, idempotence, versions

- **Lectures complètes.** Le catalogue du studio (`get_catalog`) et les disponibilités publiques (`get_public_availability`) sont lus chacun en **un seul document**, une seule ligne. Le plafond de lignes de l'API (PostgREST `max_rows`, 1 000) ne peut pas les tronquer, quel que soit le nombre de prestations et de réponses. Testé avec 51 prestations à 20 réponses (1 020 réponses). La lecture d'une table de l'API, elle, s'arrête à 1 000 : le catalogue ne l'utilise plus.

- **Ordre catalogue / réservations.** Les écritures d'options et de visibilité prennent le verrou d'agenda de l'établissement (`private.lock_business_schedule`), comme les réservations. `set_service_options` verrouille aussi la ligne de la prestation, que la réservation tient en partage. Une réservation voit donc le catalogue d'avant une modification, ou la modification attend sa validation : jamais la moitié. C'est testé avec des transactions entrelacées :
  - une réponse supprimée pendant qu'une réservation attend donne `option_choice_unavailable` ;
  - une catégorie masquée pendant qu'une réservation attend donne `service_not_found`.
- **Idempotence :**
  - **création de catégorie** : `requestId`. Une nouvelle tentative renvoie la même catégorie ; `category_deleted` si elle a été supprimée depuis ; `idempotency_conflict` pour une autre commande ;
  - **réservation publique et agenda** : `requestId` comme avant. Les réponses entrent dans l'empreinte, triées (l'ordre d'envoi ne compte pas) et **seulement s'il y en a**. Une requête sans réponse garde exactement l'empreinte d'avant la migration : une nouvelle tentative d'une réservation faite avant le déploiement est rejouée, pas refusée (test de montée de version).
- **Versions :**
  - catégorie : `expectedVersion`, sinon `stale_category` ;
  - options : `expectedVersion` de la prestation, sinon `stale_service`.

  Dans les deux cas, une nouvelle tentative qui trouve déjà les mêmes valeurs renvoie l'état actuel.

## 6. Historique

Le rendez-vous garde `service_name_snapshot`, `price_cents_snapshot` et `duration_minutes_snapshot` (désormais les **totaux**), ainsi que `options_snapshot` :

```json
[{ "optionId", "question", "choiceId", "label", "priceDeltaCents", "durationDeltaMinutes" }]
```

- Une modification ultérieure ne réécrit jamais un rendez-vous existant. C'est testé : prix, libellés, options supprimées, prestation renommée, catégorie supprimée.
- **Agenda, modification :**
  - même prestation, avec des réponses absentes ou identiques à celles du rendez-vous : prix et durée convenus conservés (déplacer ne retarife jamais) ;
  - autre prestation ou autres réponses : tarifé maintenant, par la même règle. Une autre prestation sans réponses vaut « aucune réponse » ;
  - les réponses d'un rendez-vous qui n'est plus confirmé ne changent pas (`appointment_not_editable`).
- Les rendez-vous d'avant la migration ont `options_snapshot = []`. Ils sont identiques octet pour octet sur leurs colonnes existantes (test de montée de version).

## 7. Clients écrits avant les options

- **Une prestation sans options se réserve exactement comme avant :** mêmes créneaux, même prix, même durée, même empreinte d'idempotence, `options: []`.
- **`GET /api/public/businesses/[slug]`** garde `services` tel quel. Une prestation d'une catégorie masquée n'y figure plus.
- **Une prestation avec un groupe obligatoire** ne se réserve pas sans réponse (`options_required`), même pour un ancien client. Le serveur ne choisit jamais une réponse à sa place, car cela changerait le prix. Avec seulement des groupes facultatifs, un ancien client réserve la prestation de base.

## 8. Contrat d'interface pour Claude UI

### Studio et dashboard (Server Actions)

| Action                                                                                                   | Données             | Erreurs propres                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `getCatalogAction()`                                                                                     | `CatalogDto`        | — (complet, en un seul document)                                               |
| `createCategoryAction({ name, visible?, requestId })`                                                    | `CategoryDto`       | `idempotency_conflict`, `category_deleted`                                     |
| `updateCategoryAction({ categoryId, expectedVersion, name?, visible? })`                                 | `CategoryDto`       | `stale_category`, `category_not_found`                                         |
| `reorderCategoriesAction({ categoryIds })` (toutes, une fois)                                            | `CategoryDto[]`     | `validation_error`                                                             |
| `deleteCategoryAction({ categoryId })`                                                                   | —                   | `category_not_found`                                                           |
| `setServiceOptionsAction({ serviceId, expectedVersion, options, deletedOptionIds?, deletedChoiceIds? })` | `CatalogServiceDto` | `options_incomplete`, `stale_service`, `service_not_found`, `validation_error` |
| `createServiceAction({ …, categoryId? })` (existante)                                                    | `ServiceDto`        | `category_not_found`                                                           |
| `updateServiceAction({ serviceId, expectedVersion, changes: { …, categoryId? } })` (existante)           | `ServiceDto`        | `category_not_found`, `stale_service`                                          |
| `reorderServicesAction`, `setServiceActiveAction`, `deleteServiceAction` (existantes)                    | inchangées          | inchangées                                                                     |

```ts
type CatalogDto = {
  categories: CategoryDto[]; // dans son ordre
  services: (ServiceDto & { options: ServiceOption[] })[]; // ServiceDto.categoryId: string | null
};
type CategoryDto = { id; name; visible; displayOrder; version };
type ServiceOption = { id; question; required; choices: OptionChoice[] };
type OptionChoice = { id; label; priceDeltaCents; durationDeltaMinutes };
```

**`options` de `setServiceOptionsAction`.** C'est la liste complète, dans l'ordre :

- `id` absent ou `null` crée un groupe ou une réponse, et un `id` existant le garde ;
- **rien n'est supprimé par omission.** Un groupe existant absent de `options` doit figurer dans `deletedOptionIds`, et une réponse existante d'un groupe conservé dans `deletedChoiceIds`. Sinon, l'enregistrement est refusé (`options_incomplete`, 409) sans rien écrire. Un éditeur qui n'aurait reçu qu'une partie des options ne peut donc jamais supprimer ce qu'il n'a pas vu : il doit recharger (`getCatalogAction`). Supprimer un groupe supprime ses réponses. Un identifiant déjà supprimé est ignoré (nouvelle tentative). Un même identifiant deux fois dans une liste de suppression, quelle que soit sa casse, est refusé (`validation_error`) ;
- **nouvelle tentative depuis une version dépassée :** elle n'est acceptée comme déjà faite que si **tous** ses effets sont présents. Il faut le même contenu, dans le même ordre, chaque identifiant conservé à la place indiquée, et chaque suppression demandée réellement appliquée. Sinon, `stale_service` sans rien écrire. Un groupe supprimé puis recréé à l'identique par quelqu'un d'autre, ou gardé par un identifiant qui n'existe plus, n'est donc pas pris pour un succès ;
- les identifiants des réponses conservées ne changent pas, et les rendez-vous gardent leur instantané ;
- une modification réussie renvoie la prestation avec sa nouvelle `version`.

**Correspondance avec le laboratoire** (`catalog/model.ts`) :

| Laboratoire                              | Produit                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Category { id, name, visible }`         | `CategoryDto` (+ `version`, `displayOrder`)                                                                                                                     |
| `CatalogService.categoryId`, `options`   | `ServiceDto.categoryId`, `CatalogServiceDto.options`                                                                                                            |
| ordre des tableaux                       | `displayOrder` ; réordonner : `reorderCategoriesAction`, `reorderServicesAction` (liste complète des prestations)                                               |
| `ServiceOption { question, choices }`    | `+ required`                                                                                                                                                    |
| « la première réponse est le défaut »    | **côté interface seulement** : préselectionner la première réponse d'un groupe obligatoire. Le serveur n'applique jamais de défaut : il faut envoyer la réponse |
| au moins 2 réponses par option           | au moins 1 (un groupe facultatif à une réponse est une case à cocher)                                                                                           |
| `removeCategory(…, keepServices: false)` | supprimer ou désactiver chaque prestation, puis `deleteCategoryAction`                                                                                          |
| `showcase()`                             | `get_public_catalog` (même projection), voir ci-dessous                                                                                                         |
| `quote(service, picks)`                  | `quote(service, choiceIds)` de `src/features/catalog/model.ts` (affichage) ; le serveur fait foi                                                                |
| `validate()`                             | `src/features/catalog/schemas.ts` (Zod), refusé aussi par la base                                                                                               |
| brouillon / « Publier » du catalogue     | effet immédiat à l'enregistrement (§ 4, § 9)                                                                                                                    |

### Réservation publique (routes HTTP)

- **`GET /api/public/businesses/[slug]`** renvoie `{ business, services, catalog }`. `catalog` : `PublicCatalog`.

  ```ts
  type PublicCatalog = {
    currency: string;
    groups: {
      category: { id: string; name: string } | null; // null : sans catégorie, en dernier
      services: {
        id;
        name;
        description;
        durationMinutes;
        priceCents;
        options: ServiceOption[];
      }[];
    }[];
  };
  ```

  - Ne figurent que les catégories visibles qui ont au moins une prestation réservable, dans son ordre ; une catégorie vide ou masquée n'apparaît jamais.
  - Sans catégorie : en dernier, sans titre.
  - Catalogue vide : `groups: []`.

- **`GET /api/public/businesses/[slug]/availability?serviceId=…&date=YYYY-MM-DD&optionChoiceIds=a,b`** renvoie `{ date, timezone, slots, quote }`.
  - Les créneaux sont calculés pour la durée totale.
  - Créneaux et devis viennent **d'une seule lecture** (`get_public_availability`, une fonction `STABLE` : un seul instantané). Une modification de la prestation pendant la requête ne peut pas donner des créneaux pour une durée et un devis pour une autre. La réservation revalide quand même tout sous le verrou.
  - `quote` : `{ serviceName, durationMinutes, priceCents, currency, options }`, le prix et la durée que le serveur réservera.
  - Mettre à jour les créneaux à chaque changement de réponse : la durée change.
- **`POST /api/bookings`** prend les mêmes champs qu'avant, plus :
  - `optionChoiceIds?: string[]` ;
  - `expectedPriceCents?`, `expectedDurationMinutes?` : recommandés, ceux de `quote`.

  La réponse ajoute `options` (instantané) ; `priceCents` et `durationMinutes` sont les totaux.

| Code                        | HTTP | Quoi faire                                                                           |
| --------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `options_required`          | 422  | demander la réponse manquante                                                        |
| `options_incomplete`        | 409  | (studio) recharger les options avant d'enregistrer                                   |
| `option_choice_unavailable` | 409  | recharger le catalogue (une réponse a été retirée)                                   |
| `quote_changed`             | 409  | recharger le devis et le montrer avant de réessayer (même `requestId` ou un nouveau) |
| `service_not_found`         | 404  | la prestation n'est plus réservable en ligne (désactivée ou catégorie masquée)       |
| `slot_unavailable`          | 409  | inchangé                                                                             |

### Agenda (Server Actions existantes)

- `createAppointmentAction` prend `optionChoiceIds?` (absent : aucune réponse).
- `updateAppointmentAction` prend `optionChoiceIds?` (règles du § 6).
- `AgendaAppointmentDto` gagne `options: OptionSnapshot[]`. `priceCents` et `durationMinutes` sont les totaux convenus.
- Les erreurs sont celles du tableau ci-dessus.

## 9. Publication : décision V1 (effet immédiat)

Le laboratoire recommandait un brouillon côté serveur, publié avec le site. Le dashboard actuel applique chaque modification de prestation immédiatement (avec `active`). J'ai livré l'**effet immédiat**, compatible avec l'existant et sans système de publication nouveau.

| Option                                            | Pour                                                                                                                                                                         | Contre                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Effet immédiat** (livré)                     | simple ; même comportement que les prestations aujourd'hui ; le dashboard et le mini-site disent toujours la même chose ; aucune double source de vérité pour la réservation | une série de modifications n'est pas atomique dans son ensemble (chaque enregistrement l'est). Pour préparer une nouvelle carte sans la montrer : catégorie masquée ou prestations inactives, puis tout afficher                                 |
| **B. Brouillon de catalogue publié avec le site** | « Publier » cohérent pour le design et la carte ; aperçu complet avant mise en ligne                                                                                         | deux versions du catalogue : laquelle l'agenda réserve-t-il ? Il faut versionner prestations, options et instantanés, gérer les conflits brouillon / modifications du dashboard, et les rendez-vous pris entre-temps. Un chantier à part entière |
| **C. Hybride**                                    | effet immédiat pour les prix, durées et options (données métier) ; brouillon seulement pour la présentation (ordre, textes, design)                                          | la frontière doit être expliquée dans le studio                                                                                                                                                                                                  |

**Décision provisoire (4 novembre 2026), pour la V1 :**

- **effet immédiat** à l'enregistrement pour les données métier : catégories, prestations, prix, durées et options ;
- **brouillon et publication** distincts, réservés au design du futur mini-site ;
- **aucun second moteur de publication** pour le catalogue.

C'est l'option A, qui reste compatible avec C plus tard : la présentation est déjà séparée du catalogue.

## 10. Dépendance : options obligatoires et parcours public actuel

**Ce qui est en place.** Le serveur gère entièrement les options, y compris obligatoires : catalogue public, créneaux, devis, réservation, agenda.

**Ce qui manque.** Le parcours public de réservation actuel (`src/features/public-booking/`, la page `/b/[slug]`) ne connaît pas encore les options. Il lit l'ancienne liste `services`, demande les créneaux sans réponses et réserve sans réponses.

**Ce qui arriverait aujourd'hui** si une prestation publiée avait un groupe **obligatoire** :

- la page l'afficherait, au prix de base ;
- la demande de créneaux et la réservation répondraient `options_required` : **la cliente ne pourrait pas la réserver**.

Aucun rendez-vous n'est faussé : le serveur refuse, il ne devine pas de réponse et ne réserve pas un prix faux. Mais la prestation est **inutilisable en ligne**.

Avec seulement des groupes **facultatifs**, le parcours actuel réserve la prestation de base, sans supplément. C'est correct, mais la cliente ne peut pas choisir d'option.

**Pourquoi ce n'est pas un risque aujourd'hui.** Aucun écran ne crée encore d'options : le formulaire de prestations du dashboard ne les connaît pas. Seuls `setServiceOptionsAction` et la RPC `set_service_options` peuvent en écrire.

**Conditions d'activation, avant toute ouverture réelle des options aux professionnelles :**

1. Le parcours public (Claude UI) utilise `catalog` de `GET /api/public/businesses/[slug]`. Pour chaque prestation à options, il affiche les groupes, préselectionne la première réponse des groupes obligatoires et met à jour le prix et la durée.
2. Il passe `optionChoiceIds` aux créneaux et relit les créneaux à chaque changement de réponse (la durée change). Il affiche le `quote` du serveur.
3. Il envoie `optionChoiceIds`, `expectedPriceCents` et `expectedDurationMinutes` à `POST /api/bookings`. Il traite `options_required`, `option_choice_unavailable` et `quote_changed` (§ 8).
4. Le récapitulatif et la confirmation affichent les réponses (`options` de la réponse).
5. Un e2e réel, de la page publique à l'agenda, réserve une prestation avec une option obligatoire et une facultative, puis vérifie le prix et la durée dans l'agenda.
6. **Seulement ensuite**, l'éditeur d'options du studio ou du dashboard est livré aux professionnelles. Si les deux sont livrés ensemble, l'ordre de déploiement suit le même ordre : parcours public d'abord.

Tant que les conditions 1 à 5 ne sont pas remplies, ne pas exposer l'éditeur d'options. Les catégories, elles, peuvent être utilisées dès maintenant : une catégorie masquée retire seulement des prestations de la réservation en ligne, et le parcours actuel le respecte déjà (via `services`).

## 11. Limites

- **Interface non branchée** :
  - le dashboard gère les catégories (`docs/EXPERIENCE_ENGINE_INTEGRATION.md`, PR 1) mais pas encore les options : leur éditeur attend la réservation publique (§ 10) ;
  - la réservation publique actuelle (un ancien client) ne connaît pas les options. Une prestation avec un groupe obligatoire y répondrait `options_required` à la réservation et aux créneaux, tant que le branchement n'est pas fait.
- **Transfert pro-config** (`src/features/pro-config/transfer/`) : il exporte les prestations sans leurs catégories ni leurs options (format v1). À étendre avant un transfert réel de pilotes qui utilisent ces fonctions.
- **Autres affichages :**
  - les emails, l'espace client, le CRM et la synchronisation d'agenda affichent le nom et le prix total, pas encore le détail des réponses. L'instantané est disponible (`options_snapshot`, et `options` dans la charge de l'email de confirmation) ;
  - la fidélité compte sur le prix total, comme tout montant convenu.
- Une seule réponse par groupe (V1). Pas de quantités, pas de réponses dépendantes d'autres réponses, pas de prix par catégorie de clientes.
- **Pas d'ordre « avant / après » pour un supplément de durée :** la durée totale est un seul bloc.
- **Prix vu non vérifié pour les anciens clients :** sans `expectedPriceCents`, un prix modifié entre la lecture et la réservation est réservé au nouveau prix, comme pour une prestation sans options aujourd'hui.
