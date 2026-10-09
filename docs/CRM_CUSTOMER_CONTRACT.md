# Contrat — domaine client (CRM V1, étape 1)

Ce document définit l'entité client, son identité et son lien aux rendez-vous. Il décrit le backend uniquement : cette étape n'ajoute ni interface CRM, ni métriques, ni fidélité.

Migration : `supabase/migrations/20261012090000_crm_customer_identity.sql`.

## L'entité client

L'entité client existe déjà : c'est `public.clients`. Il n'y a pas de seconde table `customers`.

- **Rattachée à un business.** Un business a N clientes ; une cliente appartient à un seul business (`business_id`, suppression en cascade avec le business).
- **Aucune identité globale.** La même personne qui réserve dans deux business a deux fiches distinctes, jamais reliées.
- **N rendez-vous par cliente.** Chaque rendez-vous référence une cliente de son propre business, via la clé étrangère composite `(client_id, business_id)`. Une écriture qui associerait une cliente d'un autre business est refusée.
- **Suppression non destructive.** Une cliente qui a des rendez-vous ne peut pas être supprimée (clé étrangère sans cascade). L'historique ne disparaît jamais par effet de bord. Aucun workflow de suppression ou d'anonymisation dans cette étape.
- **Extensible.** Les notes privées existent déjà (`internal_notes`). Tags, statistiques et fidélité viendront plus tard, par colonnes ou tables liées à `clients.id`.

### Pas de compte consommateur

Une cliente n'est pas un utilisateur Supabase Auth :

- aucun utilisateur `auth.users` n'est créé ;
- aucun mot de passe, aucun identifiant de connexion ;
- aucune clé étrangère de `clients` vers `auth.users` ;
- la réservation publique ne demande aucune authentification.

## Identité V1 : l'email canonique

L'identité d'une cliente est son email canonique, au sein de son business uniquement.

- **Forme canonique.** Calculée par `private.canonical_email(text)`, dans cet ordre :
  1. **Unicode NFC.** Les écritures canoniquement équivalentes deviennent identiques.
  2. **Espaces périphériques retirés.** Exactement les caractères que retire `String.prototype.trim()` en JavaScript (`WhiteSpace` et `LineTerminator` d'ECMAScript), soit 25 points de code :
     - U+0009 tabulation, U+000A saut de ligne, U+000B tabulation verticale, U+000C saut de page, U+000D retour chariot ;
     - U+0020 espace, U+00A0 espace insécable, U+1680, U+2000 à U+200A, U+202F, U+205F, U+3000 ;
     - U+2028 et U+2029 (séparateurs de ligne et de paragraphe), U+FEFF (BOM).

     La base et le navigateur coupent donc les mêmes caractères. Un test le vérifie sur tous les points de code Unicode. NFC est appliqué d'abord : l'ensemble est stable par NFC (U+2000 et U+2001 deviennent U+2002 et U+2003, qui en font partie).

  3. **Minuscules.**
  4. **Vide → `null`.** Un email vide, ou fait uniquement de ces caractères, donne `null`.
- **Les espaces internes sont conservés.** Un espace à l'intérieur d'une adresse (`lea @example.com`) n'est jamais retiré : l'adresse reste distincte, et les chemins de réservation la refusent comme invalide. U+200B (espace sans chasse) n'est pas un espace pour JavaScript, ni ici.
- **Rien de plus.** Aucune règle floue, aucune IA, aucune règle propre à un fournisseur (les points et `+tag` de Gmail restent significatifs).
- **Pas d'identité par téléphone ni par nom.** Deux emails différents font deux clientes, même avec le même téléphone.

### Une seule source de normalisation

La normalisation appartient à la base de données :

- **Sur chaque écriture de `clients.email`.** Le trigger `clients_canonicalize_email` (BEFORE INSERT/UPDATE) applique `private.canonical_email`, quel que soit le chemin : RPC, écriture directe d'un membre sous RLS, `service_role`.
- **Unicité.** La contrainte existante `unique (business_id, email)` porte donc sur l'email canonique : PostgreSQL garantit une seule cliente par email canonique et par business.
- **Validation navigateur.** Les schémas Zod mettent aussi en minuscules et suppriment les espaces, mais seulement pour afficher des erreurs de champ. Ils ne font jamais autorité.

## Résolution : `private.resolve_client`

Les deux chemins de création utilisent la même fonction, dans la transaction de la réservation, après le verrou de planning :

- la réservation publique (`create_public_booking` → `private.create_public_booking_at`) ;
- la création manuelle d'un rendez-vous dans l'agenda (`agenda_create_appointment`), quand le professionnel saisit une nouvelle cliente.

| Situation                                                                           | Effet                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email inconnu dans ce business                                                      | Nouvelle cliente, créée de façon atomique (`INSERT … ON CONFLICT (business_id, email)`).                                                                                     |
| Email connu, même avec une autre casse, d'autres espaces ou une autre forme Unicode | Fiche existante réutilisée. Seuls le nom de famille et le téléphone **manquants** sont complétés. Une valeur non vide n'est jamais remplacée, et le prénom ne change jamais. |
| Email connu et fiche complète                                                       | Fiche réutilisée telle quelle (aucune écriture, `updated_at` inchangé).                                                                                                      |
| Pas d'email (agenda uniquement ; la réservation publique l'exige)                   | Nouvelle cliente sans email, jamais rapprochée d'une autre par nom ou téléphone.                                                                                             |
| Cliente existante choisie par identifiant (agenda)                                  | Cette fiche, sans modification.                                                                                                                                              |

