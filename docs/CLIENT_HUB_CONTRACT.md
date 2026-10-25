# Client Hub V1 : contrat backend (PR #25)

Backend livré par la PR #25, interface et sessions dans le navigateur par la PR #26 (§ 3, § 11). Ce document décrit l'architecture retenue, les règles d'identité et d'autorisation, et les contrats que l'interface (Claude UI) peut utiliser **sans rien supposer d'autre**. Migrations : `supabase/migrations/20261021090000_client_hub.sql`, `supabase/migrations/20261024090000_client_hub_session_slots.sql`. Code : `src/features/client-hub/`, `src/app/api/client-hub/`. Tests : `tests/integration/client-hub.test.ts`, `tests/upgrade/client-hub.test.ts`, `tests/upgrade/client-hub-session-slots.test.ts`, `tests/e2e/client-hub-browser.test.ts` (Chromium réel, derrière une entrée TLS locale).

> **Pas encore utilisable en production.** La connexion envoie un code par email via le transport configuré (`EMAIL_TRANSPORT`). Tant que l'envoi réel (Resend) n'est pas configuré, `POST /api/client-hub/session/code` répond `client_hub_unavailable` (503) et n'émet aucun code. Il n'existe aucun contournement de développement dans le code de production. Seul le transport Mailpit local, ou le transport en mémoire des tests, permet de se connecter aujourd'hui.

## 1. Architecture retenue

### Pourquoi pas Supabase Auth pour les clientes

Supabase Auth identifie les **professionnelles**. Un utilisateur Supabase obtient un JWT `authenticated` qui atteint directement PostgREST, l'onboarding (`complete_onboarding`) et toutes les règles réservées aux membres. Donner ce statut à une cliente :

