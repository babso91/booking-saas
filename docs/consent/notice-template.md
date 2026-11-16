# Modèle de notice d'information (consentement marketing) : à compléter

**Statut : modèle, non enregistré, non actif.** Les éléments entre
`{{…}}` viennent soit de l'établissement (sa fiche légale, renseignée par la
propriétaire), soit de la plateforme. **Rien n'a été inventé** : tout ce qui
manque est listé en fin de document. Ce modèle n'est pas un avis juridique.

---

**Vos choix concernant les offres commerciales de {{businessName}}**

- **Responsable du traitement :** {{controller.legalName}},
  {{controller.address}}. Contact : {{controller.contactEmail}}.
- **Finalité :** vous envoyer, si vous l'avez accepté, les offres,
  promotions et nouveautés commerciales de {{businessName}}, par e-mail
  et/ou par SMS selon les cases cochées.
- **Base légale :** votre consentement, facultatif. Il n'est pas une
  condition de votre réservation.
- **Données utilisées :** votre prénom, votre adresse e-mail et/ou votre
  numéro de téléphone, ainsi que la date et le texte de votre accord.
- **Destinataires et prestataires :**
  - {{businessName}} ;
  - la plateforme de réservation {{platform.legalName}}, sous-traitant ;
  - l'hébergement : {{platform.hosting}} ;
  - l'envoi des e-mails : {{platform.emailProvider}} ;
  - l'envoi des SMS : {{platform.smsProvider}}.
- **Durée de conservation :** {{retention.marketing}}. La preuve de votre
  accord ou de votre retrait est conservée {{retention.proof}}.
- **Vos droits :** accès, rectification, effacement, opposition,
  limitation, et retrait de votre accord à tout moment, gratuitement :
  - par le lien « Ne plus recevoir » présent dans chaque message ;
  - ou auprès de {{controller.contactEmail}}.

  Vous pouvez introduire une réclamation auprès de la CNIL.

- **Les messages concernant vos rendez-vous** (confirmation, rappel,
  modification) restent indépendants de ce choix.

---

## Informations réelles manquantes (à fournir, à ne pas inventer)

| Variable                                          | Source                                                                      | État aujourd'hui                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `controller.legalName`, `address`, `contactEmail` | fiche légale de chaque établissement (`setBusinessLegalProfileAction`)      | vide par défaut ; `consent_notice` liste les champs manquants |
| `platform.legalName`                              | l'entité juridique qui exploite la plateforme                               | **inconnue**                                                  |
| `platform.hosting`                                | hébergeurs réels (base de données, serveur applicatif) et leur localisation | **à confirmer** (Supabase, Hetzner : régions à vérifier)      |
| `platform.emailProvider`                          | fournisseur d'e-mail retenu                                                 | **non choisi**                                                |
| `platform.smsProvider`                            | fournisseur SMS retenu                                                      | **non choisi**                                                |
| `retention.marketing`                             | durée de conservation des données de prospection                            | **à décider**                                                 |
| `retention.proof`                                 | durée de conservation des preuves d'accord et de retrait                    | **à décider**                                                 |
| Délégué à la protection des données               | si l'entité en a désigné un                                                 | **inconnu**                                                   |
