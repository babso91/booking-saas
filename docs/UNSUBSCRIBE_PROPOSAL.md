# Désinscription marketing — contrat proposé (R4-01, tranche désinscription)

Statut : **proposé par l'UI, non implémenté**. La page existe
(`src/features/unsubscribe/`) et ne tourne que dans
`/apercu/desinscription?lien=tok-a-email|tok-b-sms|faux`, contre un
serveur en mémoire. Le registre de consentements
(`client × purpose × channel`, append-only, M3) et les jetons restent ceux
de Cloud. **Prérequis à toute activation d'envois réels** (avec preuve de
consentement, identité d'expéditeur et budget).

## Principes

- **Sans connexion** : le jeton du lien prouve seulement l'établissement et
  le canal concernés, rien d'autre (ni compte, ni Hub, ni CRM).
- **Ouvrir la page ne change rien** (aperçus de liens et scanners de mails
  ouvrent les liens) ; seul le clic retire le consentement.
- Portée : cet établissement × ce canal. Un autre établissement n'est
  jamais touché.
- Les **rappels de rendez-vous ne sont pas du marketing** et continuent.
- Annulation possible juste après (erreur de clic).

## Actions

| Action        | Entrée  | Effet                                                                 |
| ------------- | ------- | --------------------------------------------------------------------- |
| `read`        | `token` | `{ businessName, channel, alreadyWithdrawn }` ; n'écrit rien          |
| `withdraw`    | `token` | Événement `withdrawn` au registre ; idempotent                        |
| `resubscribe` | `token` | Événement `granted` (même preuve que l'opt-in d'origine ? à trancher) |

Refus : `unsubscribe_link_invalid`, réponse opaque unique (inconnu, forgé
ou expiré), sans nom d'établissement.

## À trancher par Cloud

Durée de validité des jetons ; si `resubscribe` est permis depuis le lien
ou seulement juste après le retrait ; prise en compte d'un retrait déjà en
file d'envoi (aucun message remis après l'opt-out, cf. recette R4-01).
