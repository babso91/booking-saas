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

| Événement                                               | Email mis en file                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réservation publique                                    | `booking_confirmation` (existant), puis `appointment_reminder`.                                                                                                                                                                                                                                    |
| Rendez-vous créé par la professionnelle                 | `appointment_reminder` uniquement (comme avant, pas de confirmation).                                                                                                                                                                                                                              |
| Rendez-vous confirmé déplacé, ou prestation changée     | Ancien rappel annulé (`rescheduled`) et nouveau rappel. `appointment_changed`, **sauf** si la confirmation n'est pas encore partie : elle est rendue au moment de l'envoi, donc elle donne déjà les nouvelles informations. Une modification remplace la précédente encore en file (`superseded`). |
| Rendez-vous futur annulé                                | Confirmation, rappel et modification en file annulés (`appointment_cancelled`), et `appointment_cancelled` mis en file.                                                                                                                                                                            |
| Terminé ou absente (`completed`, `no_show`)             | Emails en file annulés (`appointment_closed`), sans email.                                                                                                                                                                                                                                         |
| Rendez-vous attribué à une autre cliente                | Emails en file pour l'ancienne adresse annulés (`recipient_changed`), rappel pour la nouvelle. Pas de « modification » à une cliente qui n'a jamais reçu de confirmation.                                                                                                                          |
| Modification sans effet pour la cliente (note interne…) | Rien.                                                                                                                                                                                                                                                                                              |

- **Rappel :** la veille du rendez-vous, à **18 h 00 à l'heure de l'établissement**.
  - Calculé par PostgreSQL (`private.email_reminder_at`), changements d'heure compris :
    - un 18 h répété prend sa première occurrence ;
    - un 18 h sauté prend la lecture de PostgreSQL, juste après le saut.
  - Il n'est mis en file que si ce moment est encore à venir. Un rendez-vous pris après 18 h pour le lendemain n'a que sa confirmation.
  - Si l'établissement change de fuseau, le rappel suit le nouveau fuseau au moment du claim.
  - Il n'est plus envoyé à moins d'une heure du rendez-vous (`reminder_too_late`).
- **Destinataire :** toujours l'adresse **du rendez-vous** (`client_email_snapshot`), jamais celle de la fiche modifiée depuis. Les emails en file gardent leur destinataire (contrat CRM, `CRM_CLIENT_MANAGEMENT.md`).
- **Sans email :** une cliente sans adresse ne reçoit rien.
- **Déduplication :** `dedupe_key` unique par établissement.
  - `booking_confirmation:<rdv>` ;
  - `appointment_reminder:<rdv>:v<version>` ;
  - `appointment_changed:<rdv>:v<version>` ;
  - `appointment_cancelled:<rdv>`.
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
2. Juste avant chaque envoi, `email_outbox_verify` revérifie l'email. Un rendez-vous annulé entre le claim et l'envoi n'est donc pas rappelé : l'email et sa tentative passent à `cancelled`.
3. Envoi par le transport : délai de 15 s, et clé d'idempotence = id de l'email.
4. `email_outbox_complete` ou `email_outbox_fail`, en compare-and-set sur le claim. Un worker en retard, dont le bail a expiré et que quelqu'un d'autre a repris, n'écrit rien.
5. Le budget est de 45 s par exécution. Ce qui est revendiqué mais pas tenté est rendu (`email_outbox_release`), sans compter de tentative.

**Erreurs :**

- **Temporaire** (réseau, délai dépassé, 408, 409, 429, 5xx, 401/403) : nouvel essai.
  - Délais successifs : 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, puis 12 h.
  - **8 tentatives au plus**, puis `failed` (`attempts_exhausted` si la limite est atteinte au claim).
  - Un 401/403 est traité comme temporaire : une clé erronée se corrige par configuration, sans perdre les emails entre-temps.
- **Permanente** (autre 4xx : message refusé) : `failed` immédiatement.

**Plantage :** un worker qui meurt laisse son bail expirer. L'email est revendiqué de nouveau, la tentative interrompue est notée `lease_expired`, et la même clé d'idempotence est réutilisée.

**Fraîcheur :** une confirmation, une modification ou une annulation n'est plus envoyée **48 h** après sa mise en file (`expired`), ni une fois le rendez-vous passé. Un worker arrêté plusieurs jours n'envoie donc pas de nouvelles périmées.

**Volume :** au plus **300 tentatives par établissement sur 24 h glissantes**. Au-delà, ses emails attendent, sans être perdus ni annulés. Une professionnelle, ou quelqu'un qui réserve avec des adresses choisies, ne peut donc pas utiliser la plateforme pour des envois de masse.

