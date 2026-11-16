# Domaine personnalisé : contrat servi (R5-02, tranche domaine)

Réponse de Cloud à `docs/SITE_DOMAIN_PROPOSAL.md` (PR #71). Les actions et
`SiteDomainDto` sont servis **tels que proposés**, avec les écarts listés en
fin de document. Migration : `supabase/migrations/20261116130000_site_domains.sql`.

**Rien n'est acheté, aucun DNS n'est écrit, aucun certificat n'est demandé
d'ici.** L'état n'avance que sur des preuves.

## Actions (`src/features/domains-server/actions.ts`, owner seulement)

| Contrat UI | Action                                                      |
| ---------- | ----------------------------------------------------------- |
| `read`     | `readDomainAction()`                                        |
| `request`  | `requestDomainAction({ hostname, requestId })`              |
| `retry`    | `retryDomainAction({ id, expectedGeneration, requestId })`  |
| `detach`   | `detachDomainAction({ id, expectedGeneration, requestId })` |

- **Nom** : le serveur le normalise et le revalide avec la même règle que
  l'écran (`normalizeHostname`). Un seul domaine par établissement : en
  demander un autre remplace l'ancien.
- **Enregistrements à publier :**
  - TXT `_booking-verify.<nom>` = `booking-verify=<valeur>`, une valeur par
    génération ;
  - CNAME `<nom>` → la cible de la plateforme (`SITE_DOMAIN_TARGET`). Un nom
    racine (sans CNAME possible) est accepté s'il résout vers les mêmes
    adresses que la cible.
- **Personne ne bloque un nom sans preuve.** Une demande en attente ne gêne
  personne. Le premier établissement dont la preuve est lue dans le DNS
  obtient le nom, et les autres demandes pour ce nom sont détachées. Ensuite,
  le nom est `domain_taken` pour les autres, jusqu'à ce qu'il soit détaché ou
  perdu (`dns_lost`).
- **Une vérification toutes les 30 secondes au plus** (`rate_limited`).
- **La preuve vaut 7 jours.** À son expiration, `retry` crée une nouvelle
  valeur (génération n + 1) et répond `proof_expired` : l'écran relit et
  affiche la nouvelle valeur.
- **Rejeu** : `request` et `detach` sont rejoués par `requestId`. `retry`
  est une vérification, et la répéter est sans effet de bord.

## États

| État                 | Quand                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `awaiting_dns`       | le défi est créé                                                                                  |
| `error` (+ `reason`) | dernière vérification en échec : `proof_missing`, `proof_mismatch`, `target_mismatch`, `dns_lost` |
| `provisioning_tls`   | la preuve TXT et la cible ont été lues dans le DNS public, et un certificat peut être émis        |
| `active`             | notre sonde HTTPS a répondu sur le nom, pour ce domaine : certificat **et** routage fonctionnent  |
| `detached`           | délié ; le nom est libre, et une nouvelle preuve sera nécessaire                                  |

- **Le vérificateur** est le serveur, jamais le navigateur. Il rend compte
  avec la génération qu'il a vérifiée. Un compte rendu d'une autre
  génération est ignoré, et `retry` sur une génération dépassée répond
  `domain_generation_changed`.
- **L'horloge** (`GET|POST /api/cron/domains`, toutes les heures) revérifie
  les domaines en attente, en cours de certificat ou actifs. Un domaine actif
  qui perd son DNS passe en `error` (`dns_lost`).

## Pour le serveur Hetzner (à brancher avec ton accord)

- **Certificats à la demande (Caddy `on_demand_tls`)** : `ask` vaut
  `https://<app>/api/domains/tls-ask?domain={host}`. La réponse est 200
  seulement pour un nom dont la preuve a été lue. Aucun certificat n'est donc
  possible pour un nom non vérifié.
- **Le point `ask` répond 404 tant que le routage par nom est désactivé** :
  un certificat ne doit jamais servir toute l'application sur son nom.
- **Sonde du vérificateur** : le nom n'est résolu qu'une fois, toutes les
  adresses doivent être publiques (jamais privées, de bouclage, link-local ou
  de métadonnées), et la connexion se fait sur l'adresse résolue, avec le
  certificat vérifié sur le nom. Aucune redirection n'est suivie.
- **Routage par nom** : il est **désactivé par défaut**
  (`SITE_DOMAINS_ENABLED=true` pour l'activer).
  - Une fois activé, une requête sur l'un de ses noms ne sert que sa page
    publique : `/` donne sa page `/b/<slug>`, plus ce dont la page a besoin
    (`/_next`, `/api/public`, `/api/bookings`, la désinscription).
  - Tout le reste répond 404, et jamais l'espace pro. La session n'y est même
    pas rafraîchie, donc aucun cookie n'est posé.
- **Sur son nom**, aucune server action n'est acceptée. Les hôtes de la
  plateforme sont celui de l'app et ceux de `SITE_PLATFORM_HOSTS` (séparés
  par des virgules). Le port et le point final sont ignorés.
- **Sonde** : `GET /api/domains/probe` répond l'id du domaine sur le nom.

## Refus

`domain_taken` (sans dire à qui), `proof_expired`,
`domain_generation_changed`, `domain_unavailable` (pas de cible configurée,
ou domaine inconnu), `validation_error` (nom invalide), `forbidden` (une
admin), `idempotency_conflict`.

## Écarts avec la proposition

1. **Pas d'état `suspended`** : un domaine en échec passe en `error` avec sa
   raison.
2. **Pas de raison `tls_failed` produite en V1** : un certificat qui ne vient
   pas laisse le domaine en `provisioning_tls`, et l'adresse habituelle reste
   servie.
3. **Hors lot** : la PWA et le push.
