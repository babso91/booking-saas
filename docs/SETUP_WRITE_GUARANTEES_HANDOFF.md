# Garanties d'écriture des prestations et des horaires — contrat livré

Ces trois garanties ont été repérées dans la PR #20 (écrans des prestations et des horaires). Le backend les fournit désormais : migration `supabase/migrations/20261016090000_setup_write_guarantees.sql`, plus les Server Actions existantes, dont le contrat évolue.

Ce document est la passation pour l'interface (Claude UI) : entrées, sorties, codes d'erreur, nouvel essai et relecture. Le câblage minimal fait dans cette PR pour que l'application compile et reste utilisable est décrit au § 5. L'expérience complète de conflit a depuis été faite côté UI ; elle est décrite dans [`PROFESSIONAL_SETUP.md`](PROFESSIONAL_SETUP.md) (« Sûreté des écritures »). Les sections « À faire côté UI » ci-dessous restent comme trace du contrat demandé. Seul écart : l'activation reste par valeur, sans `expectedVersion` (justification dans ce même document).

Les tests `it.fails` qui reproduisaient ces défauts sont devenus des tests ordinaires dans `tests/integration/professional-setup-concurrency.test.ts`, contre PostgreSQL réel.

## 1. Création de prestation idempotente

### Contrat

`createServiceAction(input)`

| Champ                                                                            | Type                  | Changement                            |
| -------------------------------------------------------------------------------- | --------------------- | ------------------------------------- |
| `name`, `description`, `durationMinutes`, `priceCents`, `active`, `displayOrder` | inchangés             | —                                     |
| `requestId`                                                                      | UUID, **obligatoire** | nouveau : un par commande de création |

- **Sortie :** `ServiceDto`, inchangé, avec en plus le champ `version` (§ 2).
- **Même `requestId`, même commande :** rien n'est écrit, et la réponse est la prestation créée par cette requête, **telle qu'elle est maintenant** (modifiée depuis, le cas échéant).
- **Même `requestId`, autre commande** (un seul champ différent, `displayOrder` compris) : `idempotency_conflict` (409, `fieldErrors.requestId`). Rien n'est écrit.
- **Même `requestId`, prestation supprimée depuis :** `service_deleted` (410, `fieldErrors.requestId`). Elle n'est jamais recréée.
- **`requestId` différents :** des créations distinctes, même avec le même nom. Deux prestations du même nom restent permises.

### Garanties (PostgreSQL)

- **Fonction :** `public.create_service`, `SECURITY DEFINER`, vérifie l'appartenance au business avant tout (`forbidden`).
- **Registre :** la requête est enregistrée dans `private.service_creation_requests` (clé `(business_id, request_id)`), avec une empreinte SHA-256 de la commande. La table est inaccessible aux rôles de l'API.
- **Nouveaux essais concurrents :** la clé primaire fait attendre le second appel jusqu'à la fin du premier, qui est ensuite lu. Une seule prestation est créée (testé avec 6 appels simultanés et avec des transactions entrelacées).
- **Échec :** une création refusée (contrainte, validation) n'enregistre rien. La même requête corrigée peut être renvoyée.
- **Isolation :**
  - un `requestId` n'existe qu'à l'intérieur d'un business ; le même identifiant dans un autre business est une requête indépendante, et ne révèle ni ne touche rien ;
  - un business forgé est refusé, et `anon` ne peut pas exécuter la fonction.

### À faire côté UI

1. Une clé par commande : `requestKeyFor(previous, fingerprintOf(command))` de `src/features/agenda/client/request-id.ts`, comme l'agenda et le CRM.
   - Même clé pour chaque nouvel essai du même contenu (réseau, double clic).
   - Nouvelle clé dès que le contenu change, et pour chaque nouveau formulaire après un succès.
2. Après une réponse perdue (`network`), renvoyer **la même commande avec la même clé**. La relecture de réconciliation (`reconcileCreate`) peut être retirée.
3. `idempotency_conflict` : la clé a servi à une autre commande. Régénérer la clé, puis laisser la professionnelle renvoyer.
4. `service_deleted` : informer, fermer le formulaire, relire la liste. Ne jamais renvoyer avec une nouvelle clé sans action explicite.

## 2. Version des prestations

### Contrat

- **`ServiceDto.version`** (entier ≥ 1) : renvoyé par `listServicesAction`, `createServiceAction`, `updateServiceAction`, `setServiceActiveAction` et `reorderServicesAction`.
- **`updateServiceAction({ serviceId, expectedVersion, changes })`** :
  - `expectedVersion` est **obligatoire** : la version lue avec la prestation ;
  - `changes` contient toujours seulement les champs modifiés (écriture partielle inchangée).
