# Préférences personnelles des professionnelles — contrat livré

Ce document décrit le socle backend qui garde les préférences d'apparence de chaque professionnelle sur son compte. Il sert de passation à Claude UI pour brancher le moteur d'apparence de Studio 1 (PR #28, `src/features/appearance`) sur ce socle.

Cette PR ne modifie pas l'interface : le moteur d'apparence n'est pas encore sur `main`. Le câblage est décrit au § 6.

- **Migration :** `supabase/migrations/20261031090000_member_preferences.sql`.
- **Code :** `src/features/preferences/`.
- **Tests :**
  - `tests/integration/member-preferences.test.ts` (PostgreSQL et PostgREST réels, sessions Supabase Auth réelles) ;
  - `tests/upgrade/member-preferences.test.ts` ;
  - les tests unitaires de `src/features/preferences/`.

## 1. Ce qui appartient à qui

| Donnée                                                                               | Propriétaire                                  | Où                                                                 |
| ------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| Style (Classique, Studio, Écrin, Carnet), ambiance, clair/sombre, accent, animations | **la professionnelle**, dans un établissement | `public.member_preferences` (cette PR)                             |
| Préférences d'affichage personnelles futures (widgets de l'accueil…)                 | la professionnelle                            | même table, nouvelles colonnes (§ 5)                               |
| Identité de marque, logo, photos, mini-site, réglages partagés de l'activité         | **l'établissement**                           | `businesses`, `business_settings`, futur `business_branding` (§ 7) |

Les préférences d'une professionnelle ne changent jamais ce que voient les autres membres ni les clientes. La personnalisation de l'établissement ne passe jamais par ses préférences.

## 2. Schéma

`public.member_preferences` : une ligne par appartenance (`business_id`, `user_id`).

| Colonne                    | Type        | Valeurs                                                                                          | Défaut      |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------ | ----------- |
| `business_id`, `user_id`   | uuid        | clé primaire ; clé étrangère vers `business_members (business_id, user_id)`, `on delete cascade` | —           |
| `style`                    | text        | `classique`, `studio`, `ecrin`, `carnet`                                                         | `classique` |
| `ambiance`                 | text        | `atelier`, `lin`, `sauge`                                                                        | `atelier`   |
| `color_mode`               | text        | `light`, `dark`, `system`                                                                        | `light`     |
| `accent`                   | text, null  | `#RRGGBB` en majuscules, ou `null` (couleur du style)                                            | `null`      |
| `motion`                   | text        | `standard`, `discrete`, `none`                                                                   | `standard`  |
| `version`                  | bigint ≥ 1  | tenue par la base                                                                                | 1           |
| `created_at`, `updated_at` | timestamptz | tenues par la base                                                                               | —           |

**Pourquoi ce schéma :**

- **Par appartenance, pas par utilisateur.** Une professionnelle dans deux établissements a deux lignes indépendantes. Quand elle quitte un établissement, sa ligne disparaît avec son appartenance : aucune préférence orpheline, aucune trace dans un établissement où elle n'est plus.
- **Des colonnes typées, pas un document JSON libre.** Chaque valeur est contrôlée par la base. Les styles partagent les mêmes champs : ajouter un style ne crée ni table ni colonne.
- **Une seule liste de valeurs.** `private.member_preferences_valid` sert à la fois à la contrainte de la table et à la fonction d'écriture. Elle s'applique à tous les chemins d'écriture, `service_role` compris.
- **Aucune ligne = valeurs par défaut, version 0.** Aucune ligne n'est créée à l'inscription ni par la migration.

**Compte ou établissement inexistant :**

- sans appartenance, aucune ligne ne peut exister (clé étrangère) ;
- une écriture pour un établissement qui n'est pas le sien, ou qui n'existe pas, est refusée (`forbidden`) ;
- sans session, l'écriture est refusée (`unauthenticated`) et la lecture ne renvoie rien.

## 3. Sécurité multi-tenant