- élargirait la surface exposée à chaque cliente : toute fonction ou table accordée à `authenticated` lui deviendrait accessible ;
- mélangerait les deux sessions dans le même cookie (une professionnelle cliente d'une autre activité) ;
- ferait passer l'email de connexion par le mailer SMTP de Supabase, hors du transport testé du produit, avec une limite de débit globale au projet.

### Ce qui est réutilisé

| Besoin                                | Brique existante                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Point d'entrée unique, clé de service | patron de la réservation publique : routes serveur et fonctions SQL exécutables par `service_role` seulement |
| Adresse réseau de l'appelant          | `trustedClientIp` (ingress de confiance, en-têtes signés, échec fermé)                                       |
| Identifiants anti-abus                | `private.abuse_key` (HMAC à clé, jamais d'email ni d'IP en clair)                                            |
| Email canonique                       | `private.canonical_email` (comme le CRM)                                                                     |
| Envoi d'email                         | l'abstraction de transport du PR #22 (`getEmailTransport` : Resend, Mailpit, mémoire en test)                |
| Autorisation des professionnelles     | `private.assert_agenda_access`, `runBusinessAction`                                                          |
| Fidélité                              | `loyalty_events`, `private.loyalty_balance`, `rewards`, `reward_redemptions`                                 |

### Pourquoi l'email du code ne passe pas par l'outbox

L'outbox est rattachée à une activité et à un rendez-vous, et fige chaque message rendu en base (`private.email_renderings`). Un code de connexion valide n'a pas à être conservé en base. Le code part donc **directement** par le même transport :

- clé d'idempotence = l'identifiant du défi : un fournisseur ne délivre jamais deux fois le même code ;
- aucun nouvel essai automatique : la cliente redemande un code, dans la limite de débit.

## 2. Authentification sans mot de passe

1. **Demande de code** (`POST /api/client-hub/session/code`, `{ email }`) :
   - l'adresse doit être en ASCII ; PostgreSQL la canonicalise et génère un code à 8 chiffres (56 bits aléatoires) ;
   - il ne stocke que son HMAC à clé, lié au défi ;
   - la route envoie le code **à l'adresse canonique à laquelle le défi est lié** (jamais à une autre graphie), et répond `202 { challengeId, expiresAt }`.
2. **Vérification** (`POST /api/client-hub/session/verify`, `{ challengeId, email, code }`) :
   - si le code est bon, le défi est consommé, ainsi que **tous les autres codes ouverts** de cette adresse ;
   - un compte est créé ou mis à jour pour cette adresse vérifiée ;
   - une session est ouverte : jeton opaque de 256 bits, seul son SHA-256 est stocké.

**Propriétés :**

- **Code typé, pas de lien :** un scanner de liens ne peut ni consommer ni rejouer un code.
- **Durée et usage :** 10 minutes, un seul usage, 5 essais par défi, puis le défi est épuisé.
- **Une seule réponse pour tous les échecs** : `client_hub_code_invalid` (400), que le code soit faux, expiré, déjà utilisé, épuisé, envoyé avec une autre adresse ou pour un défi inconnu.
- **Vérifications concurrentes :** les verrous sont toujours pris dans le même ordre, pour la demande de code comme pour la vérification : **réseau → adresse → défi**. Les deux premiers sont des verrous consultatifs de transaction, le troisième le verrou de ligne du défi. Ainsi :
  - plusieurs vérifications du même code, ou de deux codes valides de la même adresse, s'exécutent l'une après l'autre ; une seule réussit, sans deadlock (testé avec des connexions PostgreSQL réelles) ;
  - une demande de code arrivant pendant une vérification de la même adresse attend sa fin ; le nouveau code reste valable ;
  - deux adresses différentes ne se bloquent pas entre elles ; seul un même réseau les sérialise ;
  - les essais incorrects simultanés ne dépassent jamais 5 par défi, quel que soit le nombre de réseaux.
- **Anti-énumération :** la demande de code répond pareil pour toute adresse plausible, connue ou non. Aucun compte n'est créé avant une vérification réussie. Aucune réponse ne dit si l'adresse figure dans un CRM.
- **Limites de débit** (fenêtres glissantes, sous verrous consultatifs ; même réponse `rate_limited` 429 quelle que soit la limite atteinte) :

  | Clé                                              | Fenêtre | Maximum |
  | ------------------------------------------------ | ------- | ------- |
  | demandes de code, par (adresse, réseau)          | 15 min  | 3       |
  | demandes de code, par (adresse, réseau)          | 24 h    | 5       |
  | demandes de code, par adresse (tous réseaux)     | 1 h     | 10      |
  | demandes de code, par adresse (tous réseaux)     | 24 h    | 20      |
  | demandes de code, par réseau (IPv4, ou IPv6 /64) | 1 h     | 10      |
  | demandes de code, par réseau                     | 24 h    | 30      |
  | vérifications échouées, par réseau               | 1 h     | 20      |
  - **Contre la deviner :** pour une adresse visée, au plus 20 défis par jour × 5 essais = 100 tentatives sur 10⁸ codes (environ 0,04 % par an).
  - **Contre le blocage d'une cliente :** un seul réseau ne peut pas épuiser à lui seul le quota d'une adresse (3 demandes par réseau). Bloquer une adresse demande au moins 4 réseaux distincts en une heure.

- **Échec fermé :** sans ingress de confiance, sans transport configuré, ou si l'envoi échoue, la réponse est `client_hub_unavailable` (503). Sans ingress ou sans transport, aucun code n'est émis.
- **Rétention :** journaux anti-abus 2 jours ; défis et sessions terminées supprimés 1 jour après leur fin. La purge est indexée et faite à chaque demande de code.

## 3. Session cliente

- **Durée :** 7 jours, absolue, sans prolongation. Jeton opaque de 256 bits ; seul son SHA-256 est stocké.
- **Un cookie par session** (migration `20261024090000_client_hub_session_slots`) : `__Host-client_hub_s_<id de la session>=<jeton>`.
  - `HttpOnly`, `SameSite=Lax`, `Secure` (dans tous les environnements), `Path=/`, sans `Domain` : ce que le préfixe `__Host-` exige ;
  - `Max-Age` égal à la durée de la session.
- **Pourquoi `__Host-` :** un navigateur n'accepte un cookie de ce préfixe que posé par cet hôte même, en HTTPS, sans `Domain` et sur `Path=/`. Un sous-domaine voisin peut planter des cookies `Domain=` pour l'hôte du Hub, mais jamais un cookie `__Host-`, ni sous ce nom, ni par un cookie sans nom dont la valeur l'imiterait (refusés par Chromium, testé). Le Hub ne lit **que** ce préfixe, à la casse près ; tout autre cookie est ignoré, jamais compté ni supprimé. D'où :
  - plus de connexion forcée : une session plantée par un sous-domaine n'est jamais lue ;
  - plus de blocage par cookies plantés : ils ne comptent pas dans la limite de 16.
- **Conséquence de `Path=/` :** le cookie accompagne toutes les requêtes vers l'hôte, pages comprises. Aucune page ni route professionnelle ne le lit ; les pages du Hub restent des coquilles (testé : le rendu serveur de `/espace` ne contient rien de la cliente).
- **Développement local :** `Secure` est accepté par les navigateurs sur `http://localhost` ; sur une autre origine HTTP, le Hub ne peut pas ouvrir de session.
- **CSRF :**
  - `SameSite=Lax` empêche l'envoi du cookie lors d'un POST ou DELETE inter-sites ;
  - contre la « connexion forcée » (un formulaire d'un autre site qui ouvrirait une session dans le navigateur de la visiteuse), les POST et DELETE exigent `Content-Type: application/json`, et refusent un `Sec-Fetch-Site` autre que `same-origin`/`none` ou un `Origin` autre que celui de l'application (403 `forbidden`) ;
  - les lectures sont des GET sans autre effet que la résolution décrite ci-dessous.
- **Séparation des rôles :**
  - aucun cookie client n'est accepté par une action ou une route professionnelle, qui reposent sur la session Supabase ;
  - une session Supabase, professionnelle ou anonyme, ne peut exécuter aucune fonction client (privilège refusé, testé).

### Sessions dans le navigateur

**Pourquoi un cookie par session.** Un navigateur applique le `Set-Cookie` d'une réponse à son arrivée, quoi que fasse la page (onglet caché, fermé, attente abandonnée), et la dernière réponse arrivée l'emporte. Avec un seul nom de cookie partagé par tous les onglets (`client_hub_session`, jusqu'à la PR #26) :

- une déconnexion de A, dont la réponse arrivait après la connexion de B, effaçait le cookie de B ;
- une connexion de A, traitée avant celle de B mais arrivée après, remettait le cookie de A : l'onglet de B affichait A.

Aucun serveur ne peut connaître l'ordre d'arrivée de ses réponses, et aucune garde côté page ne peut empêcher le navigateur d'appliquer un `Set-Cookie` déjà parti. Désormais, une réponse ne fait que deux choses : **ajouter le cookie de la session qu'elle vient d'ouvrir**, ou **supprimer des cookies de sessions terminées**. Ces écritures commutent : quel que soit l'ordre d'arrivée, le navigateur finit avec les mêmes cookies. Un nom n'est jamais réutilisé (c'est l'id de la session), et seule la connexion qui a ouvert une session pose son cookie : supprimer le cookie d'une session terminée ne peut donc jamais effacer une autre session.

**Résolution (PostgreSQL, `client_hub_resolve_session`, à chaque requête authentifiée).** Le navigateur peut présenter plusieurs cookies de session :

| Ce que présente le navigateur                                                   | Résultat                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| aucune session vivante (inconnue, expirée, révoquée, jeton d'une autre session) | 401 `client_hub_unauthenticated` ; les cookies présentés sont supprimés                                                        |
| des sessions vivantes d'**un seul compte**                                      | la plus récente (`created_at`, puis `id`) est utilisée ; les autres présentées sont révoquées et leurs cookies supprimés       |
| des sessions vivantes de **plusieurs comptes**                                  | **échec fermé** : toutes sont révoquées, aucune n'est choisie, 401 et tous les cookies présentés supprimés                     |
| plus de 16 cookies `__Host-` de session (que seul cet hôte peut avoir posés)    | **échec fermé** sans interroger la base : aucune session n'est utilisée ni révoquée, 401, tous les cookies présentés supprimés |
| un en-tête `Cookie` au-delà de la limite du serveur (16 Kio pour Node)          | 431, avant toute route, sans `Set-Cookie`                                                                                      |
| la base n'a pas pu répondre                                                     | 500, **aucun cookie touché**                                                                                                   |

- **Un cookie ne compte que sous le nom de sa propre session :** le jeton d'une session sous le nom d'une autre, ou sous un nom qui n'est pas une session, n'authentifie rien.
- **Noms invalides :** un cookie dont le nom n'est pas exactement `__Host-client_hub_s_<uuid en minuscules>` (préfixe à la casse près) est ignoré, jamais compté ni supprimé : les anciens `client_hub_session` et `client_hub_s_<id>`, un `__host-` ou `__Secure-`, un nom encodé.
- **Valeurs invalides :** un nom valide avec une valeur qui n'est pas un jeton n'authentifie rien ; son cookie est supprimé.
- **Doublons :** un même nom présent deux fois (impossible depuis un autre hôte avec le préfixe `__Host-`) : chaque valeur est examinée seule ; seule celle qui est le jeton de cette session compte.
- **« Plus récente » :** l'instant d'ouverture de la session en base (début de la transaction de vérification du code), puis l'id en cas d'égalité. Ce n'est ni l'ordre des clics, ni l'ordre d'arrivée des réponses. Elle ne départage que des sessions **d'un même compte** : la cliente reste la même, quelle que soit la session gagnante.
- **Pourquoi l'échec fermé entre comptes :** deux comptes vivants dans un même navigateur n'arrivent que si deux connexions de comptes différents se croisent, ou si un cookie de session a été copié d'un navigateur à l'autre. Le serveur ne peut pas savoir qui est la visiteuse ; il ne choisit pas. (Avant le préfixe `__Host-`, c'était aussi la défense contre un sous-domaine qui plantait sa session à côté de celle de la victime ; ces cookies ne sont plus lus du tout.)
- **Ce que les utilisatrices voient :** après deux connexions croisées de comptes différents, tous les onglets reviennent à la connexion ; il suffit de se reconnecter. Deux connexions croisées du même compte restent connectées.
- **Identité des réponses :** toute réponse privée porte `X-Client-Hub-Account: <id du compte>` (le compte de la session résolue ; absent sur un 401). L'interface ne montre aucune réponse servie pour un autre compte que celui que `GET /me` a confirmé (§ 11).
- **Révocations :** une requête ne révoque que des sessions dont elle présente le jeton, et, pour une déconnexion globale, les sessions du compte d'une session vivante présentée.

**Connexion** (`client_hub_sign_in`) : vérifie le code (`client_hub_verify_code`), ouvre la session, puis **termine les sessions présentées par le navigateur** (se connecter remplace qui est le navigateur). La réponse ajoute le nouveau cookie, supprime les cookies présentés et nomme le compte. Un code refusé ne termine rien et ne touche aucun cookie.

**Déconnexion** (`client_hub_sign_out`) :

- `DELETE /api/client-hub/session` termine les sessions présentées ; `?all=true` termine aussi toutes les sessions de leurs comptes, **seulement à partir d'une session présentée encore vivante** (une session révoquée, expirée ou inconnue n'a aucune autorité) ;
- la réponse supprime les cookies présentés, et seulement eux : une session ouverte après le départ de la requête a un autre cookie ;
- toujours `200 { ended: true }`, aussi sans session.

**Ordre des verrous.** Toute fonction qui termine ou choisit des sessions respecte le même ordre :

1. **L1**, seulement pour une connexion : réseau, puis adresse (verrous consultatifs), puis ligne du défi ;
2. **L2** : les comptes des sessions vivantes présentées (verrous consultatifs, dans l'ordre des uuid), puis les lignes de ces sessions (`FOR UPDATE`, dans l'ordre des id), relues sous verrou.

L1 est toujours pris avant L2, jamais après. Les lectures ne verrouillent qu'une ligne de session et n'attendent rien d'autre. La purge (à chaque demande de code) ne supprime que des sessions expirées depuis un jour, qu'aucun détenteur de L2 ne verrouille. Aucun cycle d'attente n'est donc possible (tests de concurrence réels, § 10). Deux déconnexions ou résolutions du même compte s'exécutent l'une après l'autre ; des comptes différents ne s'attendent pas.

**Points d'entrée remplacés :** `client_hub_verify_code` et `client_hub_end_session` restent dans l'historique, mais ne sont plus exécutables par la clé de service.

## 4. Règles d'identité et d'autorisation

| Notion                                    | Ce qui l'établit                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Possession d'une boîte email              | un code reçu à cette adresse, puis vérifié                                                                                                              |
| Identité cliente authentifiée             | une session ouverte par cette vérification : un compte par adresse canonique, toutes activités confondues                                               |
| Relation avec la fiche CRM d'une activité | **une autorisation explicite d'un membre de cette activité** pour cette fiche (`public.client_hub_access`), pour l'email que la fiche avait à ce moment |
| Droit de voir un rendez-vous              | il appartient à une fiche dont la relation est autorisée                                                                                                |
| Droit de voir la fidélité                 | même règle, par activité                                                                                                                                |

**Pourquoi l'email seul ne suffit pas.** L'email d'une fiche n'est pas une preuve de propriété :

- une réservation publique accepte un email saisi sans vérification : quelqu'un peut réserver avec l'adresse d'une autre personne ;
- une professionnelle peut se tromper en saisissant une adresse.

Prouver qu'on possède l'adresse ne prouve donc pas que la fiche, ses rendez-vous et ses points sont les siens.

**Règle :** une session voit une activité si et seulement si les quatre conditions suivantes sont réunies.

1. Un membre de l'activité a autorisé l'accès pour cette fiche (`client_hub_set_access`). Il atteste ainsi que la fiche appartient à la personne qui contrôle **son email actuel**.
2. L'autorisation n'est pas révoquée.
3. L'email attesté est celui du compte.
4. La fiche a **toujours** cet email. Tout changement d'email de la fiche **révoque** l'accès (trigger, quel que soit le chemin d'écriture) : la nouvelle adresse n'obtient rien sans une nouvelle autorisation, et revenir à l'ancienne adresse ne fait pas revivre l'autorisation.

**En dehors de ces cas, l'activité n'existe pas pour la cliente :**

- `client_hub_not_found` (404), qu'il s'agisse d'une activité inconnue, d'une fiche sans autorisation ou de l'identifiant d'une autre cliente ;
- la cliente ne peut pas savoir qu'une fiche porte son email.

**Autres règles :**

- **Plusieurs activités :** une autorisation par activité ; chaque relation est lue séparément, avec ses propres identifiants. Aucune fiche n'est fusionnée entre activités.
- **Doublons :** le CRM garantit une seule fiche par email canonique et par activité.

### Réservations historiques non vérifiées

Elles ne deviennent visibles qu'**à travers l'autorisation de la professionnelle** pour la fiche. Une réservation publique faite avec l'adresse d'une personne ne lui montre rien à sa connexion (testé). Une fois la fiche autorisée, tout son historique est visible, en projection sûre (§ 6). La professionnelle connaît sa cliente : c'est la preuve supplémentaire retenue en V1.

## 5. Côté professionnelle

| Action (`src/features/client-hub/actions/access.ts`) | Entrée                                  | Résultat                          |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `getClientHubAccessAction`                           | `{ clientId }`                          | `ClientHubAccessDto`              |
| `setClientHubAccessAction`                           | `{ clientId, granted, expectedEmail? }` | `ClientHubAccessDto` (idempotent) |

- `ClientHubAccessDto` : `{ clientId, granted, email, grantedAt }`.
- `expectedEmail` : l'email affiché à la professionnelle quand elle autorise. Si la fiche en a un autre entre-temps, l'autorisation est refusée (`stale_client`). L'interface doit toujours l'envoyer.
- La fiche est verrouillée pendant l'autorisation : son email ne peut pas changer au même moment.

**Erreurs :**

- `client_not_found` : fiche absente de l'activité ;
- `client_hub_email_required` : fiche sans email ;
- `forbidden` / `unauthenticated` : pas membre, ou pas de session professionnelle.

**Lecture :** les autorisations sont lisibles par les membres (RLS). Elles ne sont modifiables que par la fonction.

## 6. API cliente (lecture seule)

Toutes les routes ci-dessous :

- exigent un cookie de session (résolu comme au § 3) ;
- nomment le compte pour lequel elles répondent : `X-Client-Hub-Account` (absent sur un 401) ;
- répondent `{ data }` ou `{ error: { code, message, fieldErrors? } }`, avec `Cache-Control: no-store` ;
- utilisent des instants en ISO 8601 (UTC), des montants en centimes et des points entiers.

Les types sont dans `src/features/client-hub/types.ts`.

| Route                                                                                                                                                     | Réponse                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/client-hub/me`                                                                                                                                  | `ClientHubProfileDto` : `{ email, businesses: [{ businessId, name, slug, timezone, location, customer: { firstName, lastName } }] }`                                                                            |
| `GET /api/client-hub/businesses/:businessId/appointments?scope=upcoming\|past&cursor&limit`                                                               | `ClientHubAppointmentsPageDto` : `{ items, nextCursor }`. `upcoming` : à partir de maintenant, le plus proche d'abord. `past` : le plus récent d'abord. `limit` de 1 à 50 (20 par défaut). `cursor` est opaque. |
| `GET /api/client-hub/businesses/:businessId/appointments/:appointmentId`                                                                                  | `ClientHubAppointmentDetailDto` : le rendez-vous et `business: { name, slug, timezone, location, cancellationPolicy }`                                                                                          |
| `GET /api/client-hub/businesses/:businessId/loyalty`                                                                                                      | `ClientHubLoyaltyDto` : `{ programActive, balance, rewards, issuedRewards }`                                                                                                                                    |
| `GET /api/client-hub/businesses/:businessId/loyalty/ledger?cursor&limit` (curseur : position dans l'historique de la cliente, jamais la séquence globale) | `ClientHubLedgerPageDto` : `{ items, nextCursor }`, du plus récent au plus ancien, `limit` de 1 à 50                                                                                                            |

**Rendez-vous :** `{ id, status, startsAt, endsAt, serviceName, durationMinutes, priceCents, currency }`. Les heures murales s'affichent dans `timezone` (celui de l'activité). **Jamais exposés** : notes internes, motif d'annulation, coordonnées saisies à la réservation, auteur, identifiants de fiche.

**Fidélité :**

- `rewards` : les récompenses **actives**, avec :
  - `{ id, name, description, pointsRequired, rewardType, rewardValue, currency, serviceName }` ;
  - `eligible` et `missingPoints` (calculé sur le solde signé). Ces deux champs sont **informatifs** : la cliente ne peut rien échanger elle-même.
- `issuedRewards` : les 50 dernières récompenses attribuées, avec leur instantané et leur statut (`issued`, `fulfilled`, `cancelled`), sans motif d'annulation.
- Historique : `{ id, type, pointsDelta, balanceAfter, createdAt, appointmentId, serviceName, rewardName, isReversal, reversed }`. Le **motif saisi par la professionnelle n'est jamais exposé** : l'interface affiche un libellé selon `type` (et `serviceName` ou `rewardName`).

## 7. États pour l'interface

| État                             | Comment le détecter                          | Action                                               |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Non connectée                    | `GET /me` → 401 `client_hub_unauthenticated` | formulaire email                                     |
| Code envoyé                      | `202 { challengeId, expiresAt }`             | saisie du code, compte à rebours                     |
| Code refusé                      | 400 `client_hub_code_invalid`                | message unique et « Renvoyer un code »               |
| Trop de demandes                 | 429 `rate_limited`                           | patienter, ne pas renvoyer automatiquement           |
| Indisponible                     | 503 `client_hub_unavailable`                 | message, réessayer plus tard                         |
| Connectée, aucune activité       | `GET /me` → `businesses: []`                 | expliquer que la professionnelle doit ouvrir l'accès |
| Connectée                        | `businesses` non vide                        | liste par activité                                   |
| Élément inaccessible             | 404 `client_hub_not_found`                   | « introuvable », sans détail                         |
| Session expirée en cours d'usage | 401 sur n'importe quelle route               | revérifier `GET /me` ; si 401, formulaire email      |
| Entrée invalide                  | 400 `validation_error` (`fieldErrors`)       | erreurs par champ                                    |

Chargement : chaque route est une lecture bornée. Une page vide (`items: []`, `nextCursor: null`) est un état normal.

## 8. Opérations non prises en charge (ne pas afficher)

La cliente ne peut pas, et aucune route ne le permet :

- échanger une récompense ;
- créer ou ajuster des points ;
- modifier sa fiche CRM ;
- modifier ou annuler un rendez-vous ;
- marquer une récompense comme utilisée ;
- se créer elle-même un accès à une activité.

Les professionnelles restent la seule autorité sur ces opérations.

## 9. Limites connues

- **Envoi réel non configuré :** voir l'encadré en tête de document.
- **Accès par autorisation seulement :** une cliente sans autorisation de sa professionnelle voit un espace vide. Il n'y a pas encore d'invitation par email : la professionnelle ouvre l'accès depuis la fiche cliente (§ 11) et transmet elle-même le lien de l'espace.
- **Réservation depuis l'espace :** une réservation faite pendant une session n'est pas rattachée automatiquement ; elle suit la règle d'autorisation.
- **Durée de session fixe :** 7 jours, sans « appareils connectés » détaillés. La déconnexion de toutes les sessions existe.
- **Pas de captcha :** les limites de débit sont la seule défense contre l'envoi massif de codes vers des adresses arbitraires.
- **Adresses internationalisées :** les adresses non ASCII sont refusées en V1.
- **Réseaux partagés :** derrière un même réseau (CGNAT, entreprise), 20 vérifications échouées en une heure bloquent les vérifications de tout ce réseau pour une heure.
- **Historique de fidélité :** chaque page recalcule le solde courant sur tout l'historique de la cliente (borné par son volume, pas par celui de l'activité).
- **Comptes :** une adresse vérifiée reste enregistrée (email et dates seulement) ; les sessions et les défis sont purgés.
- **Fonctions de la clé de service :** elles ne prennent aucune heure en paramètre : l'heure est toujours celle de la base.

### Limites des sessions dans le navigateur (testées)

Chacune est couverte par un test qui l'énonce (`tests/integration/client-hub.test.ts`, `tests/e2e/client-hub-browser.test.ts`, titres « LIMIT ») ou par un test qui en vérifie la conséquence sûre.

- **Connexions croisées de deux comptes :** le navigateur est déconnecté (échec fermé) ; il faut se reconnecter. Jamais l'identité de l'une dans l'onglet de l'autre.
- **Connexion validée avant une déconnexion, arrivée après :** une connexion dont le serveur a validé le code avant une déconnexion simple, mais dont la réponse arrive après, reste ouverte. La déconnexion ne termine que les sessions que le navigateur présentait. La déconnexion de tous les appareils la termine.
- **Sous-domaine hostile :** ses cookies `Domain=` ne sont plus lus (connexion forcée et blocage par 16 cookies corrigés, testés dans Chromium avec de vrais cookies `Domain=hub.test`). Il garde un seul moyen d'action, commun à tout site : planter assez de cookies (de n'importe quel nom) pour dépasser la limite d'en-tête du serveur (16 Kio), et faire refuser **toutes** les requêtes vers l'hôte (431) tant qu'ils restent. Aucune session n'en est affectée ; l'application ne peut pas supprimer ces cookies (ils appartiennent au domaine parent). La parade est hors de l'application : ne pas confier de sous-domaine du domaine du Hub à un tiers.
- **Dépend du navigateur :** la garantie du préfixe `__Host-` est celle du navigateur (Chromium testé ; tous les navigateurs actuels l'appliquent, y compris aux cookies sans nom qui l'imitent). Un navigateur trop ancien pour connaître le préfixe se comporterait comme avant (cookies plantés lus).
- **Sessions orphelines :** une connexion validée dont la réponse n'arrive jamais (onglet fermé, connexion coupée, attente abandonnée) laisse une session que nul navigateur ne détient. Elle expire au bout de 7 jours ; la déconnexion de tous les appareils la termine.
- **Onglet fermé pendant une réponse :** Chromium peut appliquer ou non le `Set-Cookie` d'une réponse arrivée après la fermeture de l'onglet. Les deux issues sont sûres (testées).
- **Requête rejouée par le navigateur :** Chromium renvoie une requête dont la connexion réutilisée est coupée avant toute réponse. Une vérification rejouée est refusée (code à usage unique) : pas de seconde session.
- **Plus de 16 cookies `__Host-` :** seul cet hôte peut les avoir posés (16 connexions simultanées dans un même navigateur). Aucune session n'est utilisée ni révoquée, toutes sont supprimées du navigateur (sessions orphelines, comme ci-dessus).
- **« Plus récente » suppose des durées fixes :** l'ordre est celui de l'ouverture en base, pour un même compte. Il ne dépend ni des horloges des navigateurs ni de l'ordre d'arrivée.

## 10. Sensibilité des tests (mutations)

`node tests/mutation/client-hub.mjs` (pile Supabase locale requise) rejoue les mutations des protections. Pour chaque mutation, le script modifie un fichier (migration, route ou page), réinitialise la base s'il s'agit d'une migration, lance les tests ciblés et restaure le fichier. Il échoue (code de sortie 1) si une mutation n'est pas détectée ; une exécution qui échoue sans test en échec ne compte pas comme une détection.

| Mutation                                                            | Où                    | Résultat                                                                        |
| ------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| retirer le verrou d'adresse de la vérification                      | migration PR #25      | détectée : deadlock (`40P01`), demande de code non sérialisée                   |
| prendre le verrou d'adresse après le verrou de ligne                | migration PR #25      | détectée                                                                        |
| choisir la session la plus récente même entre comptes différents    | résolveur             | détectée : défaut 2, cookie tossing                                             |
| garder la plus ancienne session d'un compte                         | résolveur             | détectée                                                                        |
| laisser vivantes les autres sessions présentées                     | résolveur             | détectée                                                                        |
| accepter un jeton sous le nom d'une autre session                   | résolveur             | détectée                                                                        |
| verrouiller les comptes dans l'ordre de présentation                | résolveur             | détectée : une résolution bloquée détient déjà un verrou de compte (`pg_locks`) |
| ne pas verrouiller les comptes                                      | résolveur             | détectée (y compris deadlock entre déconnexions globales)                       |
| ne pas relire les sessions sous verrou                              | résolveur             | détectée                                                                        |
| la connexion ne termine pas les sessions présentées                 | `client_hub_sign_in`  | détectée                                                                        |
| un seul nom de cookie pour toutes les sessions (l'ancien protocole) | `data/session.ts`     | détectée : défauts 1 et 2, et la plupart des tests de sessions                  |
| supprimer aussi le cookie de la session gagnante                    | `data/route.ts`       | détectée                                                                        |
| supprimer les cookies quand la base n'a pas répondu                 | `data/route.ts`       | détectée                                                                        |
| ne plus nommer le compte des réponses                               | `data/route.ts`       | détectée                                                                        |
| examiner plus de 16 cookies                                         | `data/session.ts`     | détectée                                                                        |
| lire aussi les noms sans préfixe `__Host-`                          | `data/session.ts`     | détectée : connexion forcée et blocage (aussi dans Chromium, voir ci-dessous)   |
| lire le préfixe sans tenir compte de la casse                       | `data/session.ts`     | détectée                                                                        |
| poser le cookie sans `Secure`                                       | `data/session.ts`     | détectée                                                                        |
| poser le cookie sur `Path=/api/client-hub`                          | `data/session.ts`     | détectée                                                                        |
| la connexion ne supprime pas les cookies présentés                  | route de vérification | détectée                                                                        |
| l'interface accepte une réponse de n'importe quel compte            | `client/session.tsx`  | détectée (composants ; et dans Chromium, voir ci-dessous)                       |
| un 401 de lecture déconnecte sans revérifier                        | `client/session.tsx`  | détectée                                                                        |
| revérifier sans limite                                              | `client/session.tsx`  | détectée                                                                        |
| un profil sans compte nommé confirme une identité                   | `client/session.tsx`  | détectée                                                                        |

La mutation « lire aussi les noms sans préfixe `__Host-` » a aussi été rejouée à la main sur le build de production, dans Chromium : la connexion forcée (l'identité de l'attaquant s'affiche) et le blocage par 17 cookies plantés reviennent.

La mutation « l'interface accepte une réponse de n'importe quel compte » a aussi été rejouée à la main sur le build de production, dans Chromium : le test « a read of a business both customers use… » échoue (les données de la seconde cliente s'affichent sous l'écran de la première).

Retirer **seulement** le verrou de ligne de la déconnexion n'est pas détecté : le verrou de compte ordonne à lui seul toute révocation d'une session, et le verrou de ligne n'est plus qu'une seconde garde, redondante.

## 11. Interface (PR #26)

### Espace cliente (`/espace`)

| Page                                             | Contenu                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `/espace/connexion`                              | email, puis code à 8 chiffres                                                               |
| `/espace`                                        | une carte par établissement : prochain rendez-vous et carte fidélité (jamais additionnées)  |
| `/espace/:businessId/rendez-vous`                | à venir / passés, groupés par mois, paginés par curseur                                     |
| `/espace/:businessId/rendez-vous/:appointmentId` | détail, établissement, conditions d'annulation ; rien de modifiable                         |
| `/espace/:businessId/fidelite`                   | solde, récompenses (progression, « Disponible »), récompenses attribuées, historique paginé |

**Session côté navigateur** (`src/features/client-hub/client/session.tsx`) :

- **Pages sans données côté serveur :** aucune page ne lit le cookie de session (`Path=/` le leur envoie, comme l'exige le préfixe `__Host-`). Les pages sont des coquilles `noindex`, et toutes les données viennent d'appels `fetch` same-origin vers les routes, en `no-store` et `credentials: same-origin`. Aucun jeton n'est lisible par JavaScript.
- **Qui est connectée :** l'interface le demande à `GET /me`, au chargement, au retour sur l'onglet et à la restauration depuis le cache avant/arrière.
  - Dès que l'onglet est quitté, ses données sont **voilées** : masquées et inertes, sans être détruites.
  - Ce que ses écrans affichent hors de leur conteneur (le panneau « Mon compte », un portail sur `<body>`) est **suspendu** avec eux : fermé, son piège de focus et ses attributs `inert` retirés. Le focus va sur l'écran de vérification, puis sur « Réessayer », accessible au clavier et au toucher.
  - Elles ne réapparaissent qu'une fois l'identité confirmée.
  - **Même cliente :** son écran revient tel qu'elle l'avait laissé, pagination et panneau ouvert compris.
  - **Autre cliente :** les écrans repartent de zéro.
  - **Pas de réponse :** le voile reste, avec « Réessayer ». Ce n'est pas une expiration, et l'ancien écran n'est jamais réexposé.
- **Génération :** chaque identité affichée (connexion, déconnexion, expiration, autre cliente connectée ailleurs) en reçoit une nouvelle.
  - Tous les écrans sont remontés sous cette génération : rien de ce qui a été saisi, ouvert ou lu n'est conservé.
  - Toute réponse à une requête partie sous une génération antérieure est ignorée. Cela vaut aussi pour un 401 tardif, qui ne peut jamais déconnecter la session suivante.
  - Chaque lecture et chaque page de liste vérifient aussi leur clé (établissement, période) : une page tardive n'est jamais ajoutée à une autre liste.
- **Réponses des routes :**
  - **Identité de chaque réponse :** une réponse servie pour un autre compte que celui que `GET /me` a confirmé (`X-Client-Hub-Account`), ou une donnée qui ne nomme aucun compte, n'est jamais affichée. Les données sont voilées, l'identité est revérifiée, puis la lecture repart une fois l'identité confirmée (une autre cliente obtient de nouveaux écrans). Une seule revérification par lecture : si le serveur nomme encore un autre compte, la lecture affiche une erreur, sans boucle.
  - **401** sur n'importe quelle lecture : l'identité est revérifiée par `GET /me`. Si personne n'est plus connecté, l'écran revient à la connexion (« Votre session a expiré ») ; si une autre cliente est connectée, ses écrans s'ouvrent.
  - **404 :** l'interface redemande `GET /me`. Une autorisation retirée fait disparaître l'établissement de l'espace.
  - **Établissement absent du profil :** aucune requête n'est faite pour lui. La sécurité reste celle de l'API.
- **Fin de session :**
  - **Déconnexion :** `DELETE /api/client-hub/session` (ou `?all=true`). Sans réponse, l'écran dit que la déconnexion n'est pas confirmée et garde la session. Une réponse confirmée dit seulement que **ses** sessions sont terminées. Elle ne dit pas que personne n'est connecté : un autre onglet peut avoir connecté une autre cliente pendant le trajet de la réponse, avec son propre cookie, intact. Elle est donc réconciliée avec `GET /me` :
    - si l'onglet montre encore la cliente qui s'est déconnectée, ses écrans disparaissent aussitôt (nouvelle génération, rien de privé ni de panneau ouvert), puis `/me` décide : une cliente confirmée (`X-Client-Hub-Account`) obtient ses écrans sans se reconnecter ; personne, et c'est la page de connexion (« Vous êtes déconnectée ») ;
    - si l'onglet est déjà passé à une autre identité (réponse tardive), celle-ci est seulement revérifiée sous voile : jamais déconnectée par cette réponse, ses écrans reviennent tels quels si `/me` la confirme.
  - **Autres onglets :** un message `BroadcastChannel` (`client-hub-session`) est une **demande de vérification**, jamais un ordre. L'onglet voile ses données et demande `/me` : la même cliente garde ses écrans, une autre en obtient de nouveaux, personne mène à la connexion (« depuis un autre onglet »). Les anciens messages (`signed-in`, `signed-out`) sont lus de la même façon. Sans `BroadcastChannel`, un onglet apprend le changement au retour sur l'onglet, à sa lecture suivante (identité de la réponse) ou à la réponse de sa propre déconnexion.
  - **Expiration : le serveur décide.** La fin annoncée par la connexion (réponse de `verify`, 7 jours) appartient à la cliente qui s'est connectée dans cet onglet : elle est rattachée au compte que `/me` confirme ensuite, et abandonnée dès qu'une autre identité est confirmée (connexion dans un autre onglet, A → B → A). Elle n'est jamais réutilisée pour une autre cliente.
    - À l'heure dite, l'interface ne déclare rien : elle **voile** les données et demande `/me`. Session toujours valide : ses écrans reviennent. Session terminée (401) : connexion, « Votre session a expiré ». Pas de réponse : le voile reste avec « Réessayer », jamais une expiration non confirmée.
    - Une fin n'est utilisée qu'une fois : pas de boucle de vérifications si elle est déjà passée (horloge décalée).
    - Une cliente connectée depuis un autre onglet n'a pas de fin connue ici (`/me` ne la donne pas) : rien n'est inventé. Sa fin est constatée par le serveur : un 401 sur une lecture, le retour sur l'onglet, un message d'un autre onglet.

**Connexion :**

- **Code :**
  - un seul champ réel (`autocomplete="one-time-code"`, pavé numérique, collage de « 1234 5678 »), affiché en 8 cases ;
  - envoi automatique dès 8 chiffres ;
  - le code n'est conservé qu'en mémoire, et vidé après chaque essai.
- **Limites affichées** (le backend reste l'autorité) :
  - compte à rebours de validité ;
  - 5 essais par code ;
  - 30 s entre deux envois.
- **Anti-énumération :** le même écran s'affiche pour toute adresse, connue ou non.
- **Une tentative par adresse :**
  - chaque parcours de connexion porte un numéro, renouvelé à chaque nouvelle adresse ou retour en arrière ;
  - une réponse d'un ancien parcours (renvoi de code, erreur, vérification) n'agit plus, et le renvoi ne remplace que le défi pour lequel il a été demandé ;
  - pendant une vérification, qui peut ouvrir une session, l'adresse ne peut pas être changée.
- **Réponses d'erreur :**
  - `client_hub_unavailable` affiche « Accès temporairement indisponible », sans aucun contournement ;
  - `rate_limited` invite à patienter, et rien n'est renvoyé automatiquement.

**Lecture seule :** aucun bouton d'échange, de crédit, d'annulation ou de modification. Le motif saisi par la professionnelle n'est jamais affiché : l'historique est libellé d'après `type`, `serviceName` et `rewardName`.

### Fiche cliente CRM : carte « Espace client »

Actions existantes : `getClientHubAccessAction`, `setClientHubAccessAction`. Aucune action ni règle n'a été ajoutée.

- **Lecture :** l'accès est lu à l'ouverture et relu à chaque changement d'email de la fiche. Si l'accès était ouvert et que l'email a changé, la carte dit qu'il a été retiré automatiquement.
- **Autoriser :**
  - après confirmation, qui liste ce que la cliente verra et ne verra pas ;
  - envoie toujours `expectedEmail` = l'adresse affichée ;
  - l'adresse ensuite montrée est celle renvoyée par le backend.
- **Retirer :** après confirmation.
- **Erreurs :**
  - `stale_client` / `client_hub_email_required` : rien n'est autorisé, et la fiche comme l'accès sont relus ;
  - sans réponse : la carte dit que le changement a peut-être été enregistré, et relit l'accès.
- **Garanties :** jamais d'autorisation automatique, ni d'« invitation envoyée ». La carte propose le lien de l'espace à copier.

### Contrats manquants (pour une prochaine PR backend)

- **Envoi d'invitation par email :** la professionnelle transmet le lien à la main.
- **Fin de session :** `GET /me` ne renvoie pas `expiresAt`. Après un rechargement, ou pour une cliente connectée depuis un autre onglet, l'interface ne connaît la fin de session qu'au premier 401 (ou au retour sur l'onglet). Exposer la fin de la session résolue dans `/me` permettrait de voiler à l'heure dite dans tous les cas : c'est un choix de protocole, laissé au backend.
- ~~**Identité des réponses**~~ : fournie par `X-Client-Hub-Account` (§ 3). `BroadcastChannel` ne sert plus qu'à accélérer la synchronisation entre onglets ; la correction n'en dépend pas (testé sans lui dans Chromium).