Les rendez-vous déjà liés ne sont jamais rattachés à une autre cliente automatiquement.

### Confidentialité de la réponse publique

`private.resolve_client` est privée : aucun rôle d'API ne peut l'exécuter. La réponse de la réservation publique a la même forme, que la cliente existe ou non, et ne contient ni identifiant de cliente, ni email. Il n'existe aucune API publique de création, lecture, modification ou suppression de cliente.

### Concurrence et ordre des verrous

- **Même business.** Deux réservations avec le même email sont sérialisées par le verrou de planning. `ON CONFLICT` garantit une seule fiche même sans ce verrou (écriture directe concurrente d'un membre, par exemple).
- **Deux business.** Il s'agit de deux fiches différentes, sans contention.
- **Ordre des verrous** : verrou de planning, puis ligne de la cliente (`FOR NO KEY UPDATE`, compatible avec le `KEY SHARE` des clés étrangères), puis insertion du rendez-vous. Aucun chemin qui détient une ligne de cliente n'attend ensuite le verrou de planning : une modification de fiche par un membre ne touche que les miroirs de calendrier. Il n'y a donc pas de cycle, et des tests vérifient l'attente dans les deux sens.

## Rendez-vous : des instantanés de contact

`appointments.client_first_name_snapshot`, `client_last_name_snapshot`, `client_email_snapshot` et `client_phone_snapshot` enregistrent le contact **tel que soumis** pour ce rendez-vous. Ce sont des archives :

- **La fiche peut diverger.** La fiche cliente peut ensuite changer (nom complété, email corrigé) ; l'instantané ne change pas.
- **Réécriture refusée.** Tant que le rendez-vous reste lié à la même cliente, toute tentative de réécrire l'instantané échoue avec `contact_snapshot_immutable`.
- **Changement de cliente.** Si un professionnel déplace le rendez-vous vers une autre cliente (`agenda_update_appointment`), le rendez-vous prend le contact actuel de cette cliente.
- **Instantané par défaut.** Un chemin qui ne soumet pas de contact (cliente choisie par identifiant, insertion technique) reçoit le contact de la fiche liée (trigger `appointments_snapshot_contact`).
- **Email jamais identité.** L'email de l'instantané est canonique, mais il ne sert jamais d'identité.

Les autres instantanés (prestation, durée, prix, tampon) sont inchangés.

## Reprise de l'historique (migration)

1. **Instantanés.** Chaque rendez-vous existant, quel que soit son statut ou sa date, reçoit le contact de la fiche à laquelle il était lié, lu **avant** toute fusion. Avant cette migration, le contact soumis n'était pas conservé par rendez-vous : la fiche liée en est la meilleure trace. Ce remplissage n'est pas une modification : `version` et `updated_at` sont conservés.
2. **Fusion.** Les fiches d'un même business dont les emails ont la même forme canonique (variantes d'espaces, de casse ou de forme Unicode laissées par des écritures directes) deviennent une seule fiche :
   - **Fiche conservée** : la plus ancienne (`created_at`, puis `id`).
   - **Valeurs non vides** : la fiche conservée garde les siennes. Un nom de famille, un téléphone ou un jeton de fidélité manquant est repris de la fiche la plus récente du groupe qui en a un (`created_at desc`, puis `id desc`).
   - **Notes** : celles des autres fiches sont ajoutées à la suite, de la plus ancienne à la plus récente. Aucune n'est perdue.
   - **Références** : rendez-vous, événements de fidélité, échanges de récompenses et emails passent à la fiche conservée, puis les autres fiches sont supprimées. Chaque ligne d'historique est conservée telle quelle (points, montants, clés d'idempotence, dates) ; seul `client_id` change. Pour un email, `updated_at` enregistre ce changement.
   - **Rendez-vous déplacés** : ils changent de version (un formulaire ouvert avant la migration sera refusé comme périmé). Leur instantané garde le contact d'origine.
   - **Google, sans effet de bord.** La fusion est une opération interne :
     - elle n'inscrit jamais un rendez-vous dans le calendrier sortant (passé, annulé ou futur) ;
     - un miroir existant ne redevient dû que si son titre change, une seule fois et par la même instruction qu'un renommage de fiche. Les prénoms sont comparés tels que Google les affiche : le sérialiseur (`outboundEvent`) applique `String.prototype.trim()`, sans changer la casse ni normaliser l'Unicode. `"Emma "`, `" Emma"` ou `"Emma"` entourés d'espaces insécables donnent le même titre que `"Emma"` ; `"emma"` ou `"Emmy"` donnent un autre titre ;
     - mécanisme : le rattachement est marqué comme fusion pour sa seule transaction (`booking.crm_customer_merge`, `set_config` local, dans un bloc `DO`). Dans ce cas, le trigger `private.record_appointment_mirror` ignore un changement de `client_id` seul. Tout autre changement (horaire, statut, prestation) est enregistré comme avant. La version, `updated_at` et les instantanés suivent les règles habituelles ;
     - ce marqueur ne sort jamais de sa transaction, et aucun rôle d'API ne peut le poser.
     - Les rendez-vous futurs jamais inscrits restent du ressort du backfill sortant habituel.