- **Lecture.** Politique RLS `member_preferences_select_own` : `user_id = auth.uid()` **et** `is_business_member(business_id)`. Une professionnelle ne lit que sa propre ligne : ni celles des autres établissements, ni celles des autres membres de son établissement, propriétaire compris.
- **Écriture.** Aucun `insert`, `update` ou `delete` n'est accordé aux rôles de l'API. Seule `public.save_member_preferences` écrit, en `SECURITY DEFINER`, et seulement pour `auth.uid()`. L'utilisateur n'est **jamais** un paramètre. L'établissement doit être l'un des siens.
- **Établissement.** Les Server Actions résolvent l'établissement depuis la session (`runBusinessAction` → `getBusinessContext`), jamais depuis le navigateur. Même un appel direct à PostgREST avec l'identifiant d'un autre établissement est refusé par la fonction.
- **Rôles sans accès.** `anon` n'a aucun droit. `service_role` n'a pas d'utilisateur, l'écriture lui est donc refusée.
- **Cookies.** Aucune autorisation ne dépend d'un cookie applicatif : l'identité vient de Supabase Auth (`getUser`). Le cache de l'appareil (§ 4) n'est qu'une aide d'affichage.
- **Valeurs.** Toutes sont validées deux fois : par Zod dans l'action (schéma strict, champs inconnus refusés), puis par la base (type JSON de chaque champ, listes fermées). Une valeur relue que ce code ne connaît pas (une migration plus récente) est lue comme la valeur par défaut de ce champ (`fromDatabaseRow`). Elle n'est jamais transmise au CSS.

