# Continuité staging → production des professionnelles pilotes

Ce document décrit comment la configuration légitime d'une professionnelle pilote (Izabela en premier) pourra passer de staging à la production au lancement commercial, **sans copier une base sur l'autre**.

Cette PR livre le format et un prototype testé en local uniquement :

- l'export en lecture seule ;
- le plan d'import en dry-run ;
- la vérification d'idempotence.

**Aucun transfert réel n'a été fait.** L'application d'un plan sur une base réelle reste à construire, dans une PR validée à part (§ 6).

- **Code :** `src/features/pro-config/transfer/` (`format.ts`, `export.ts`, `plan.ts`).
- **Tests :**
  - `src/features/pro-config/transfer/transfer.test.ts` ;
  - `tests/integration/pro-config-export.test.ts`, sur la base locale.

## 1. Principes

1. **Environnements indépendants.**
   - La production n'est jamais une copie de staging.
   - Aucun identifiant technique n'est réutilisé d'un environnement à l'autre.
   - Le plan refuse un import vers le même environnement (`same_environment`).
2. **Liste blanche.** Seul ce que le format décrit peut voyager. Tout champ inconnu est refusé, à la lecture comme au scellement.
3. **Consentement.** Chaque document porte la référence de son accord écrit (`consent.reference`, `consent.grantedAt`). Sans elle, le document est invalide.
4. **Comptes Auth jamais copiés.**
   - Ni mot de passe, ni session, ni jeton.
   - Elle crée elle-même son compte en production (inscription normale, email confirmé) et son établissement (onboarding).
   - L'import cible ensuite ce compte et cet établissement, choisis par l'opérateur après vérification de son identité (§ 4).
5. **Idempotence.** Rejouer un import déjà appliqué ne change rien (testé : le plan d'un plan appliqué est vide).
6. **Dry-run d'abord.** Rien n'est appliqué sans un plan relu par l'opérateur et validé par elle.

## 2. Ce qui voyage (format `booking.professional-config`, version 1)

| Section             | Contenu                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `business`          | nom, description, téléphone, adresse, fuseau, politique d'annulation (**jamais le slug**, voir § 3) |
| `settings`          | devise, pas des créneaux, battement, délais de réservation, réactivation                            |
| `services`          | prestations, chacune avec son identifiant d'origine (`sourceId`) pour le lien                       |
| `hours`             | semaine type                                                                                        |
| `memberPreferences` | ses préférences d'apparence                                                                         |
| `assets`            | logo **déclaré**, jamais transporté en v1 (`transferred: false`)                                    |
| `excluded`          | ce qui est resté : prestations exclues (ids), **nombre** de clientes et de rendez-vous              |

**Ne voyagent pas, par construction :**

- les clientes, y compris les fausses clientes de test ;
- les rendez-vous, notes, historique de fidélité, emails ;
- les connexions calendrier (jetons) et l'Espace client ;
- les comptes Auth.

Les clientes et les rendez-vous sont seulement **comptés**, pour que l'opérateur voie ce qui reste en staging. Aucune donnée de cliente n'apparaît dans le document (testé).

**Prestations de test.** L'opérateur les repère sur le dry-run et les exclut nommément (`excludeServiceIds`). Elles apparaissent dans `excluded.services`.

**Intégrité.** Le document est scellé par un SHA-256 de son JSON canonique (clés triées). Un document modifié à la main après l'export est refusé (`checksum_mismatch`).

## 3. Plan d'import (dry-run)

`planImport(source, destination, links)` compare deux exports : celui de staging et celui de sa nouvelle activité en production, lu par le même exporteur. Il ne lit ni n'écrit rien d'autre.

- **Activité et réglages :** liste des champs qui changeraient (avant → après).
- **Prestations :**
  - liées par `links` (identifiant source → identifiant destination, conservés par la destination après chaque import) ;
  - sans lien : `create` ; liée et différente : `update`, champ par champ ; sinon `unchanged` ;
  - les prestations qu'elle a créées elle-même en production ne sont jamais touchées (`untouchedServices`).
- **Horaires :** remplacement complet, sur la base de la semaine actuelle de la destination. Lors de l'application, c'est la valeur attendue de `replace_business_hours` : `stale_business_hours` si elle a changé entre-temps.
- **Préférences :** posées seulement si elle n'en a pas encore en production. Sinon, **les siennes l'emportent** (`keep_destination`).
- **Slug :** jamais changé. Celui de production, choisi à l'onboarding, est gardé, et une différence est signalée.
- **Refus bloquants :** même environnement ; autre devise (un prix n'est jamais converti) ; lien vers une prestation disparue ; liens non bijectifs.

`applyToSnapshot` montre l'effet d'un plan sur l'export de destination. `planIsEmpty` doit être vrai pour le plan suivant : c'est la vérification après import.

## 4. Procédure prévue pour une professionnelle pilote

1. **Consentement écrit** d'Izabela : ce qui est transféré, ce qui ne l'est pas, et une référence.
2. Elle **crée son compte et son activité en production**, elle-même.
3. **Association contrôlée.** L'opérateur vérifie que l'email du compte de production est celui de staging, confirmé, et qu'elle est `owner` de l'activité de destination. Il obtient sa confirmation, par exemple par un code envoyé à cet email.
4. **Export staging** (lecture seule) : il est refusé si elle n'est pas `owner` de l'activité (testé). Prestations de test exclues.
5. **Export production** de sa nouvelle activité, puis **dry-run** : le plan est relu par l'opérateur et validé par elle.
6. **Application** (§ 6), puis **vérification** : nouvel export de production, nouveau plan, qui doit être vide.
7. Archivage du document, du plan et de la référence de consentement. Aucune autre copie.

## 5. Photos et fichiers (future intégration)

Le format v1 déclare le logo sans le transporter. La version suivante :

- ajoutera, par fichier : chemin source, SHA-256, taille, type MIME ;
- copiera chaque fichier d'un bucket à l'autre sous un **nouveau** chemin de destination (`<business_id de destination>/…`), en vérifiant empreinte et type ;
- puis écrira la référence (`logo_path`, futur `business_branding`) ;
- refera la copie de façon idempotente, par empreinte.

## 6. Reste à construire (hors de cette PR)

- **L'application d'un plan sur une base réelle**, par les fonctions existantes : chaque écriture garde ses contrôles.
  - `create_service`, avec un `requestId` dérivé de `sourceId` (UUID v5) : une création rejouée ne crée rien de plus ;
  - `replace_business_hours`, avec la semaine attendue ;
  - `save_member_preferences`, **en tant qu'elle** (session de son compte, version attendue 0).
  - Les liens doivent être conservés dans une table privée de la destination (`private.config_transfer_links`).
  - Application en une transaction par section, journalisée.
- **Un outil opérateur** (ligne de commande), avec la confirmation du point 3 et un mode `--dry-run` par défaut.
- Les sections fidélité (programme, récompenses) et `business_branding`, dans une version 2 du format.

Rien de tout cela ne doit être exécuté contre staging ou la production sans une procédure validée explicitement.