- **`setServiceActiveAction({ serviceId, active, expectedVersion? })`** : la version est facultative. Sans elle, l'écriture se fait par valeur (idempotente : réactiver une prestation active ne change rien).

| Situation                                                                        | Réponse                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Prestation encore à `expectedVersion`                                            | écrite ; version + 1 si quelque chose a réellement changé              |
| Prestation modifiée depuis                                                       | `stale_service` (409, `fieldErrors.expectedVersion`), rien n'est écrit |
| Prestation déjà exactement à ces valeurs (nouvel essai après une réponse perdue) | la prestation telle qu'elle est, quelle que soit la version            |
| Prestation absente ou d'un autre business                                        | `not_found` (404), qu'une version soit fausse ou non                   |
| `expectedVersion` absent                                                         | `validation_error`                                                     |

### Garanties (PostgreSQL)

- **Comparaison atomique :** le _compare-and-swap_ est le `WHERE version = expectedVersion` d'un seul `UPDATE`. Deux modifications concurrentes de la même version ne s'appliquent jamais toutes les deux : la seconde attend le verrou de ligne, relit la ligne et ne trouve plus la version (testé). La valeur la plus récente n'est jamais écrasée.
- **Version tenue par la base :** le trigger `services_version` fixe la version sur tout chemin d'écriture. Une valeur envoyée par un membre (DML direct) est ignorée.
- **Ce qui l'augmente :** le nom, la description, la durée, le prix et l'état actif (et le business).
- **Ce qui ne l'augmente pas :** la position. `reorderServicesAction` ne rend donc jamais un formulaire ouvert périmé.
- **Sémantique :** la version est celle **de la prestation**. Une modification d'un autre champ, faite sur une lecture périmée, est refusée elle aussi. C'est voulu : comme pour les fiches clientes, la professionnelle compare avant d'écraser.
- **Inchangés :** l'ordre, l'état actif ou inactif, et les instantanés des rendez-vous déjà pris (nom, durée, prix ; testé).

### À faire côté UI

1. Garder `version` avec la prestation lue (`ServiceView.version`, ajouté dans cette PR), et l'envoyer comme `expectedVersion`.
2. Après un succès, remplacer la prestation affichée par celle renvoyée : c'est sa nouvelle version.
3. `stale_service` :
   - relire (`listServicesAction`) ;
   - montrer la valeur actuelle et la valeur saisie, comme `stale_client` dans le CRM ;
   - laisser renvoyer sur la nouvelle version.
4. Activer ou désactiver depuis la liste : passer `expectedVersion` est recommandé. Le traitement de `stale_service` est alors le même qu'au point 3.

## 3. Horaires hebdomadaires : remplacés seulement depuis la semaine lue

### Contrat

`replaceBusinessHoursAction({ hours, expected })`

- **`hours` :** inchangé (la semaine complète).
- **`expected` :** **obligatoire**. C'est la semaine dont le brouillon est parti, telle que `listBusinessHoursAction` l'a lue, ou telle que le dernier enregistrement l'a renvoyée. Seuls `weekday`, `startsAt` et `endsAt` comptent : les `id` et l'ordre sont ignorés, et c'est un ensemble de plages qui est comparé.
- **Sortie :** `BusinessHourDto[]`, inchangée.
- **`listBusinessHoursAction` :** inchangée.

Sous le verrou du planning (pris en premier, comme avant), la semaine actuelle est comparée :

| La semaine actuelle est…    | Réponse                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| déjà `hours` (nouvel essai) | renvoyée telle quelle, quelle que soit `expected`, sans réécriture     |
| `expected`                  | remplacée par `hours`, en entier                                       |
| autre chose                 | `stale_business_hours` (409, `fieldErrors.expected`), rien n'est écrit |

### Garanties (PostgreSQL)

- **Pas de mise à jour perdue :** deux enregistrements simultanés sur la même base donnent un seul succès. L'autre est refusé et la semaine n'est jamais un mélange (testé, entrelacements déterministes compris).
- **Plages invalides :** un chevauchement ou une fin avant le début annule tout l'appel. La semaine enregistrée reste intacte.
- **Seul chemin d'écriture :** l'ancienne fonction à deux arguments est supprimée. Aucun chemin de l'API ne remplace plus la semaine sans base de comparaison.
- **Inchangés :** le fuseau du business, le changement d'heure (heures murales, testé autour du 25 octobre 2026 à Paris), la validation des plages, la disponibilité et la réservation.
- **Comparaison par contenu :** la semaine elle-même sert de version. C'est le contrôle transactionnel équivalent demandé, sans nouvelle colonne. Une semaine revenue entre-temps à l'identique de `expected` est acceptée : rien de ce que la professionnelle n'a pas vu n'est écrasé.

