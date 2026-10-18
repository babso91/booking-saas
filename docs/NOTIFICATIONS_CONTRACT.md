# Emails transactionnels et rappels — contrat

Emails envoyés aux clientes au sujet de leur rendez-vous : confirmation, rappel la veille, modification et annulation.

- **Migration :** `supabase/migrations/20261019090000_email_notifications.sql`.
- **Code :**
  - `src/features/notifications/` (worker, modèles, transports) ;
  - `src/app/api/cron/emails/route.ts` (tâche périodique) ;
  - `src/lib/cron-auth.ts` (secret des tâches, partagé avec `/api/cron/calendar`).
- **Tests :**
  - `tests/integration/email-notifications.test.ts` (PostgreSQL réel, Mailpit) ;
  - `tests/upgrade/email-notifications.test.ts` ;
  - tests unitaires dans `src/features/notifications/` et `src/lib/env/email-env.test.ts`.

**État :** le système est prêt côté application, mais **rien n'est envoyé tant qu'aucun transport n'est configuré** (`EMAIL_TRANSPORT`, § 7) et que la tâche périodique n'est pas planifiée. En attendant, les emails restent dans l'outbox, sans perte (dans la limite de fraîcheur du § 3).

## 1. Ce qui existait, et qui est réutilisé

| Élément                                                                                              | Rôle                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.email_events` (fondation)                                                                    | L'outbox : une ligne par email logique, `unique (business_id, dedupe_key)`, statuts `pending`, `processing`, `sent`, `failed`, `cancelled`, lecture par les membres sous RLS. Aucune seconde file n'est créée. |
| Types `booking_confirmation`, `appointment_reminder`, `appointment_changed`, `appointment_cancelled` | Déjà dans l'enum `email_event_type`. Les types de fidélité et de réactivation restent réservés (§ 9).                                                                                                          |
| Confirmation mise en file par `create_public_booking`                                                | Inchangé : la réservation publique écrit sa confirmation dans sa propre transaction.                                                                                                                           |
| Instantanés du rendez-vous                                                                           | Prestation, durée, prix, devise et contact (`client_*_snapshot`) : l'email décrit le rendez-vous tel qu'il est, à l'adresse qu'il porte.                                                                       |
| Modèle du miroir Google Calendar                                                                     | Un trigger sur `appointments` (tous les chemins d'écriture), puis des workers qui revendiquent avec un bail et écrivent par compare-and-set.                                                                   |
| `/api/cron/*` et `CRON_SECRET`                                                                       | Même authentification que `/api/cron/calendar` (comparaison en temps constant).                                                                                                                                |
| Mailpit (stack Supabase locale, CI)                                                                  | Transport local : rien ne quitte la machine.                                                                                                                                                                   |
| Resend                                                                                               | Fournisseur retenu par `ARCHITECTURE.md`. Le transport est écrit mais **inactif** sans configuration explicite.                                                                                                |

## 2. Quels emails, et quand

Un trigger sur `appointments` (`private.queue_appointment_notifications`) s'applique à **tous** les chemins d'écriture : réservation publique, agenda, écriture directe.

| Événement                                                                                                                 | Email mis en file                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réservation publique                                                                                                      | `booking_confirmation` (existant), puis `appointment_reminder`.                                                                                                                                                                                                                                                                                                                                                                                     |
| Rendez-vous créé par la professionnelle                                                                                   | `appointment_reminder` uniquement (comme avant, pas de confirmation).                                                                                                                                                                                                                                                                                                                                                                               |
| Rendez-vous confirmé déplacé, ou dont la prestation, la durée, le prix ou la devise changent (instantanés du rendez-vous) | Si l'heure ou la prestation change : ancien rappel annulé (`rescheduled`) et nouveau rappel. `appointment_changed` **si la cliente connaît le rendez-vous** (voir ci-dessous). Il remplace une confirmation pas encore partie (`superseded`) : un seul email, avec les informations à jour. Sinon, l'email pas encore transmis donne directement les nouvelles informations. Une modification remplace la précédente encore en file (`superseded`). |
| Rendez-vous futur annulé                                                                                                  | Confirmation, rappel et modification en file annulés (`appointment_cancelled`). `appointment_cancelled` mis en file **si la cliente connaît le rendez-vous**.                                                                                                                                                                                                                                                                                       |
| Terminé ou absente (`completed`, `no_show`)                                                                               | Emails en file annulés (`appointment_closed`), sans email.                                                                                                                                                                                                                                                                                                                                                                                          |
| Rendez-vous attribué à une autre cliente                                                                                  | Emails en file pour l'ancienne adresse annulés (`recipient_changed`), rappel pour la nouvelle. Pas de « modification » à une cliente qui n'a jamais reçu de confirmation.                                                                                                                                                                                                                                                                           |
| Modification sans effet pour la cliente (note interne…)                                                                   | Rien.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

- **« La cliente connaît le rendez-vous »** (`private.appointment_contact_informed`), à son adresse actuelle, dans deux cas :
  - **elle l'a réservé en ligne.** La page de réservation le lui a affiché confirmé immédiatement, quel que soit le sort de l'email de confirmation. Seule la réservation publique met une `booking_confirmation` en file, dans la transaction qui crée le rendez-vous et à l'adresse saisie ;
  - **ou un email de ce rendez-vous** lui a été envoyé (`sent`), ou au moins transmis au fournisseur (`first_submitted_at`), même si la réponse a été perdue. `first_submitted_at` est posé sous un verrou sur le rendez-vous, avant tout appel au fournisseur (`email_outbox_prepare`) : la réponse « non » est donc fiable.
- **Conséquences :**
  - une réservation publique annulée, même avant le départ de sa confirmation, reçoit l'annulation. La confirmation en attente n'est jamais envoyée ;
  - une réservation publique déplacée avant le départ de sa confirmation reçoit un seul email « Rendez-vous modifié », avec toutes les nouvelles informations. La confirmation est remplacée (`superseded`), y compris si un worker l'avait déjà revendiquée ;
  - les emails d'annulation et de modification se lisent seuls : établissement, prestation, date, heure et durée (et prix pour une modification), sans supposer que la confirmation a été reçue.
- **Rendez-vous saisi par la professionnelle :**
  - il ne reçoit une modification ou une annulation que si un email de ce rendez-vous a pu partir (en pratique, le rappel de la veille) ;
  - sinon, la plateforme ne l'a jamais annoncé à la cliente : c'est la professionnelle qui l'a informée, à sa façon ;
  - recommandation pour la suite (non implémentée) : une option « Prévenir la cliente par email » à la création et à l'annulation dans l'agenda. La professionnelle décide, plutôt qu'une règle implicite.
- **Rappel :** la veille du rendez-vous, à **18 h 00 à l'heure de l'établissement**.
  - Calculé par PostgreSQL (`private.email_reminder_at`), changements d'heure compris :
    - un 18 h répété prend sa première occurrence ;
    - un 18 h sauté prend la lecture de PostgreSQL, juste après le saut.
  - Il n'est mis en file que si ce moment est encore à venir. Un rendez-vous pris après 18 h pour le lendemain n'a que sa confirmation.
  - **Changement de fuseau :** un trigger sur `businesses` recale, dans la même transaction, tous les rappels **en attente** de l'établissement à 18 h la veille dans le nouveau fuseau, que le moment avance ou recule (changements d'heure compris). Le claim ne s'appuie jamais sur l'ancien moment.
    - Un moment déjà passé est dû aussitôt, sauf à moins d'une heure du rendez-vous (`reminder_too_late`).
    - Un rappel en nouvel essai garde son délai d'attente : il n'est dû qu'au plus tard des deux moments, son heure de rappel (`scheduled_for`) et la fin de l'attente (`next_attempt_at`). Le changement de fuseau ne contourne ni l'un ni l'autre.
    - Un rappel déjà revendiqué est recalé par `email_outbox_prepare` s'il tombe désormais plus tard : il n'est pas envoyé en avance.
    - Les rappels annulés ou envoyés ne bougent pas, et aucun rappel n'est créé.
  - Il n'est plus envoyé à moins d'une heure du rendez-vous (`reminder_too_late`).
- **Destinataire :** toujours l'adresse **du rendez-vous** (`client_email_snapshot`), jamais celle de la fiche modifiée depuis. Les emails en file gardent leur destinataire (contrat CRM, `CRM_CLIENT_MANAGEMENT.md`).
- **Sans email :** une cliente sans adresse ne reçoit rien.
- **Déduplication :** `dedupe_key` unique par établissement.
  - `booking_confirmation:<rdv>` ;
  - `appointment_reminder:<rdv>:v<version>` ;
  - `appointment_changed:<rdv>:v<version>` ;
  - `appointment_cancelled:<rdv>`. Une seule annulation par rendez-vous suffit, car `cancelled` est un état terminal :
    - `agenda_set_appointment_status`, seul écrivain du statut, n'autorise aucune transition depuis `cancelled` ;
    - les membres n'ont aucun droit d'écriture directe sur `appointments` ;
    - aucun code serveur ne modifie le statut autrement (testé).
  - Une réservation rejouée ne met rien de plus en file.

## 3. Le worker

`runEmailOutbox` (`src/features/notifications/data/worker.ts`) est appelé par :

- `GET|POST /api/cron/emails`, avec `Authorization: Bearer $CRON_SECRET`. C'est le chemin durable, à planifier toutes les 5 minutes ;
- un déclenchement au mieux, après la réponse (`after`), pour l'établissement concerné, à la suite d'une réservation ou d'une modification ou annulation dans l'agenda. Il traite au plus 5 emails et ne retarde ni ne fait jamais échouer la requête.

**Fonctionnement, par lot :**

1. `email_outbox_claim` (service role uniquement) choisit les emails dus.
   - Au plus 5 par établissement et par lot : un établissement chargé n'affame pas les autres.
   - Chaque ligne est verrouillée (`FOR UPDATE SKIP LOCKED`), puis **revérifiée sous le verrou**.
   - L'email est revalidé contre le rendez-vous **actuel**. S'il ne s'applique plus, il est annulé avec un code (§ 4). Un destinataire invalide le fait échouer (`invalid_recipient`).
   - Le claim renvoie les données du modèle, lues à cet instant : jamais un payload périmé.
   - Bail de 120 s, avec `attempt_count + 1` et une ligne d'historique.
2. Le message est rendu par le worker, sauf s'il a déjà été transmis au fournisseur : le message figé est alors renvoyé tel quel, sans nouveau rendu.
   - Un échec du modèle est déterministe : l'email est abandonné aussitôt (`render_failed`), sans épuiser ses tentatives et sans rien journaliser sur la cliente.
3. Juste avant l'appel au fournisseur, `email_outbox_prepare` verrouille le rendez-vous (`FOR SHARE`) et revérifie l'email :
   - **ne s'applique plus** (rendez-vous annulé, déplacé, autre destinataire, ou message figé dont les informations ont changé) : annulé, jamais envoyé. Les informations comparées sont les instantanés du rendez-vous : heure, prestation, durée, prix, devise et destinataire (`private.email_fingerprint`). Un changement du catalogue ne modifie pas ces instantanés : il ne change rien aux emails ;
   - **jamais transmis** : le message est **figé** (`private.email_renderings`) puis envoyé. S'il a été rendu d'après une version plus ancienne du rendez-vous, l'email est rendu au claim suivant (`rerender`, sans compter de tentative) ;
   - **déjà transmis** (réponse perdue, reprise) : le message figé est renvoyé **à l'identique**, sous la même clé d'idempotence ;
   - au-delà de 23 h après la première transmission (la clé reste 24 h chez Resend), il n'est **plus renvoyé** et sa livraison reste **non confirmée** (`failed`, `delivery_unconfirmed`).
4. Envoi par le transport : délai de 15 s, clé d'idempotence = id de l'email, toujours avec le même message.
5. `email_outbox_complete` ou `email_outbox_fail`, en compare-and-set sur le claim. Un worker en retard, dont le bail a expiré et que quelqu'un d'autre a repris, n'écrit rien.
6. Le budget est de 45 s par exécution. Ce qui est revendiqué mais pas tenté est rendu (`email_outbox_release`), sans compter de tentative.

**Erreurs :**

- **Temporaire** (réseau, délai dépassé, 408, 429, 5xx, 401/403, 409 `concurrent_idempotent_requests` ou `resource_locked`) : nouvel essai, avec le même message figé.
  - Délais successifs : 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, puis 12 h.
  - **8 tentatives au plus**, puis `failed` (`attempts_exhausted` si la limite est atteinte au claim).
  - Un 401/403 est traité comme temporaire : une clé erronée se corrige par configuration, sans perdre les emails entre-temps.
- **Permanente** (autre 4xx : message refusé ; échec du modèle) : `failed` immédiatement.
- **Livraison inconnue** (409 `invalid_idempotent_request` : la clé est déjà liée à une autre requête) :
  - l'email n'est ni renvoyé (une nouvelle clé pourrait le délivrer deux fois), ni déclaré non envoyé ;
  - il passe en `failed` avec `last_error = delivery_unconfirmed`, et sa tentative en `outcome = unconfirmed` ;
  - la cliente a pu le recevoir : une annulation ou une modification ultérieure lui est donc notifiée.
  - Avec le message figé, ce cas ne devrait pas se produire ; s'il survient, il est visible et n'est jamais masqué.

**Plantage :** un worker qui meurt laisse son bail expirer. L'email est revendiqué de nouveau, la tentative interrompue est notée `lease_expired`, et la même clé d'idempotence est réutilisée.

**Fraîcheur :** une confirmation, une modification ou une annulation n'est plus envoyée **48 h** après sa mise en file (`expired`), ni une fois le rendez-vous passé. Un worker arrêté plusieurs jours n'envoie donc pas de nouvelles périmées.

**Volume :** au plus **300 tentatives par établissement sur 24 h glissantes**, appliquées atomiquement.

- Le claim prend un verrou transactionnel par établissement, dans un ordre fixe, puis compte les tentatives sous ce verrou. Des claims concurrents du même établissement se succèdent donc : ils ne dépassent pas la limite (testé sous concurrence). Ceux des autres établissements n'attendent pas.
- Au-delà de la limite, les emails attendent, sans être perdus ni annulés. Une professionnelle, ou quelqu'un qui réserve avec des adresses choisies, ne peut donc pas utiliser la plateforme pour des envois de masse.

**Garantie de livraison : au moins une fois, pas exactement une fois.**

- Si un worker plante après que le fournisseur a accepté le message, mais avant de l'enregistrer, le **même** message est soumis de nouveau sous la même clé.
- La clé d'idempotence (l'id de l'email) supprime ce doublon chez les fournisseurs qui l'honorent : Resend pendant 24 h, Mailpit non. Au-delà de cette fenêtre, rien n'est renvoyé (`delivery_unconfirmed`).
- Des workers concurrents ne tentent jamais deux fois **le même claim** (testé sous contention).

## 4. Historique et statuts

- `email_events` :
  - `status` ;
  - `attempt_count` ;
  - `last_attempt_at` ;
  - `next_attempt_at` (prochain essai après une erreur temporaire ; un email est dû au plus tard de `scheduled_for` et `next_attempt_at`) ;
  - `first_submitted_at` (première transmission au fournisseur ; nul = la cliente n'a rien pu recevoir) ;
  - `sent_at` ;
  - `provider_message_id` ;
  - `last_error`.
- `last_error` ne contient **que des codes stables** (`^[a-z0-9_]{1,64}$`, imposé par la base pour toute nouvelle écriture) :
  - échecs : `provider_unavailable`, `provider_timeout`, `provider_rejected_422`, `invalid_recipient`, `attempts_exhausted`, `render_failed`, `invalid_message`…
  - livraison inconnue : `delivery_unconfirmed` (la tentative porte `provider_idempotency_conflict` ou `idempotency_window_elapsed`) ;
  - annulations : `appointment_cancelled`, `appointment_closed`, `rescheduled`, `superseded`, `recipient_changed`, `expired`, `appointment_past`, `reminder_too_late`.
- `public.email_delivery_attempts` : une ligne par tentative.
  - Colonnes : numéro, début, fin, `outcome` (`sent`, `retry`, `failed`, `lease_expired`, `cancelled`, `unconfirmed`), code d'erreur, id du message chez le fournisseur.
  - Elle ne contient ni destinataire, ni sujet, ni contenu.
  - Elle est lisible par les membres de l'établissement (RLS) et écrite uniquement par les fonctions du worker.
- `private.email_renderings` : le message figé (destinataire, expéditeur, sujet, texte, HTML) et les informations du rendez-vous qu'il énonce.
  - Elle n'est lisible par aucun rôle d'API.
  - Le message est supprimé dès que l'email est final (`sent`, `failed`, `cancelled`).

## 5. Contenu des emails

- **Langue et voix :** en français, en vouvoyant, comme la page de réservation.
- **Format :** texte et HTML. Chaque valeur est échappée dans le HTML et ramenée sur une ligne dans le sujet.
- **Contenu :**
  - établissement ;
  - prestation ;
  - date et heure (heure murale fournie par PostgreSQL) ;
  - durée ;
  - prix (sauf pour une annulation) ;
  - adresse de l'établissement si elle est renseignée ;
  - mention du fuseau ;
  - lien vers la page publique `/b/<slug>`.
- **Réponses :** `Reply-To` est l'adresse de contact de l'établissement. Pour modifier ou annuler, l'email invite à contacter l'établissement, par téléphone s'il est renseigné ou en répondant.
- **Aucun lien d'annulation :** il n'en existe pas encore (§ 9). Aucun lien de ce type n'est écrit ni promis.
- **Données exclues :** les notes internes, les notes CRM, les autres rendez-vous et les données des autres clientes ne sont jamais lues par le claim (testé).

## 6. Sécurité

- **Fonctions du worker** (`email_outbox_claim`, `_prepare`, `_complete`, `_fail`, `_release`) : exécutables par `service_role` uniquement. Le cœur `private.email_outbox_claim_at` n'est exécutable par aucun rôle d'API (testé).
- **Outbox :**
  - les membres la lisent sous RLS ;
  - ils ne peuvent ni insérer (aucun envoi non autorisé), ni modifier (aucun email annulé ou envoyé ne redevient envoyable), ni supprimer ;
  - les privilèges `insert/update/delete` sont retirés à `anon` et `authenticated`, en plus de l'absence de politique.
- **Isolation des établissements :** l'historique des tentatives est sous la même RLS. Le claim lit le rendez-vous par `(id, business_id)`, et le déclenchement après réservation est limité à l'établissement concerné (testé).
- **Validation du destinataire :**
  - dans PostgreSQL : une seule adresse, au plus 254 caractères, sans espace, caractère de contrôle, `<>,;"` ;
  - de nouveau dans le worker, avant tout envoi.
  - Une adresse portant une injection d'en-tête (`\r\nBcc:`) n'atteint jamais le transport (testé).
- **Expéditeur** (`EMAIL_FROM`) : une seule adresse, sur une ligne, sinon la livraison reste désactivée.
- **Journaux** (`logEmail`) : identifiants, type, statut, code et compteurs uniquement. Jamais une adresse, un sujet, un contenu, une réponse du fournisseur ni une clé (testé). D'une réponse d'erreur, seul le type d'un 409 (`name`) est lu, pour distinguer les conflits d'idempotence ; le reste n'est jamais lu.
- **Tâche périodique :** sans `CRON_SECRET` (32 caractères au moins), chaque appel est refusé (401).
- **Configuration non activable par erreur :** la clé Resend d'exemple (`re_replace_me`) n'active jamais la livraison.

## 7. Configuration des vrais envois (non activée)

| Variable          | Valeur                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `EMAIL_TRANSPORT` | `resend` (production), `mailpit` (local) ou vide (désactivé, par défaut). |
| `EMAIL_FROM`      | `Nom <adresse>` sur un domaine vérifié chez le fournisseur.               |
| `RESEND_API_KEY`  | Clé réelle, `re_…` (jamais versionnée).                                   |
| `MAILPIT_URL`     | Local uniquement ; par défaut `http://127.0.0.1:54324`.                   |
| `CRON_SECRET`     | Déjà requis par `/api/cron/calendar`.                                     |

**Pour activer les vrais envois** (hors de cette PR, avec accord) :

1. **Compte Resend :** l'offre gratuite suffit au démarrage, à vérifier au moment de l'activation ; aucun service payant n'est ajouté ici.
2. **Domaine d'envoi :** vérifié (SPF, DKIM).
3. **Variables :** les trois variables ci-dessus.
4. **Planification :** appel de `/api/cron/emails` toutes les 5 minutes, par l'ordonnanceur de l'infrastructure (tâche planifiée de l'hôte ou pg_cron et pg_net s'ils existent), avec le secret.
5. **Vérification :** sur le staging, avec des adresses fictives.

`EMAIL_TRANSPORT=mailpit` n'envoie rien hors de la machine : il ne faut jamais l'utiliser en production, où les emails seraient marqués « envoyés » sans être reçus.

## 8. Passation pour l'interface (Claude UI)

Aucune interface n'est livrée dans cette PR.

- **Ne rien promettre tant que la livraison n'est pas activée :** la page de confirmation garde « aucun email n'est promis ».
- **Statuts lisibles par un membre** sur `email_events` (et dans la timeline CRM, déjà branchée) : `pending` (en attente ou nouvel essai prévu, voir `next_attempt_at`), `processing`, `sent`, `failed`, `cancelled`, avec le code `last_error`.
- **Libellés proposés pour `last_error`** :

  | Code(s)                                                                                              | Libellé                                  |
  | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
  | `appointment_cancelled`                                                                              | « Non envoyé : rendez-vous annulé »      |
  | `rescheduled`, `superseded`                                                                          | « Remplacé par un email plus récent »    |
  | `recipient_changed`                                                                                  | « Non envoyé : cliente changée »         |
  | `expired`, `appointment_past`, `reminder_too_late`                                                   | « Non envoyé : trop tard »               |
  | `provider_*` (en `pending`)                                                                          | « Nouvel essai prévu »                   |
  | `invalid_recipient`, `provider_rejected_*`, `attempts_exhausted`, `render_failed`, `invalid_message` | « Échec : adresse refusée » ou « Échec » |
  | `delivery_unconfirmed`                                                                               | « Envoi non confirmé : a pu être reçu »  |

- **Historique détaillé :** `email_delivery_attempts` filtré par `email_event_id`.
- **Libellés de type :** une seule table de libellés, réutilisée par la timeline CRM.

## 9. Limites et suites

- **Pas de lien d'annulation ni de modification pour la cliente.** S'il en existe un plus tard, il faudra :
  - un jeton aléatoire à usage unique, stocké seulement sous forme d'empreinte ;
  - lié au rendez-vous et à son adresse ;
  - expirant au début du rendez-vous ;
  - une page qui demande confirmation (jamais d'action sur un simple GET, pour éviter les préchargeurs des messageries).
- **Pas de webhook de délivrabilité** (rebonds, plaintes) : `/api/webhooks/resend` est prévu par l'architecture, non livré.
- **Annulation pendant l'appel au fournisseur :** une annulation validée pendant l'appel lui-même (au plus 15 s) arrive trop tard pour retenir l'email. Comme il a été transmis (`first_submitted_at`), l'annulation est notifiée ensuite.
- **Pas de vérification de l'adresse saisie** à la réservation : quelqu'un peut réserver avec l'adresse d'un tiers, qui reçoit alors la confirmation. Cette réception est bornée par les limites de la réservation publique et le plafond de 300 tentatives par établissement et par jour.
- **Fidélisation, réactivation, Client Hub :** ajouter un type à `private.email_deliverable_types()`, son producteur et son modèle. Le worker, l'historique, les reprises et la sécurité sont réutilisés tels quels.
- **Heure du rappel :** fixe (18 h). Un réglage par établissement pourra s'ajouter dans `business_settings`.

## 10. Observations à trancher plus tard (aucun changement dans cette PR)

- **Réservations tardives sans rappel :** un rendez-vous pris après 18 h la veille (ou le jour même) n'a pas de rappel ; seule sa confirmation part. C'est voulu : un rappel juste après la confirmation ferait doublon. Si le produit veut un rappel quelques heures avant ces rendez-vous-là, il faudra une seconde règle (par exemple « 2 h avant si la veille est passée »).
- **Rappels en attente dans l'historique CRM :** la timeline de la cliente montre chaque ligne `email_events`, y compris un rappel encore `scheduled` pour un rendez-vous à venir. C'est cohérent avec le modèle de lecture (un email existe dès qu'il est mis en file), mais c'est un choix d'interface. Il faudra décider s'il faut masquer les emails futurs, les regrouper ou les présenter comme « prévu le … ».