**Garantie de livraison : au moins une fois, pas exactement une fois.**

- Si un worker plante après que le fournisseur a accepté le message, mais avant de l'enregistrer, le message est soumis de nouveau.
- La clé d'idempotence (l'id de l'email) supprime ce doublon chez les fournisseurs qui l'honorent : Resend pendant 24 h, Mailpit non.
- Des workers concurrents ne tentent jamais deux fois **le même claim** (testé sous contention).

## 4. Historique et statuts

- `email_events` :
  - `status` ;
  - `attempt_count` ;
  - `last_attempt_at` ;
  - `next_attempt_at` (prochain essai après une erreur temporaire) ;
  - `sent_at` ;
  - `provider_message_id` ;
  - `last_error`.
- `last_error` ne contient **que des codes stables** (`^[a-z0-9_]{1,64}$`, imposé par la base pour toute nouvelle écriture) :
  - échecs : `provider_unavailable`, `provider_timeout`, `provider_rejected_422`, `invalid_recipient`, `attempts_exhausted`…
  - annulations : `appointment_cancelled`, `appointment_closed`, `rescheduled`, `superseded`, `recipient_changed`, `expired`, `appointment_past`, `reminder_too_late`.
- `public.email_delivery_attempts` : une ligne par tentative.
  - Colonnes : numéro, début, fin, `outcome` (`sent`, `retry`, `failed`, `lease_expired`, `cancelled`), code d'erreur, id du message chez le fournisseur.
  - Elle ne contient ni destinataire, ni sujet, ni contenu.
  - Elle est lisible par les membres de l'établissement (RLS) et écrite uniquement par les fonctions du worker.

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

- **Fonctions du worker** (`email_outbox_claim`, `_verify`, `_complete`, `_fail`, `_release`) : exécutables par `service_role` uniquement. Le cœur `private.email_outbox_claim_at` n'est exécutable par aucun rôle d'API (testé).
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
- **Journaux** (`logEmail`) : identifiants, type, statut, code et compteurs uniquement. Jamais une adresse, un sujet, un contenu, une réponse du fournisseur ni une clé (testé). Les réponses d'erreur des fournisseurs ne sont jamais lues.
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

  | Code(s)                                                          | Libellé                                  |
  | ---------------------------------------------------------------- | ---------------------------------------- |
  | `appointment_cancelled`                                          | « Non envoyé : rendez-vous annulé »      |
  | `rescheduled`, `superseded`                                      | « Remplacé par un email plus récent »    |
  | `recipient_changed`                                              | « Non envoyé : cliente changée »         |
  | `expired`, `appointment_past`, `reminder_too_late`               | « Non envoyé : trop tard »               |
  | `provider_*` (en `pending`)                                      | « Nouvel essai prévu »                   |
  | `invalid_recipient`, `provider_rejected_*`, `attempts_exhausted` | « Échec : adresse refusée » ou « Échec » |

- **Historique détaillé :** `email_delivery_attempts` filtré par `email_event_id`.
- **Libellés de type :** une seule table de libellés, réutilisée par la timeline CRM.

## 9. Limites et suites

- **Pas de lien d'annulation ni de modification pour la cliente.** S'il en existe un plus tard, il faudra :
  - un jeton aléatoire à usage unique, stocké seulement sous forme d'empreinte ;
  - lié au rendez-vous et à son adresse ;
  - expirant au début du rendez-vous ;
  - une page qui demande confirmation (jamais d'action sur un simple GET, pour éviter les préchargeurs des messageries).
- **Pas de webhook de délivrabilité** (rebonds, plaintes) : `/api/webhooks/resend` est prévu par l'architecture, non livré.
- **Fenêtre résiduelle :** une annulation validée pendant l'appel au fournisseur lui-même (au plus 15 s) n'est pas vue. L'email part, puis l'annulation.
- **Pas de vérification de l'adresse saisie** à la réservation : quelqu'un peut réserver avec l'adresse d'un tiers, qui reçoit alors la confirmation. Cette réception est bornée par les limites de la réservation publique et le plafond de 300 tentatives par établissement et par jour.
- **Fidélisation, réactivation, Client Hub :** ajouter un type à `private.email_deliverable_types()`, son producteur et son modèle. Le worker, l'historique, les reprises et la sécurité sont réutilisés tels quels.
- **Heure du rappel :** fixe (18 h). Un réglage par établissement pourra s'ajouter dans `business_settings`.
