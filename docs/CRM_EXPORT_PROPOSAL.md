# Export du fichier clientes — contrat proposé (R3-03, tranche export)

Statut : **proposé par l'UI, non implémenté**. Le panneau existe
(`src/features/crm-export/`) et ne tourne que dans `/apercu/export`, contre
un serveur en mémoire. **Aucun fichier n'est produit.** Table
`crm_export_jobs`, stockage privé, lien signé court, audit et rôle restent
ceux de Cloud. La restitution d'une demande de droits (RGPD) suit une file
distincte, hors de ce lot.

## Données

```ts
type ExportJob = {
  jobId: string;
  scope: "contacts" | "contacts_and_visits";
  status: "requested" | "ready" | "expired" | "revoked" | "failed";
  requestedAt: string;
  expiresAt: string | null; // 24 h proposées après "ready"
  rowCount: number | null;
};
```

## Actions

| Action     | Entrée             | Effet                                                                                  |
| ---------- | ------------------ | -------------------------------------------------------------------------------------- |
| `list`     | —                  | Les exports de l'établissement, récent d'abord                                         |
| `request`  | `scope, requestId` | Propriétaire seulement ; un seul export en préparation à la fois                       |
| `download` | `jobId`            | Lien privé court **demandé au clic** ; rôle et portée revérifiés ; audité sans contenu |
| `revoke`   | `jobId`            | Retire le fichier tout de suite                                                        |

Refus : `permission_denied`, `export_in_progress`, `export_expired`, 404
opaque. Même `requestId` → même réponse.

## Fichier

CSV UTF-8 avec BOM ; cellules interprétables (`= + - @`, tabulation)
neutralisées ; aucune note, réponse de formulaire ni image dans la V1.
