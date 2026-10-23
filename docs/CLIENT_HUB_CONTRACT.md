# Client Hub V1 : contrat backend (PR #25)

Backend livré par la PR #25, interface par la PR #26 (§ 11). Ce document décrit l'architecture retenue, les règles d'identité et d'autorisation, et les contrats que l'interface (Claude UI) peut utiliser **sans rien supposer d'autre**. Migration : `supabase/migrations/20261021090000_client_hub.sql`. Code : `src/features/client-hub/`, `src/app/api/client-hub/`. Tests : `tests/integration/client-hub.test.ts`, `tests/upgrade/client-hub.test.ts`.

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

- **Cookie `client_hub_session` :**
  - `HttpOnly`, `SameSite=Lax`, `Path=/api/client-hub` ;
  - `Secure` en production ;
  - `Max-Age` égal à la durée de la session.
- **Durée :** 7 jours, absolue, sans prolongation.
- **Fin de session :**
  - `DELETE /api/client-hub/session` met fin à la session courante ;
  - `DELETE /api/client-hub/session?all=true` met fin à toutes les sessions du compte, **seulement si la session présentée est encore active**. La ligne de cette session est verrouillée et vérifiée sous ce verrou. Une session révoquée, expirée ou inconnue n'a aucune autorité sur les autres, même si sa révocation est concurrente : la réponse reste `200 { ended: true }`, sans indiquer l'état de l'ancienne session ;
  - **ordre des verrous de la déconnexion :** le compte (verrou consultatif de transaction), puis la ligne de la session appelante. Deux déconnexions globales simultanées du même compte s'exécutent donc l'une après l'autre, sans deadlock : la première révoque toutes les sessions actives, la seconde trouve la sienne révoquée et ne change plus rien (les deux répondent 200). Les comptes différents ne s'attendent jamais. Seules les sessions actives sont révoquées ; les sessions expirées relèvent de la purge, sur des lignes disjointes. Une connexion n'insère qu'une nouvelle session, sans verrou de session : elle ne bloque pas une déconnexion et n'est pas bloquée par elle ;
  - le cookie est effacé dans les deux cas.
- **Session refusée :** une session inconnue, expirée ou terminée donne `client_hub_unauthenticated` (401), **sans toucher au cookie**.
  - Un `Set-Cookie` de suppression désigne le cookie par son nom, pas par sa valeur. Envoyé avec une lecture refusée et lente, il effacerait une session plus récente ouverte entre-temps dans le même navigateur.
  - Un cookie mort reste inoffensif : toutes les routes le refusent.
  - Seule une déconnexion explicite (`DELETE /api/client-hub/session`) l'efface.