3. **Emails canoniques.** Les emails stockés passent sous forme canonique ; un email vide devient `null`.

Les business restent indépendants : la même adresse dans un autre business n'est jamais fusionnée.

## Google Calendar

- **Payload sortant inchangé.** Le titre reste « prénom de la fiche — prestation » ; les propriétés privées restent `origin`, `appointmentId` et `revision`. Ni email, ni téléphone, ni identifiant de cliente ne sont envoyés. Un test de non-régression le vérifie pour une cliente qui revient avec une autre orthographe et un téléphone.
- **Aucune cliente créée par l'entrant.** Les événements Google externes sont seulement des périodes occupées ; ils ne créent jamais de cliente.
- **Le titre ne change pas par une réservation.** La résolution ne modifie jamais le prénom d'une fiche.
- **La fusion de l'historique n'exporte rien.** Voir « Reprise de l'historique » : aucun nouveau miroir, et un miroir existant ne redevient dû que si son titre change.

## Sécurité (RLS)

- **Membres.** Un membre lit et modifie uniquement les clientes de ses business (politiques existantes `clients_*_member`). Une lecture ou une écriture vers un autre business ne voit rien ou est refusée.
- **`anon`.** Aucun droit sur la table, aucun accès à `private`.
- **Aucune API publique de cliente.** La seule façon publique de créer ou retrouver une cliente est de réserver.

## Limites connues de la V1

- **Changement d'email.** Une cliente qui change d'email devient une nouvelle fiche (doublon).
- **Email partagé.** Plusieurs personnes qui partagent un email (une famille) forment une seule fiche.
- **Pas de fusion par téléphone ou par nom.** Les fiches sans email ne sont jamais rapprochées.
- **Pas de fusion ou séparation manuelle.** Ce sera une étape ultérieure.
- **Historique approximatif.** Pour les rendez-vous antérieurs à cette migration, l'instantané reflète la fiche à la date de la migration, pas forcément le contact soumis à l'époque.

## Lecture de la relation

L'annuaire, le profil et la timeline de chaque cliente sont décrits dans [`CRM_RELATIONSHIP_READ_MODEL.md`](CRM_RELATIONSHIP_READ_MODEL.md). Ils lisent la fiche **actuelle** dans `public.clients`, et l'**instantané** de contact de chaque rendez-vous dans son historique.