### À faire côté UI

1. Envoyer `expected` = la semaine de base du brouillon (`baseline`). C'est déjà câblé (§ 5).
2. « Remplacer par mes horaires » : envoyer `expected` = la semaine affichée dans la comparaison, la dernière lue. C'est déjà câblé.
3. `stale_business_hours` : relire (`listBusinessHoursAction`), puis montrer la comparaison existante (« Horaires modifiés ailleurs »).
4. La relecture qui précède l'enregistrement peut être retirée : le backend fait la même vérification, de façon atomique. Si elle est gardée, elle sert seulement à afficher la comparaison plus tôt.

## 4. Codes d'erreur ajoutés

| Code                   | HTTP | Action                                                         | Conduite UI                                        |
| ---------------------- | ---- | -------------------------------------------------------------- | -------------------------------------------------- |
| `stale_service`        | 409  | `updateServiceAction`, `setServiceActiveAction` (avec version) | relire, comparer, renvoyer sur la nouvelle version |
| `service_deleted`      | 410  | `createServiceAction`                                          | ne pas recréer ; fermer, relire la liste           |
| `stale_business_hours` | 409  | `replaceBusinessHoursAction`                                   | relire, montrer la comparaison                     |

Ils sont ajoutés à `AppErrorCode` (`src/lib/errors.ts`) et à `errorCopy` (`src/features/auth/client/error-copy.ts`, textes provisoires). `idempotency_conflict` (409) existait déjà.

## 5. Câblage minimal fait dans cette PR (côté UI)

Il est fait pour que l'application compile et reste utilisable avec le nouveau contrat. L'expérience de conflit n'est pas traitée.

- **`src/features/services/client/service-form.ts` :** `ServiceView.version`.
- **`src/features/services/components/service-sheet.tsx` :**
  - la création envoie `requestId`, une clé par commande (`requestKeyFor`, gardée pendant la vie du formulaire) ;
  - l'édition envoie `expectedVersion: target.service.version` ;
  - la réconciliation après réponse perdue est conservée telle quelle (à retirer, § 1).
- **`src/features/availability/components/business-hours-editor.tsx` :**
  - `save(force, expected = baseline)` envoie `expected` ;
  - « Remplacer par mes horaires » passe la semaine affichée.
- **`src/features/auth/client/error-copy.ts` :** les trois textes (obligatoires pour le typage).
- **Tests UI :**
  - fixtures avec `version` ;
  - assertions des appels avec `requestId`, `expectedVersion` et `expected` ;
  - test du schéma des horaires.

Non fait (Claude UI) :

- garder la clé de création avec le brouillon après une fermeture et une réouverture de la feuille ;
- comparer en cas de `stale_service` ;
- traiter `stale_business_hours` par la comparaison existante, au lieu du message générique ;
- retirer la réconciliation et la relecture préalable.

## Tests

- **`tests/integration/professional-setup-concurrency.test.ts` :** 34 tests contre PostgreSQL réel.
  - Création : nouvel essai identique, nouveaux essais simultanés, essai en attente d'un premier essai validé ou annulé, autre commande, prestation supprimée, échec puis correction, isolation des business, registre inaccessible.
  - Prestations : version périmée, modifications simultanées, nouvel essai d'une modification, ordre, activation, version infalsifiable, instantanés des rendez-vous, autre business.
  - Horaires : base périmée, enregistrements simultanés, attente sous le verrou, nouvel essai, comparaison en ensemble, semaine invalide, absence de base, autre business, changement d'heure.
- **`tests/integration/schedule-locking.test.ts` :** les tests de sérialisation vérifient désormais que le second appel sur la même base est refusé, jamais fusionné. Un appel fondé sur la semaine validée entre-temps la remplace entièrement.
- **`tests/upgrade/setup-write-guarantees.test.ts` :** mise à niveau d'une base peuplée. Les prestations passent en version 1 sans réécriture ; horaires, rendez-vous et instantanés sont intacts.
- **Sensibilité (mutations) :** chaque garantie retirée fait échouer ses tests.
  - Sans le _compare-and-swap_ de version : 4 tests.
  - Sans `requestId` : 6 tests.
  - Sans la comparaison de la semaine dans PostgreSQL : 7 tests.