- **CSRF :**
  - `SameSite=Lax` empêche l'envoi du cookie lors d'un POST ou DELETE inter-sites ;
  - contre la « connexion forcée » (un formulaire d'un autre site qui ouvrirait une session dans le navigateur de la visiteuse), les POST et DELETE exigent `Content-Type: application/json`, et refusent un `Sec-Fetch-Site` autre que `same-origin`/`none` ou un `Origin` autre que celui de l'application (403 `forbidden`) ;
  - les lectures sont des GET sans effet.
- **Cookie dupliqué :** deux cookies `client_hub_session` (par exemple déposés par un sous-domaine) sont refusés, jamais départagés.
- **Séparation des rôles :**
  - le cookie client n'est accepté par aucune action ni route professionnelle, qui reposent sur la session Supabase ;
  - une session Supabase, professionnelle ou anonyme, ne peut exécuter aucune fonction client (privilège refusé, testé).

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

- exigent le cookie de session ;
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
| Session expirée en cours d'usage | 401 sur n'importe quelle route               | retour au formulaire email                           |
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

## 10. Sensibilité des tests de concurrence

`node tests/mutation/client-hub.mjs` (pile Supabase locale requise) rejoue les mutations des protections de concurrence et d'autorité de session :

| Mutation                                                                | Résultat                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| retirer le verrou d'adresse de la vérification (le comportement audité) | détectée : deadlock (`40P01`), et demande de code non sérialisée |
| prendre le verrou d'adresse après le verrou de ligne                    | détectée                                                         |
| une session révoquée garde l'autorité de déconnexion globale            | détectée                                                         |
| une session expirée garde l'autorité de déconnexion globale             | détectée                                                         |
| retirer le verrou de compte de la déconnexion (le comportement audité)  | détectée : deadlock (`40P01`) entre deux déconnexions globales   |
| retirer à la fois le verrou de compte et le verrou de ligne             | détectée                                                         |

Retirer **seulement** le verrou de ligne n'est pas détecté : le verrou de compte ordonne à lui seul toute révocation d'une session, et le verrou de ligne n'est plus qu'une seconde garde, redondante.

Pour chaque mutation, le script réinitialise la base, lance les tests ciblés et restaure la migration. Il échoue (code de sortie 1) si une mutation n'est pas détectée.

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

- **Pages sans données côté serveur :** le cookie est limité à `/api/client-hub`, donc aucune page ne peut lire la session. Les pages sont des coquilles `noindex`, et toutes les données viennent d'appels `fetch` same-origin vers les routes, en `no-store` et `credentials: same-origin`. Aucun jeton n'est lisible par JavaScript.
- **Qui est connectée :** l'interface le demande à `GET /me`, au chargement, au retour sur l'onglet et à la restauration depuis le cache avant/arrière.
  - Dès que l'onglet est quitté, ses données sont **voilées** : masquées et inertes, sans être détruites.
  - Elles ne réapparaissent qu'une fois l'identité confirmée.
  - **Même cliente :** son écran revient tel qu'elle l'avait laissé, pagination comprise.
  - **Autre cliente :** les écrans repartent de zéro.
  - **Pas de réponse :** le voile reste, avec « Réessayer ». Ce n'est pas une expiration, et l'ancien écran n'est jamais réexposé.
- **Génération :** chaque identité affichée (connexion, déconnexion, expiration, autre cliente connectée ailleurs) en reçoit une nouvelle.
  - Tous les écrans sont remontés sous cette génération : rien de ce qui a été saisi, ouvert ou lu n'est conservé.
  - Toute réponse à une requête partie sous une génération antérieure est ignorée. Cela vaut aussi pour un 401 tardif, qui ne peut jamais déconnecter la session suivante.
  - Chaque lecture et chaque page de liste vérifient aussi leur clé (établissement, période) : une page tardive n'est jamais ajoutée à une autre liste.
- **Réponses des routes :**
  - **401** sur n'importe quelle lecture : la session est terminée et l'écran revient à la connexion (« Votre session a expiré »). Le cookie n'est pas effacé par cette réponse (§ 3).
  - **404 :** l'interface redemande `GET /me`. Une autorisation retirée fait disparaître l'établissement de l'espace.
  - **Établissement absent du profil :** aucune requête n'est faite pour lui. La sécurité reste celle de l'API.
- **Fin de session :**
  - **Déconnexion :** `DELETE /api/client-hub/session` (ou `?all=true`). Seule une réponse confirmée vide l'écran ; sans réponse, l'écran dit que la déconnexion n'est pas confirmée.
  - **Autres onglets :** prévenus par `BroadcastChannel` (`client-hub-session`).
  - **Expiration :** l'instant de fin de la session (7 jours) ferme l'écran à l'heure dite.

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
- **Fin de session :** `GET /me` ne renvoie pas `expiresAt`. Après un rechargement, l'interface ne connaît la fin de session qu'au premier 401.
- **Identité des réponses :** les routes de lecture ne renvoient pas l'identité de la session qui a répondu. Deux onglets dont l'un connecte une autre cliente sont donc resynchronisés par `BroadcastChannel` et au retour sur l'onglet, pas réponse par réponse.