**Preuves** (`tests/integration/member-preferences.test.ts`, 47 tests, deux comptes et deux établissements, plus un membre `admin` dans l'établissement A) :

- lectures croisées vides ;
- écriture avec l'établissement d'un autre compte : `forbidden`, rien d'écrit ;
- `insert`, `update` et `delete` directs : refusés (`42501`) pour tous, sur toutes les lignes ;
- `anon` et `service_role` : refusés ;
- après déconnexion : rien de lisible, écriture refusée ;
- membre retiré : sa ligne disparaît et ses écritures sont refusées ;
- 16 charges invalides ou d'injection refusées sans rien écrire : champ inconnu, `user_id`, `business_id` ou `version` glissés dans le patch, SQL, CSS, saut de ligne, clé de prototype, majuscules, types JSON incorrects.

## 4. Comportement

### Écriture : `save_member_preferences(p_business_id, p_expected_version, p_changes)`

`p_changes` ne contient que les champs modifiés (`style`, `ambiance`, `color_mode`, `accent`, `motion`). `p_expected_version` est la version que l'appareil a lue (0 s'il n'y a encore rien).

| Situation                                                           | Statut      | Effet                                       |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------- |
| La ligne est à `p_expected_version`                                 | `saved`     | appliqué ; version + 1 (ou 1 à la création) |
| La ligne a déjà ces valeurs (nouvel essai, deux appareils d'accord) | `unchanged` | rien d'écrit, quelle que soit la version    |
| La ligne a changé depuis, avec d'autres valeurs                     | `stale`     | rien d'écrit                                |

La réponse contient toujours l'état actuel du compte. Avec `stale`, l'appareil réapplique donc son changement sur la nouvelle version, sans relecture supplémentaire.

**Garanties testées :**

- 8 appareils écrivent en même temps sur la même version : un seul `saved`, 7 `stale` ;
- trois premières écritures simultanées : une seule ligne créée ;
- la version est tenue par un trigger : une écriture directe ne peut pas la fixer, et elle n'augmente que si une valeur change ;
- le membre et l'établissement d'une ligne ne changent jamais.

### Source de vérité et premier rendu

**La base est la source de vérité.** Le layout de `/app` la lit à chaque rendu avec `loadAreaPreferences` (`src/features/preferences/server/area-preferences.ts`), une lecture par clé primaire. Le premier rendu est donc déjà le sien, sans script ni flash, sur tous ses appareils.

| `source`  | Quand                                  | Ce qui est rendu                                          |
| --------- | -------------------------------------- | --------------------------------------------------------- |
| `account` | la base répond                         | ses préférences (ou les défauts, version 0)               |
| `device`  | la base est momentanément absente      | le cache **de cet appareil pour ce compte** (`dash_pref`) |
| `default` | base absente et pas de cache à son nom | les défauts                                               |

### Les cookies

- **`dash_pref`** (nouveau) :
  - posé par le serveur après chaque lecture ou écriture par action (HttpOnly, `Path=/app`, SameSite=Lax, Secure en production, un an) ;
  - format : `1.<propriétaire>.<version>.<style>.<ambiance>.<mode>.<motion>.<accent|->`, où le propriétaire est le SHA-256 de son identifiant et de celui de l'établissement ;
  - lu strictement : un champ inconnu, ou un autre propriétaire, et tout le cache est ignoré ;
  - il ne sert que si la base est absente.
- **`dash_appearance`** (Studio 1, historique) :
  - n'est jamais appliqué au compte de lui-même ;
  - si son compte n'a encore rien (version 0), `loadAreaPreferences` le renvoie dans `deviceAppearanceOffer` ;
  - l'interface propose alors : « Garder cette apparence sur votre compte ? » ;
  - `importDeviceAppearanceAction` n'écrit que sur la version 0 : dès qu'un compte a des préférences, l'import répond `stale` et n'écrit rien.
  - **Ainsi, un ancien cookie laissé par une autre professionnelle sur l'appareil ne peut jamais écraser les préférences d'un compte.** Un cookie malformé ne propose rien.

### Situations

| Situation                                 | Comportement                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Premier compte, aucune préférence         | défauts, version 0 ; proposition d'import si un ancien cookie valide existe                                            |
| Écrin sur l'ordinateur, puis le téléphone | le téléphone lit Écrin au premier rendu                                                                                |
| Couleur changée sur le téléphone          | l'ordinateur la reçoit au prochain rendu, ou à la synchronisation (focus, § 6)                                         |
| Changement de compte sur l'appareil       | le layout lit le nouveau compte ; le cache de l'autre est ignoré ; l'état client est réinitialisé (`accountChanged`)   |
| Déconnexion puis reconnexion              | mêmes préférences (testé) ; déconnectée, rien n'est lisible                                                            |
| Réponses concurrentes ou en désordre      | la version ne recule jamais côté client (`accountRead`, `saveAnswered`)                                                |
| Écritures répétées                        | `unchanged`, version inchangée ; l'appareil n'envoie rien sans changement                                              |
| Erreur réseau                             | le changement reste en attente et est renvoyé ; un nouvel essai déjà appliqué donne `unchanged`                        |
| Base absente                              | rendu depuis `dash_pref` (son compte) ou les défauts ; les écritures échouent (`internal`) et sont renvoyées plus tard |

## 5. Évolution du schéma

- **Nouveau style ou ambiance :** une migration qui remplace `private.member_preferences_valid` par une liste élargie, et la même liste dans `src/features/preferences/model.ts`. Un test d'intégration vérifie que les deux listes sont identiques.
- **Retirer une valeur :** d'abord une migration de données vers une valeur conservée, puis la liste réduite. Les lignes existantes ne sont pas revalidées par PostgreSQL.
- **Nouvelle préférence personnelle :**
  - une colonne avec un défaut (aucune ligne à réécrire), ajoutée à la liste des champs du patch (`member_preferences_patch_valid`) et à la comparaison du trigger ;
  - les anciens clients ne l'envoient pas, le patch partiel la laisse intacte.
- **Style livré côté base avant son interface :** l'interface affiche Classique sans changer le compte (`renderableAppearance(appearance, stylesLivrés)`).

## 6. Contrat d'intégration pour Claude UI

**Côté serveur (layout `/app`) :**

```ts
const state = await requireReadyBusiness();
const area = await loadAreaPreferences({
  userId: state.user.id,
  businessId: state.business.id,
});
// area.preferences: { appearance, version }
// area.source: "account" | "device" | "default"
// area.deviceAppearanceOffer: Appearance | null
const appearance = renderableAppearance(area.preferences.appearance, [
  "classique",
  "studio",
]);
```

`AppearancePreferences` a exactement la forme de `Appearance` (`style`, `ambiance`, `mode`, `accent`, `motion`). Seuls les styles possibles sont plus nombreux, d'où `renderableAppearance`.

**Actions (`src/features/preferences/actions/preferences.ts`) :**

| Action                                                  | Réponse `data`                                               |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `getMyPreferencesAction()`                              | `{ appearance, version }`                                    |
| `saveMyPreferencesAction({ expectedVersion, changes })` | `{ status: "saved" \| "unchanged" \| "stale", preferences }` |
| `importDeviceAppearanceAction({ appearance })`          | idem ; `stale` si le compte a déjà des préférences           |

Erreurs : `unauthenticated`, `no_business`, `validation_error`, `internal` (base absente ou réseau côté serveur).

**Côté client :**

- Le fournisseur d'apparence pilote la machine d'état pure de `src/features/preferences/client/preference-sync.ts` (testée, y compris 200 entrelacements aléatoires de deux appareils) :
  1. Initialiser avec `initialSyncState(area.preferences)`, puis afficher `displayedAppearance(state)`.
  2. Au choix de la professionnelle : `changeLocally(state, next)` (appliqué tout de suite), puis `nextSave(state)` donne la requête à envoyer, une seule à la fois.
  3. À la réponse : `saveAnswered(state, data)`, puis `nextSave` à nouveau. Avec `stale`, la même intention est renvoyée sur la nouvelle version.
  4. Sans réponse (réseau, `internal`) : `saveFailed(state)`, puis un nouvel essai avec délai croissant.
  5. Au retour sur l'onglet (`visibilitychange`, `focus`) : `getMyPreferencesAction()`, puis `accountRead(state, data)`. Une version plus ancienne est ignorée.
  6. Si le compte ou l'établissement change (nouvelle valeur du layout) : `accountChanged(area.preferences)`.
- Si `deviceAppearanceOffer` est présent, proposer l'import et ne rien importer sans son accord.
- Si `source === "device"`, afficher discrètement que les préférences n'ont pas pu être synchronisées.
- Le cookie `dash_appearance` peut cesser d'être écrit une fois le branchement fait. `dash_pref` est posé par le serveur.

**À noter :** poser un cookie dans une Server Action rafraîchit la route. Le layout relit alors le compte, ce qui reste cohérent avec l'état client, puisque la version ne recule jamais.

## 7. Personnalisation de l'établissement (préparée, non livrée)

Contrat proposé pour une PR ultérieure, distinct des préférences :

- **`public.business_branding`** : une ligne par établissement.
  - Champs : couleurs de marque, typographie, univers du mini-site, références d'images.
  - Version tenue par la base.
  - Lecture par les membres (RLS `is_business_member`) ; écriture par le propriétaire (`has_business_role(owner)`) via une fonction `SECURITY DEFINER` à version attendue, comme les prestations.
  - Lecture publique uniquement par une projection dédiée au mini-site.
- **Fichiers** (logo, photos) dans un bucket Storage privé `business-assets`, chemin `<business_id>/<kind>/<uuid>.<ext>`.
  - Politiques Storage fondées sur l'appartenance, type et taille contrôlés.
  - URL publiques signées ou servies par la projection du mini-site.
- **Images personnelles** de la professionnelle (accueil) : préfixe distinct, `<business_id>/members/<user_id>/…`, lisible par elle seule.

## 8. Limites

- L'interface n'est pas branchée : le moteur d'apparence est dans les PR #28 et #29.
- La synchronisation entre appareils se fait au rendu et au retour sur l'onglet, pas en temps réel (pas de Realtime).
- Les préférences d'affichage autres que l'apparence (widgets, image personnelle) ne sont pas encore modélisées (§ 5 et § 7).
