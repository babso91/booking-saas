# Préférences personnelles des professionnelles — contrat livré

Ce document décrit le socle backend qui garde les préférences d'apparence de chaque professionnelle sur son compte, et son branchement au moteur d'apparence (`src/features/appearance`). Le contrat est au § 6, ce qui a été branché au § 6 bis.

- **Migration :** `supabase/migrations/20261031090000_member_preferences.sql`.
- **Code :** `src/features/preferences/`.
- **Tests :**
  - `tests/integration/member-preferences.test.ts` (PostgreSQL et PostgREST réels, sessions Supabase Auth réelles) ;
  - `tests/integration/member-preferences-actions.test.ts` (Server Actions et chargeur du layout avec une vraie session, pilotant la machine d'état) ;
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

| Colonne                    | Type                                     | Valeurs                                                                                          | Défaut      |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| `business_id`, `user_id`   | uuid                                     | clé primaire ; clé étrangère vers `business_members (business_id, user_id)`, `on delete cascade` | —           |
| `incarnation`              | uuid                                     | identité de la ligne, tirée au hasard à sa création, fixe ensuite (trigger)                      | —           |
| `style`                    | domaine `member_preference_style`        | `classique`, `studio`, `ecrin`, `carnet`                                                         | `classique` |
| `ambiance`                 | domaine `member_preference_ambiance`     | `atelier`, `lin`, `sauge`                                                                        | `atelier`   |
| `color_mode`               | domaine `member_preference_color_mode`   | `light`, `dark`, `system`                                                                        | `light`     |
| `accent`                   | domaine `member_preference_accent`, null | `#RRGGBB` en majuscules, ou `null` (couleur du style)                                            | `null`      |
| `motion`                   | domaine `member_preference_motion`       | `standard`, `discrete`, `none`                                                                   | `standard`  |
| `version`                  | bigint ≥ 1                               | tenue par la base, + 1 par changement réel                                                       | 1           |
| `created_at`, `updated_at` | timestamptz                              | tenues par la base                                                                               | —           |

**Pourquoi ce schéma :**

- **Par appartenance, pas par utilisateur.**
  - Une professionnelle dans deux établissements a deux lignes indépendantes.
  - Quand elle quitte un établissement, sa ligne disparaît avec son appartenance : aucune préférence orpheline, aucune trace dans un établissement où elle n'est plus.
- **Des colonnes typées, pas un document JSON libre.** Chaque valeur est contrôlée par la base. Les styles partagent les mêmes champs : ajouter un style ne crée ni table ni colonne.
- **Une seule liste de valeurs par champ : un domaine PostgreSQL.**
  - Il sert à la fois aux colonnes et à la fonction d'écriture.
  - Il s'applique à tous les chemins d'écriture et à tous les rôles, `service_role` compris, sans dépendre d'une fonction d'un autre schéma.
- **Aucune ligne = valeurs par défaut, sans incarnation, version 0.** Aucune ligne n'est créée à l'inscription ni par la migration.

### Trois identités, à ne pas confondre

| Identité        | Ce que c'est                                      | Change quand                                                                                                |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Contexte**    | son appartenance : `business_members.id`          | elle change de compte ou d'établissement, ou quitte l'établissement puis le rejoint (nouvelle appartenance) |
| **Incarnation** | la ligne de préférences : `incarnation`           | la ligne est supprimée puis recréée (nouvelle appartenance, ou administrateur)                              |
| **Version**     | le nombre de changements **dans** une incarnation | à chaque changement réel ; repart à 1 dans une nouvelle incarnation                                         |

**Une version n'est comparable qu'à l'intérieur d'une incarnation.**

- L'état « aucune ligne » n'a pas d'incarnation (`null`, version 0).
- **Coût :**
  - une colonne uuid (16 octets par ligne) ;
  - une ligne dans le trigger ;
  - un paramètre de plus pour l'écriture.
- **Pourquoi :** sans elle, une ligne recréée (version 1, 2…) ne se distingue pas d'un ancien état de la ligne précédente. C'est le défaut IMPORTANT n° 2 de l'audit.

**Compte ou établissement inexistant :**

- sans appartenance, aucune ligne ne peut exister (clé étrangère) ;
- une lecture ou une écriture pour un établissement qui n'est pas le sien, ou qui n'existe pas, est refusée (`forbidden`) ;
- sans session, les deux fonctions refusent (`unauthenticated`) et la lecture directe ne renvoie rien.

## 3. Sécurité multi-tenant

- **Lecture.**
  - `public.read_member_preferences(business)` (`SECURITY DEFINER`, pour `auth.uid()` seulement) renvoie son appartenance et sa ligne, ou les défauts.
  - La politique RLS `member_preferences_select_own` (`user_id = auth.uid()` **et** `is_business_member(business_id)`) limite aussi la lecture directe à sa propre ligne : ni celles des autres établissements, ni celles des autres membres de son établissement, propriétaire compris.
- **Écriture.**
  - Aucun `insert`, `update` ou `delete` n'est accordé à `anon` ni à `authenticated`.
  - Seule `public.save_member_preferences` écrit, pour `auth.uid()` seulement : l'utilisateur n'est **jamais** un paramètre.
  - L'établissement doit être l'un des siens, et l'appartenance nommée doit être la sienne actuelle (sinon `context_changed`).
- **Établissement.**
  - Les Server Actions résolvent l'établissement depuis la session (`runBusinessAction` → `getBusinessContext`), jamais depuis le navigateur.
  - Si la page indique un autre établissement que celui de la session : `context_changed`, rien d'écrit.
  - Même un appel direct à PostgREST avec l'identifiant d'un autre établissement est refusé par les fonctions.
- **Rôles.**

  | Rôle            | Droits effectifs sur `member_preferences` (vérifiés par les tests)                                                                                                                                                                                                                                                                                                                 |
  | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `anon`          | aucun : ni table, ni fonction                                                                                                                                                                                                                                                                                                                                                      |
  | `authenticated` | `SELECT` seul, limité par la RLS à sa propre ligne ; les deux fonctions, pour elle-même                                                                                                                                                                                                                                                                                            |
  | `service_role`  | **les droits d'administration que Supabase lui donne : tous les privilèges sur la table, et la RLS contournée (`BYPASSRLS`).** Il lit et écrit directement toutes les lignes. Ses écritures restent soumises aux domaines, au trigger (version et incarnation) et à la clé étrangère. Les fonctions le refusent, car elles agissent pour un utilisateur connecté et il n'en a pas. |

  **L'application n'utilise jamais `service_role` pour les préférences**, et ces droits ne lui sont pas retirés : ils servent à l'administration (support, futur import encadré). Toute utilisation de cette clé côté serveur reste une décision explicite.

- **Cookies.** Aucune autorisation ne dépend d'un cookie applicatif : l'identité vient de Supabase Auth (`getUser`). Le cache de l'appareil (§ 4) n'est qu'une aide d'affichage.
- **Valeurs.**
  - Toutes sont validées deux fois : par Zod dans l'action (schéma strict, champs inconnus refusés), puis par la base (type JSON de chaque champ, domaines).
  - Une valeur relue que ce code ne connaît pas (une migration plus récente) est lue comme la valeur par défaut de ce champ (`fromDatabaseRow`). Elle n'est jamais transmise au CSS.

**Preuves** (`tests/integration/member-preferences.test.ts`, 54 tests ; deux comptes et deux établissements, plus un membre `admin` dans l'établissement A) :

- lectures croisées vides, par la table comme par la fonction ;
- établissement d'un autre compte : `forbidden`, rien d'écrit ;
- appartenance qui n'est plus la sienne : `context_changed`, rien d'écrit ;
- `insert`, `update` et `delete` directs refusés (`42501`) pour `authenticated`, sur toutes les lignes ;
- `anon` refusé partout ;
- privilèges réels de `service_role` relevés dans le catalogue, puis exercés : lecture de toutes les lignes, écriture directe soumise aux règles de la table, refus des fonctions ;
- après déconnexion : rien de lisible, écriture refusée ;
- membre retiré : sa ligne disparaît, ses écritures sont refusées ;
- trois cycles départ-retour, avec les garanties de l'incarnation ;
- 16 charges invalides ou d'injection refusées sans rien écrire.

## 4. Comportement

### Écriture : `save_member_preferences(p_business_id, p_membership_id, p_expected_incarnation, p_expected_version, p_changes)`

- `p_changes` ne contient que les champs modifiés (`style`, `ambiance`, `color_mode`, `accent`, `motion`).
- `(p_expected_incarnation, p_expected_version)` est l'état que l'appareil a lu : `(null, 0)` s'il n'y a pas de ligne.
- `p_membership_id` est le contexte de la page.

| Situation                                                                 | Statut / erreur   | Effet                                                                 |
| ------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| L'appartenance n'est plus celle de la page                                | `context_changed` | rien d'écrit                                                          |
| La ligne a déjà ces valeurs (nouvel essai, deux appareils d'accord)       | `unchanged`       | rien d'écrit, quel que soit l'état lu                                 |
| La ligne est exactement l'état lu (même incarnation, même version)        | `saved`           | appliqué ; version + 1, ou création (nouvelle incarnation, version 1) |
| Autre version, autre incarnation, ou plus de ligne, avec d'autres valeurs | `stale`           | rien d'écrit                                                          |

La réponse contient toujours le contexte et l'état actuel du compte. Avec `stale`, l'appareil réapplique donc son changement sur cet état, sans relecture supplémentaire.

**Garanties testées :**

- 8 appareils écrivent en même temps sur la même version : un seul `saved`, 7 `stale` ;
- trois premières écritures simultanées : une seule ligne créée ;
- le trigger tient la version et l'incarnation : une écriture directe ne peut fixer ni l'une ni l'autre ;
- le membre et l'établissement d'une ligne ne changent jamais ;
- ligne supprimée puis recréée : l'ancienne incarnation est `stale`, même à un numéro de version égal à celui de la nouvelle ligne.

### Source de vérité et premier rendu

**La base est la source de vérité.** Le layout de `/app` la lit à chaque rendu avec `loadAreaPreferences()` (`src/features/preferences/server/area-preferences.ts`), en un appel. Le premier rendu est donc déjà le sien, sans script ni flash, sur tous ses appareils.

**L'identité de la page vient de la session, pas des préférences.** `loadAreaPreferences()` ne prend aucun argument. Elle part de l'état de session de la requête (`currentSessionState()`, celui que la garde vient d'utiliser : Auth, puis son appartenance lue sous RLS) et renvoie `identity`, que la lecture des préférences réussisse ou non. Le `snapshot` n'est rendu que s'il est pour exactement cette identité.

| `identity.status` | `source`  | Quand                                                                                                                                                | `snapshot`                 | Ce qui est rendu                                                   |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `confirmed`       | `account` | session prête, préférences lues pour cette appartenance                                                                                              | contexte + préférences     | ses préférences (ou les défauts, version 0)                        |
| `confirmed`       | `device`  | session prête, lecture des préférences en échec                                                                                                      | `null` (aucune sauvegarde) | le cache **de cet appareil pour cette appartenance** (`dash_pref`) |
| `confirmed`       | `default` | session prête, lecture en échec, pas de cache pour cette appartenance                                                                                | `null`                     | les défauts                                                        |
| `unconfirmed`     | `default` | session absente, sans établissement, Auth injoignable, appartenance illisible, ou appartenance changée ou quittée pendant le rendu (lecture refusée) | `null`                     | les défauts ; **jamais** de cache ni de contexte                   |

Garanties sur `identity.context` (`{ userId, businessId, membershipId }`) :

- `userId` : l'utilisateur validé par Auth (`getUser`), pas le cookie seul ;
- `businessId` et `membershipId` : sa ligne `business_members` (la plus ancienne, comme partout en V1), lue sous RLS. `membershipId` est l'`id` de cette ligne. Départ puis retour donnent une nouvelle ligne, donc un nouveau `membershipId`.
- Si les préférences lues répondent pour une autre appartenance que celle de la session (elle est partie et revenue entre les deux lectures), ou si la lecture est refusée (`forbidden` : elle est partie), rien n'est garanti : `unconfirmed` / `membership_changed`, sans snapshot ni cache.
- Le cache appareil n'est utilisé que si son appartenance est celle de la session : le cache d'une appartenance précédente (même compte, même établissement) n'est jamais montré.

### Les cookies

- **`dash_pref`** (nouveau) :
  - posé par le serveur après chaque lecture ou écriture par action, et seulement si sa valeur change (HttpOnly, `Path=/app`, SameSite=Lax, Secure en production, un an) ;
  - format : `2.<propriétaire>.<appartenance>.<incarnation|->.<version>.<style>.<ambiance>.<mode>.<motion>.<accent|->`, où le propriétaire est le SHA-256 de son identifiant et de celui de l'établissement ;
  - lu strictement : un champ inconnu, une incohérence (incarnation et version), un autre propriétaire ou un autre format, et tout le cache est ignoré ;
  - il ne sert qu'à l'affichage, quand la lecture des préférences échoue, et seulement pour l'appartenance de la session (`membershipId`).
- **`dash_appearance`** (Studio 1, historique) :
  - n'est jamais appliqué au compte de lui-même ;
  - si son compte n'a encore rien (version 0), `loadAreaPreferences` le renvoie dans `deviceAppearanceOffer` ;
  - l'interface propose alors : « Garder cette apparence sur ton compte ? » ;
  - `importDeviceAppearanceAction` n'écrit que s'il n'y a pas de ligne, pour le contexte de la page : dès qu'un compte a des préférences, l'import répond `stale` et n'écrit rien.
  - **Ainsi, un ancien cookie laissé par une autre professionnelle sur l'appareil ne peut jamais écraser les préférences d'un compte.** Un cookie malformé ne propose rien.

### Situations

| Situation                                 | Comportement                                                                                                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Premier compte, aucune préférence         | défauts, version 0 ; proposition d'import si un ancien cookie valide existe                                                                                                                                                       |
| Écrin sur l'ordinateur, puis le téléphone | le téléphone lit Écrin au premier rendu                                                                                                                                                                                           |
| Couleur changée sur le téléphone          | l'ordinateur la reçoit au prochain rendu, ou à la synchronisation (focus, § 6)                                                                                                                                                    |
| Changement de compte ou d'établissement   | nouveau contexte, nouvelle génération (`enterContext`) ; toute réponse de l'ancien est ignorée ; une requête de l'ancien exécutée sous la nouvelle session est refusée (`context_changed`)                                        |
| Départ puis retour dans l'établissement   | nouvelle appartenance, donc nouveau contexte ; la page restée ouverte n'écrit rien ; le nouveau rendu repart de la version 0, sans blocage                                                                                        |
| Déconnexion puis reconnexion              | nouvelle génération, mêmes préférences ; déconnectée, rien n'est lisible ni écrit                                                                                                                                                 |
| Réponses concurrentes ou en désordre      | un état plus ancien ne remplace jamais un plus récent (§ 6) ; une lecture, même périmée, n'efface jamais un choix non acquitté                                                                                                    |
| Écritures répétées                        | `unchanged`, version inchangée ; l'appareil n'envoie rien sans changement                                                                                                                                                         |
| Erreur réseau                             | le changement reste en attente et est renvoyé ; un nouvel essai déjà appliqué donne `unchanged`                                                                                                                                   |
| Lecture des préférences en échec          | identité confirmée par la session ; rendu depuis `dash_pref` (cette appartenance) ou les défauts ; rien n'est envoyé avant une lecture pour cette identité                                                                        |
| Base absente                              | la session ne peut pas être établie : la garde de `/app` échoue avant le rendu ; les actions répondent `internal` ou `auth_unavailable`, la synchronisation se met en pause et reprend dès qu'une lecture répond pour ce contexte |

## 5. Évolution du schéma

- **Nouveau style ou ambiance :**
  - une migration qui élargit la contrainte du domaine (`alter domain … drop constraint / add constraint`) ;
  - la même liste dans `src/features/preferences/model.ts` ;
  - un test d'intégration vérifie que les deux listes sont identiques.
- **Retirer une valeur :** d'abord une migration de données vers une valeur conservée, puis la liste réduite (`alter domain … add constraint` revalide les lignes existantes).
- **Nouvelle préférence personnelle :**
  - une colonne avec un défaut (aucune ligne à réécrire), ajoutée à la liste des champs du patch (`member_preferences_patch_valid`), à la comparaison du trigger et aux deux fonctions ;
  - les anciens clients ne l'envoient pas, et le patch partiel la laisse intacte.
- **Style livré côté base avant son interface :** l'interface affiche Classique sans changer le compte (`renderableAppearance(appearance, stylesLivrés)`).

## 6. Contrat d'intégration pour Claude UI

**Côté serveur (layout `/app`) :**

```ts
await requireReadyBusiness();
const area = await loadAreaPreferences(); // aucun argument : la session de la requête
// area.identity:
//   { status: "confirmed", context: { userId, businessId, membershipId } }
//   { status: "unconfirmed", reason: "unauthenticated" | "onboarding_required"
//       | "auth_unavailable" | "session_unreadable" | "membership_changed" }
// area.snapshot: { context, preferences } | null
//   (jamais présent sans identité confirmée ; s'il est présent,
//    sameContext(area.snapshot.context, area.identity.context) est vrai)
// area.appearance: ce qu'il faut rendre maintenant
// area.source: "account" | "device" | "default" ("default" si unconfirmed)
// area.deviceAppearanceOffer: Appearance | null (null si pas de snapshot)
const appearance = renderableAppearance(area.appearance, [
  "classique",
  "studio",
]);
```

Le type est une union discriminée sur `identity.status` : avec `unconfirmed`, TypeScript sait que `snapshot` est `null` et `source` vaut `"default"`.

`AppearancePreferences` a exactement la forme de `Appearance` (`style`, `ambiance`, `mode`, `accent`, `motion`). Seuls les styles possibles sont plus nombreux, d'où `renderableAppearance`.

**Actions (`src/features/preferences/actions/preferences.ts`) :**

| Action                                                    | Réponse `data`                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `getMyPreferencesAction()`                                | `{ context, preferences }`, pour la session au moment de la requête   |
| `saveMyPreferencesAction({ context, expected, changes })` | `{ status: "saved" \| "unchanged" \| "stale", context, preferences }` |
| `importDeviceAppearanceAction({ context, appearance })`   | idem ; `stale` si le compte a déjà des préférences                    |

- `context` vaut `{ businessId, membershipId }`, ceux du `snapshot` de la page.
- `expected` vaut `{ incarnation, version }`, que la machine d'état fournit.
- Erreurs :
  - `context_changed` : la session n'est plus ce contexte, rien d'écrit ;
  - `unauthenticated` (pas de session valide), `no_business`, `validation_error` ;
  - `auth_unavailable` : Supabase Auth ne répond pas, la session n'a pas pu être vérifiée (ce n'est **pas** une déconnexion ; rien n'est écrit) ;
  - `internal` : base absente ou réseau côté serveur.

**Côté client : état observé et intentions.** Le fournisseur d'apparence pilote la machine d'état pure de `src/features/preferences/client/preference-sync.ts`. Elle sépare strictement deux choses, qui ne se déduisent jamais l'une de l'autre :

| Champ de `SyncState`         | Ce que c'est                                                                                              | Qui le change                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `observed` (+ `observedSeq`) | le dernier état du compte vu ici (lecture ou réponse de sauvegarde)                                       | `readAnswered`, `saveAnswered`, seulement s'il est plus récent                                                                        |
| `intents`                    | ses choix, champ par champ, chacun avec une **révision**, tant que le compte ne les a pas acquittés       | `changeLocally` (ajoute ou remplace) ; `saveAnswered` `saved`/`unchanged` (retire **les révisions envoyées**) ; `enterContext` (vide) |
| `inFlight`                   | la sauvegarde en cours : la requête et les révisions qu'elle transporte                                   | `nextSave`, puis sa réponse ou son échec                                                                                              |
| `paused`, `staleStreak`      | pause (`context_changed`, `conflict`) et compteur de `stale`                                              | réponses, échecs, lectures du même contexte                                                                                           |
| `readAfter`                  | barrière : une lecture de réconciliation est due (l'appareil tient une réponse qu'il n'a pas pu ordonner) | avancée à chaque nouvelle ambiguïté ; levée seulement par une lecture **envoyée après** la dernière                                   |
| `readsInFlight`              | les lectures envoyées et pas encore réglées (numéros de requête)                                          | `startRead` (ajoute) ; `readAnswered`, `readFailed` (retirent)                                                                        |

Ce qu'elle affiche : `displayedAppearance(state)`, soit `observed` plus les `intents`.

**Ce qui constitue une confirmation fiable.** Seule la réponse `saved` ou `unchanged` **à la sauvegarde qui a transporté une intention** (même ticket, même révision) l'acquitte et la retire.

- **Jamais une lecture**, même si l'état lu contient la même valeur : un état lu peut être périmé, et l'égalité d'une valeur n'acquitte rien. C'est le défaut corrigé suite au contre-audit Codex.
- **Jamais `stale`, ni un échec réseau** : les intentions restent, et repartent sur l'état reçu.
- **Une intention modifiée après l'envoi** (révision plus récente) reste, même si l'ancienne révision est acquittée.

**Isolation des contextes.** Chaque réponse est confrontée à trois choses, et ignorée **entièrement** (données, acquittement, échec) si l'une ne correspond pas :

1. **La génération.** C'est un numéro que l'appareil donne à chaque contexte où il entre. Changement de compte, d'établissement, nouvelle connexion ou retour après un départ : nouvelle génération. Les réponses à des requêtes d'une génération précédente sont abandonnées, quelle que soit leur version.
2. **Le contexte pour lequel le serveur a répondu** (son appartenance). Une réponse pour un autre contexte signifie que la session a changé sous la page : rien n'en est pris, les intentions restent, et la sauvegarde se met en pause.
3. **La requête (ticket).** La réponse ou l'échec d'une sauvegarde ne concerne que celle-ci, jamais une plus récente.

**Fraîcheur de l'état observé, dans un contexte :**

- dans une même incarnation, la version la plus haute l'emporte ;
- entre incarnations différentes (ou sans ligne), c'est la réponse à la requête envoyée en dernier ;
- une réponse différente que l'appareil ne peut pas ordonner pose `readAfter` : faire une lecture.

Dans les deux cas, cela ne change que ce qui est affiché pour les champs sans intention, jamais les intentions.

**Étapes :**

1. À chaque rendu du layout, partir de `area.identity`, **jamais** du contexte d'un état précédent, d'un snapshot précédent ou d'un cookie (tableau « Rendu du layout » ci-dessous). Afficher `displayedAppearance(state)` quand il y a un état, sinon `area.appearance`.
2. Au choix de la professionnelle : `changeLocally(state, next)` (appliqué tout de suite ; chaque champ qui diffère de ce qu'elle voit devient une intention), puis `nextSave(state)` donne la requête à envoyer, une seule à la fois, avec son ticket. Elle transporte toutes les intentions.
3. À la réponse : `saveAnswered(state, request.ticket, data)`, puis `nextSave` à nouveau. Les intentions plus récentes, ou non acquittées (`stale`), repartent.
4. En cas d'erreur :
   - `context_changed`, `unauthenticated`, `forbidden` ou `no_business` : `saveFailed(state, ticket, "context_changed")`. La sauvegarde est en pause et les intentions conservées. Recharger la page (`router.refresh()`) : le layout donnera le contexte.
   - `auth_unavailable` : comme une erreur réseau, `saveFailed(state, ticket, "network")` puis un nouvel essai avec backoff. Ce n'est pas une sortie de contexte : les intentions restent, non acquittées, et ne doivent jamais être annoncées comme enregistrées.
   - Toute autre erreur, ou pas de réponse : `saveFailed(state, ticket, "network")`, puis un nouvel essai avec délai croissant.
5. Lectures :
   - quand faire une lecture : au retour sur l'onglet (`visibilitychange`, `focus`), après une pause, et **dès que `readNeeded(state)` est vrai** (réconciliation, sans attendre un focus) ;
   - comment : `startRead(state)`, puis `getMyPreferencesAction()`, puis `readAnswered(state, ticket, data)` si elle répond, ou `readFailed(state, ticket)` si elle échoue (réseau, `internal`, toute erreur) ;
   - une lecture répondue pour ce même contexte lève la pause, et les intentions repartent.
6. Après `STALE_LIMIT` (5) réponses `stale` consécutives, la sauvegarde se met en pause (`paused: "conflict"`) jusqu'à la lecture suivante : jamais de boucle infinie.
7. `unacknowledgedChanges(state)` donne ses choix pas encore acquittés : pour afficher « enregistrement… », ou avertir avant de quitter la page.

**Rendu du layout : ce que fait le pilote.** `state` est l'état de synchronisation courant (ou `null`) ; `generation` est le dernier numéro de génération utilisé par la page, gardé même quand `state` est `null` :

| `area`                        | `state` courant                      | Action du pilote                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed` + `snapshot`      | `null`                               | `initialSyncState(area.snapshot, generation + 1)`                                                                                                                                                                                                                                                                                                                                           |
| `confirmed` + `snapshot`      | même contexte (`sameContext`)        | garder `state` (rafraîchissement : le nouvel état passe par `readAnswered` ou les réponses de sauvegarde)                                                                                                                                                                                                                                                                                   |
| `confirmed` + `snapshot`      | autre contexte                       | `enterContext(state, area.snapshot)`                                                                                                                                                                                                                                                                                                                                                        |
| `confirmed`, `snapshot: null` | même contexte que `identity.context` | garder `state` et ses intentions : c'est la même appartenance, seule la lecture a échoué. Lire (étape 5) avec backoff                                                                                                                                                                                                                                                                       |
| `confirmed`, `snapshot: null` | `null` ou autre contexte             | **abandonner** `state` (comme `enterContext` : les intentions de l'ancien contexte ne sont jamais envoyées) ; `state = null` ; afficher `area.appearance` ; ne rien envoyer ; lancer `getMyPreferencesAction()` avec backoff et n'accepter que la réponse dont `context` égale `identity.context` : alors `state = initialSyncState(data, generation + 1)`. Toute autre réponse est ignorée |
| `unconfirmed`                 | quelconque                           | **abandonner** `state` ; `state = null` ; afficher `area.appearance` (les défauts) ; aucune sauvegarde, aucune lecture, aucun contexte repris d'un état ou d'un snapshot précédent. Redemander un rendu plus tard (`router.refresh()` avec backoff, ou au retour sur l'onglet)                                                                                                              |

Pendant que `state` est `null`, toute réponse d'une requête envoyée sous une identité antérieure est ignorée : le pilote note l'identité au moment de l'envoi et la compare à celle de la page à la réponse.

**Lectures de réconciliation : ce que la machine garantit, ce que le pilote doit faire.**

La machine pure garantit :

- **Barrière qui avance.** Chaque réponse que l'appareil ne peut pas ordonner place `readAfter` au numéro de la **prochaine** requête. Seule une lecture envoyée après la dernière ambiguïté peut la lever : jamais une lecture déjà en route, qui a pu être servie avant, ni une lecture d'une autre génération.
- **Déduplication décidable.** `readNeeded(state)` est vrai seulement si une barrière est posée **et** qu'aucune lecture en vol n'a été envoyée assez tard pour la lever. Tant qu'une telle lecture est en route, il est faux.
- **Règlement des lectures.** `readAnswered` et `readFailed` retirent la lecture de `readsInFlight`, pour cette génération uniquement : une réponse ou un échec de l'ancien contexte ne règle jamais une lecture du nouveau, même à numéro égal. Après un échec, `readNeeded` redevient vrai : pas de blocage.
- **Pas de boucle sur un compte stable.** Une lecture qui renvoie l'état observé ne pose aucune barrière (testé : au plus une lecture de réconciliation par ambiguïté).
- **Intentions intactes.** Lectures, barrières et échecs ne touchent jamais `intents`.

Le futur pilote React doit :

1. **Dédupliquer** : ne lancer une lecture de réconciliation que si `readNeeded(state)` est vrai, après chaque transition (réponse, échec, rendu). Ne pas compter lui-même les lectures en vol : la machine le fait.
2. **Suivre chaque lecture par son ticket** : garder le ticket rendu par `startRead`, et appeler exactement une fois `readAnswered(state, ticket, data)` ou `readFailed(state, ticket)` quand la promesse se règle, même si l'état a changé entre-temps (la machine ignore ce qui ne la concerne plus). Ne jamais réutiliser un ticket, ni appeler `readAnswered` pour une lecture dont la réponse n'est pas celle de ce ticket.
3. **Appliquer un backoff** : après `readFailed` ou `saveFailed(…, "network")`, attendre avant le nouvel essai (par exemple 1 s, 2 s, 4 s… plafonné à 30 s, remis à zéro au premier succès). N'abandonner aucune intention : elles restent dans l'état tant qu'elles ne sont pas acquittées.
4. **Rester dans son contexte** : au changement de contexte (`enterContext`), oublier les minuteries et promesses de l'ancien. Leurs réponses arrivées plus tard sont de toute façon ignorées.

Événements à brancher : premier rendu et rendus du layout (`initialSyncState` ou `enterContext`) ; choix de la professionnelle (`changeLocally`, puis `nextSave`) ; règlement de chaque sauvegarde (`saveAnswered`, `saveFailed`) ; règlement de chaque lecture (`readAnswered`, `readFailed`) ; `visibilitychange` et `focus` (lecture) ; minuterie de backoff ; et, après chacun, `nextSave` et `readNeeded`.

- Si `deviceAppearanceOffer` est présent, proposer l'import et ne rien importer sans son accord.
- Si `source === "device"`, afficher discrètement que les préférences n'ont pas pu être synchronisées.
- Le cookie `dash_appearance` peut cesser d'être écrit une fois le branchement fait. `dash_pref` est posé par le serveur.

**Deux comportements à ne pas confondre :**

- **Sortie de contexte** (`enterContext` : autre compte, autre établissement, nouvelle connexion, retour après un départ) : les intentions non acquittées de l'ancien contexte sont **abandonnées volontairement**. Elles appartenaient à l'autre compte, et ne sont jamais envoyées au nouveau. L'interface peut prévenir avant si `unacknowledgedChanges` n'est pas vide.
- **Même contexte** : aucune lecture, périmée ou non, aucune réponse tardive, aucun `stale`, aucun échec ne fait disparaître une intention. Seul son acquittement le fait.

**Migration depuis le contrat précédent (`0d29cd4`) :**

| Avant                                     | Maintenant                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `state.confirmed`                         | `state.observed` : un état observé, plus une « confirmation »                                                                          |
| `state.confirmedSeq`                      | `state.observedSeq`                                                                                                                    |
| `state.pending` (écart avec l'état connu) | `state.intents` (choix avec révisions) ; lire les valeurs avec `unacknowledgedChanges(state)`                                          |
| `state.inFlight` (la requête)             | `state.inFlight.request` (et `state.inFlight.revs`)                                                                                    |
| —                                         | `state.readAfter`, `state.readsInFlight` ; lancer une lecture quand `readNeeded(state)` est vrai ; régler les échecs avec `readFailed` |

Les fonctions et leurs signatures sont inchangées : `initialSyncState`, `enterContext`, `displayedAppearance`, `changeLocally`, `nextSave`, `startRead`, `saveAnswered`, `saveFailed`, `readAnswered`. `unacknowledgedChanges`, `readNeeded` et `readFailed` sont nouvelles.

**À noter :** poser un cookie dans une Server Action rafraîchit la route. Le layout relit alors le compte. Si le contexte n'a pas changé, ne pas appeler `enterContext` : le nouvel état passe par `readAnswered` ou les réponses de sauvegarde.

**Migration depuis `5df33d3` (identité de la page) :**

| Avant                                                               | Maintenant                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `loadAreaPreferences({ userId, businessId })`                       | `loadAreaPreferences()` : l'identité vient de la session de la requête                                         |
| contexte de la page = `area.snapshot?.context`                      | contexte de la page = `area.identity.context` (si `confirmed`) ; `area.snapshot.context` lui est toujours égal |
| `snapshot: null` sans dire pour qui                                 | `identity` toujours présente ; `unconfirmed` quand elle ne peut pas être garantie                              |
| cache `dash_pref` de l'appareil pour ce compte et cet établissement | et pour cette appartenance seulement                                                                           |
| `state.business` de la session sans appartenance                    | `state.business.membershipId`                                                                                  |

## 6 bis. Branchement livré

- **Pilote :** `src/features/preferences/client/preference-driver.ts`, sans React. Il envoie ce que la machine demande : un règlement par requête, délai maximal de 15 s, attente de 1 s à 30 s après un échec. Il ne décide de rien d'autre.
- **Fournisseur :** `AccountAppearanceProvider`, dans le layout de `/app`. `AppearanceProvider` reste pour les aperçus : rien n'y est conservé.
- **Contexte envoyé :** `{ businessId, membershipId }` seulement. Le schéma strict des actions refuse `userId`, que porte `PreferenceContext`.
- **Styles livrés :** `DELIVERED_STYLES` (`classique`, `studio`, `ecrin`, `carnet`). En Carnet, `ambiance` désigne le papier (Sienne, Encre bleue, Olive) : même valeur stockée, sans migration.
- **Ancien cookie :** `dash_appearance` n'est plus écrit. La proposition d'import s'affiche sur toutes les pages de `/app` : sinon, une professionnelle revenue à Classique sans explication n'irait jamais la chercher. Accepter ou refuser efface le cookie de cet appareil.
- **Accepter l'ancien cookie :** l'action d'import, puis une lecture envoyée après elle. Passer par `changeLocally` réécrirait le choix par-dessus un compte qui en a déjà un.
- **Lecture refusée :** elle ne déclenche pas `router.refresh()` quand un état existe : base absente, la garde du layout échoue, et la page où elle se trouve serait perdue.
- **Sauvegarde refusée :** `context_changed`, `forbidden` et `no_business` rafraîchissent, comme le demande le § 6 : le serveur a pu lire la session. `unauthenticated` met en pause sans rafraîchir, ce qui s'écarte du § 6 : ce code dit maintenant que sa session est finie (une panne d'Auth répond `auth_unavailable`, traité comme une erreur réseau), et la garde l'enverrait à la connexion en emportant un choix pas encore enregistré. La carte propose « Réessayer » et « Me reconnecter » : c'est elle qui décide de partir.
- **Identité de la page :** le pilote suit le tableau « Rendu du layout » avec `area.identity`. Tant que `state` est `null`, le statut est `unavailable` : contrôles désactivés, explication dans les réglages, rien d'envoyé. `confirmed` : lecture avec attente croissante. `unconfirmed` : aucune lecture, `router.refresh()` avec la même attente. Une réponse d'une identité antérieure ne peut plus agir : tout changement d'identité abandonne les requêtes en cours.
- **Style reçu d'ailleurs :** il attend (`receivedStyle`) qu'elle le demande ou change de page, car chaque style a son propre cadre et le dessiner remonte la page. Son propre choix, un autre contexte et l'import qu'elle accepte s'appliquent tout de suite. Les autres réglages sont des couleurs, et suivent en direct. « Aujourd'hui » l'applique tout de suite : le serveur y choisit le cadre et on ne peut rien y saisir.

**Comportement de Next.js à connaître.**

- Les Server Actions passent une à la fois : une sauvegarde attend la lecture en cours, et l'inverse.
- Une navigation abandonne l'action en cours, et sa promesse ne se règle jamais (`app-router-instance.js`). Le délai maximal n'est donc pas une précaution : la sauvegarde repart après 15 s, et répond `unchanged` ou `stale` si elle avait déjà abouti.
- Le délai ne retire pas une action de la file de Next.js : une lecture bloquée retient ce qui suit, jusqu'à ce que sa requête se termine. Les envois répétés restent limités par l'attente entre deux essais, et chaque sauvegarde porte la version attendue : passée en retard, elle répond `stale` sans rien écrire.

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

- **Panne du service d'authentification :** `proxy.ts`, `getSessionState` et `getBusinessContext` traitent toute erreur de lecture de la session comme une absence de session. L'interface ne repart plus seule vers la connexion, mais une navigation pendant la panne y mène encore. La distinction est à faire côté serveur ; un nouveau code d'erreur serait traité par le pilote comme une panne, sans autre changement.
- **Base absente au rendu :** les réglages s'affichent désactivés jusqu'à une lecture réussie. Aucun choix n'est gardé en attente, faute de contexte à qui l'envoyer.
- La synchronisation entre appareils se fait au rendu et au retour sur l'onglet, pas en temps réel (pas de Realtime).
- **Fraîcheur entre incarnations :** l'ordre est celui d'envoi des requêtes, pas celui de leur traitement par le serveur.
  - Une lecture envoyée plus tard mais servie plus tôt peut montrer brièvement un état plus ancien **pour les champs sans intention**.
  - Les intentions ne sont jamais touchées.
  - La lecture de réconciliation (`readNeeded`), ou la prochaine sauvegarde, corrige l'affichage (testé : jamais de blocage, au plus une lecture par ambiguïté).
- **Intentions égales à l'état du compte :** elles sont envoyées quand même, et acquittées par `unchanged`. Cela coûte un aller-retour, et c'est voulu : l'égalité avec un état observé n'est pas une preuve.
- **Indisponibilité de Supabase Auth :** la session ne peut pas être vérifiée ; l'action répond `auth_unavailable` (distinct de `unauthenticated`, voir `src/lib/supabase/auth-errors.ts`). Le pilote réessaie avec backoff, sans rien perdre ni rien annoncer comme enregistré. Les pages privées affichent `/indisponible` au lieu de renvoyer vers `/login`, et aucun cookie de session n'est supprimé. Cela vaut aussi dans les Server Actions, y compris quand Auth renvoie une réponse illisible pendant le refresh d'un jeton expiré (`docs/AUTH_ONBOARDING_CONTRACT.md`).
- **Identité et contexte du snapshot :** l'identité vient de deux lectures (session, puis préférences), pas d'une transaction. Un départ, avec ou sans retour, entre les deux est détecté (`membership_changed` : autre appartenance lue, ou lecture refusée `forbidden`). Seul un échec transitoire de la lecture (réseau, base) garde l'identité confirmée. Elle peut alors désigner une appartenance quittée depuis : aucune écriture n'y est possible (`context_changed`), et la prochaine requête le constate.
- Les préférences d'affichage autres que l'apparence (widgets, image personnelle) ne sont pas encore modélisées (§ 5 et § 7).
