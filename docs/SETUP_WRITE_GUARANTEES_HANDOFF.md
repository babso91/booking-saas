# Passation backend — garanties d'écriture des prestations et des horaires

Ces deux garanties ont été repérées dans la PR #20 (écrans des prestations et des horaires). Elles demandent une évolution du contrat serveur : une migration, et des entrées ou des erreurs nouvelles. Elles ne sont donc pas faites côté interface. Les écrans de la PR #20 restent corrects sans elles. Leurs protections côté client sont décrites plus bas : elles réduisent les risques sans les exclure.

Les défauts sont reproduits contre PostgreSQL réel dans `tests/integration/professional-setup-concurrency.test.ts`, sous forme de tests `it.fails` :

- chacun énonce le comportement attendu ;
- il échoue aujourd'hui, donc Vitest le compte comme réussi ;
- il passera quand la garantie sera livrée ; Vitest le signalera alors en échec, et il faudra le convertir en `it`.

## 1. Création de prestation idempotente

**Constat.**

- `createServiceAction` (`insert into public.services`) ne porte aucune clé de requête.
- `services` n'a pas d'autre contrainte d'unicité que `(id, business_id)`, et c'est voulu : deux prestations du même nom sont permises.

**Défaut.** Une réponse se perd après le commit (la création est faite), puis la professionnelle réessaie : une seconde prestation est créée. Le serveur ne peut pas distinguer un nouvel essai d'une création volontaire.

**Gravité.** Faible à moyenne. Un doublon visible apparaît dans la liste et dans l'agenda. Il se supprime à la main tant qu'il n'est pas réservé.

**Protection actuelle (client, partielle).** Après une réponse perdue, l'écran relit la liste avant tout nouvel envoi. Une prestation identique apparue entre-temps est reconnue comme créée. Une écriture encore en cours au moment de la relecture n'est pas vue.

**Proposition**, sur le modèle de `crm_create_client` (`CRM_CLIENT_MANAGEMENT.md`, « Création idempotente ») :

- **Migration :**
  - `services.creation_request_id uuid` (null pour l'historique), avec `unique (business_id, creation_request_id)` ;
  - une empreinte de la commande canonique (nom normalisé, description, durée, prix).
- **Fonction `public.crm_create_service`** (ou `create_service`), `SECURITY INVOKER`, avec `is_business_member` :
  - `insert … on conflict do nothing` ;
  - même requête et même commande : `{ status: "existing", service_id }` ;
  - même requête et autre commande : `idempotency_conflict`.
- **Action :** `createServiceSchema.requestId: z.uuid()`, requis pour l'UI, optionnel le temps de la transition.
- **UI, après livraison :**
  - une clé par commande (`requestKeyFor`, déjà utilisé par l'agenda et le CRM) ;
  - la relecture de réconciliation est retirée.
- **Test qui doit passer :** « a retry of the same creation request never writes a second service ».
- **À conserver :** « two services with the same name can be created on purpose ».

## 2. Version des prestations

**Constat.** `updateServiceAction` envoie seulement les champs modifiés, sans aucune version.

**Défaut reproduit.** Deux sessions modifient le **même champ** : la dernière écriture remplace l'autre sans le dire. Des champs différents survivent tous les deux, et c'est testé.

**Gravité.** Faible en V1, où une activité n'a qu'une professionnelle : il faut deux appareils ouverts sur le même formulaire. Mais c'est silencieux.

**Proposition, sans nouvelle architecture :**

- **Migration :** `services.version integer not null default 1`, incrémentée par le trigger existant `private.bump_version`, comme pour `clients` et `appointments`.
- **Action :** `updateServiceSchema.expectedVersion`, comparé dans le `update … where version = $expected` ; 0 ligne donne `not_found` ou `stale_service` selon que la ligne existe.
- **Code d'erreur :** `stale_service` (409), ajouté à `AppErrorCode` et à `error-copy.ts`.
- **`setServiceActiveAction` :** `expectedVersion` facultatif. Activer ou désactiver est idempotent par valeur.
- **UI, après livraison :** `ServiceDto.version` est envoyé à l'édition, et `stale_service` mène à la comparaison, comme `stale_client` dans le CRM.
- **Variante sans migration :** `updated_at` est déjà tenu par le trigger `set_updated_at`, donc il pourrait servir de version. C'est moins net qu'un entier : précision à la microseconde, et sémantique « date ».

## 3. Version des horaires hebdomadaires

**Constat.** `replace_business_hours(p_business_id, p_hours)` remplace la semaine entière, sans version.

**Défaut reproduit.** Deux enregistrements concurrents : le dernier remplace la semaine de l'autre.

**Protection actuelle (client, partielle).** L'écran relit les horaires juste avant d'enregistrer. Un formulaire périmé est détecté, et la professionnelle compare puis choisit. Il reste une fenêtre de quelques millisecondes entre cette relecture et l'écriture.

**Gravité.** Très faible (la fenêtre est très courte), mais la garantie n'est pas formelle.

**Proposition :**

- **Migration :** `business_settings.hours_version integer not null default 1`.
- **Fonction :** `replace_business_hours` prend `p_expected_version` et verrouille la ligne de `business_settings` (`FOR UPDATE`, dans l'ordre de verrous existant de `schedule_lock_order_and_isolation`). Elle compare, lève `stale_business_hours` sinon, puis incrémente la version.
- **Actions :** `listBusinessHoursAction` renvoie `{ version, hours }`, et `replaceBusinessHoursAction` accepte `expectedVersion`.
- **UI, après livraison :** la relecture avant enregistrement est remplacée par la version. La comparaison et le choix existent déjà.

## Ordre conseillé

1. Les versions (2 et 3). Elles sont simples, sur des motifs existants, et l'UI de comparaison est prête.
2. L'idempotence de la création (1). Elle demande une migration, une fonction et une empreinte.

Les trois peuvent faire une seule PR backend, suivie d'une petite PR d'interface.
