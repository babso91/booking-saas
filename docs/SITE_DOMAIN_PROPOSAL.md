# Domaine personnalisé — contrat proposé (R5-02, tranche domaine)

Statut : **proposé par l'UI, non implémenté**. L'écran existe
(`src/features/domains/`) et ne tourne que dans `/apercu/domaine`, contre un
serveur en mémoire au DNS scripté. **Aucun domaine n'est acheté, aucun DNS
lu, aucun certificat demandé.** Table `site_domains`, fournisseur DNS/TLS,
routage par Host et politique de cookies/origines restent ceux de Cloud (et
une décision du boss pour tout coût).

Hors de cette tranche : la PWA (manifest, service worker, hors ligne) et
le push.

## Données

```ts
SiteDomainDto = {
  id: string;
  hostname: string;              // normalisé, unique
  state: "awaiting_dns" | "verified" | "provisioning_tls" | "active" | "error" | "suspended" | "detached";
  generation: number;            // chaque nouveau challenge l'incrémente
  records: { type: "TXT" | "CNAME"; name: string; value: string }[];
  proofExpiresAt: string | null;
  fallbackUrl: string;           // toujours servie
  reason: "proof_missing" | "proof_mismatch" | "target_mismatch" | "tls_failed" | "dns_lost" | null;
  checkedAt: string | null;
};
```

## Actions

| Action    | Entrée                              | Effet                                                         |
| --------- | ----------------------------------- | ------------------------------------------------------------- |
| `read`    | —                                   | Le domaine de l'établissement ou `null`                       |
| `request` | `hostname, requestId`               | Crée le challenge (génération n), renvoie les enregistrements |
| `retry`   | `id, expectedGeneration, requestId` | Vérifie maintenant ; preuve expirée → nouveau challenge       |
| `detach`  | `id, expectedGeneration, requestId` | Délie ; aucune propriété transférée sans nouvelle preuve      |

- L'écran normalise le nom (`normalizeHostname`) : minuscules, sans
  schéma, chemin, port ni point final ; jamais une IP. Le serveur
  revalide.
- Une réponse d'une ancienne génération est ignorée
  (`domain_generation_changed`).
- Actif seulement après confirmation du certificat **et** du routage.
- Même `requestId` → même réponse ; l'écran prend un nouvel identifiant à
  chaque vérification répondue, le même après une réponse perdue.

## Refus nommés

| Code                        | Ce que l'écran fait                                        |
| --------------------------- | ---------------------------------------------------------- |
| `domain_taken`              | « Déjà relié à un autre site » (sans dire lequel)          |
| `proof_expired`             | Relit, montre la nouvelle valeur TXT à remplacer           |
| `domain_generation_changed` | Relit, « une nouvelle vérification a été lancée ailleurs » |
| `domain_unavailable`        | Message générique                                          |

## Ce que l'écran ne promet pas

Aucun délai de propagation, aucune disponibilité avant preuve. L'adresse
habituelle (`fallbackUrl`) est affichée à chaque étape.

## Recette couverte côté écran

`salon-a.example.test` : TXT pas encore visible → TXT exact → certificat en
cours → actif ; mauvaise preuve ; certificat en échec ; domaine pris ;
preuve expirée ; génération changée ailleurs ; réponse perdue ;
détachement confirmé.
