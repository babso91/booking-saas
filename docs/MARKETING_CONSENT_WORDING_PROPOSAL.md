# Consentement aux offres : proposition de formulation

> **NON VALIDÉ.** Ce document est une proposition de travail. Ce n'est pas un
> texte juridique. Il doit être relu par une personne compétente avant tout
> usage. Tant qu'il n'est pas validé :
>
> - **aucune collecte** de consentement n'est activée, ni à la réservation ni
>   dans l'espace pro (`consentCollectionOpen = false` dans
>   `src/features/marketing-consent/wording.ts`) ;
> - **aucun envoi** marketing réel ne part (campagnes désactivées côté
>   serveur, voir `docs/MARKETING_CONSENT_CONTRACT.md`).

Version proposée : `mkt-fr-proposition-1`. Aperçu : `/apercu/consentement`
(404 en production sauf `DASHBOARD_PREVIEW=1`).

## Règles retenues (décision du 16/11)

1. Consentement **facultatif**, **jamais précoché**.
2. **E-mail et SMS séparés** : deux cases, deux enregistrements.
3. **Aucun impact sur la réservation** : elle passe quelle que soit la réponse.
4. **Distinction claire** entre les messages nécessaires au rendez-vous
   (confirmation, rappel, modification), envoyés dans tous les cas, et les
   communications commerciales.
5. **Retrait facile** : lien dans chaque message (déjà servi :
   `/desinscription`), espace client, ou demande à l'établissement.
6. **Historique** de chaque choix : date, canal, établissement, version du
   texte présenté, origine (réservation, établissement, espace client, lien).

## Formulation proposée (côté cliente, vouvoiement)

Placée à l'étape « Vos coordonnées », après les champs, avant de confirmer.

> **Offres et nouveautés**
> Facultatif : votre réservation ne dépend pas de ce choix.
>
> ☐ Recevoir par e-mail les offres et nouveautés d'{Établissement}
> ☐ Recevoir par SMS les offres et nouveautés d'{Établissement}
>
> Les messages liés à votre rendez-vous (confirmation, rappel, modification)
> vous sont envoyés dans tous les cas.
> Vous pouvez changer d'avis à tout moment : un lien dans chaque message, ou
> votre espace client.
> Ces messages vous sont envoyés par {Établissement}.

« de » devient « d' » devant une voyelle (`ofBusiness`).

## Points juridiques à faire vérifier

Questions ouvertes. Rien ici n'est une affirmation juridique.

1. **Base légale et textes applicables** : confirmer le régime de la
   prospection par e-mail et par SMS envers des particuliers (RGPD,
   article L34-5 du CPCE, recommandations de la CNIL). Confirmer que le
   consentement préalable est requis pour chaque canal.
2. **Exception « client existant »** (produits ou services analogues) :
   s'applique-t-elle à une cliente qui a déjà réservé ? Si oui, faut-il quand
   même demander le consentement (choix produit : oui, plus simple et plus
   respectueux) ?
3. **Responsable de traitement** : l'établissement est-il seul responsable de
   ses envois, et Booking SaaS sous-traitant ? Quel accord de sous-traitance
   (DPA) faut-il, et où l'accepter ?
4. **Information obligatoire au moment de la collecte** : identité du
   responsable, finalité, durée de conservation, droits (accès, opposition,
   effacement), lien vers une politique de confidentialité. Laquelle
   affiche-t-on : celle de l'établissement, la nôtre, les deux ? Une ligne
   courte avec un lien suffit-elle ?
5. **Mentions dans les messages** : identité de l'expéditeur, lien de
   désinscription (e-mail), mention « STOP » ou équivalent pour les SMS.
   Faut-il un numéro court STOP, et chez quel fournisseur ?
6. **Durée de conservation** du consentement et de sa preuve, y compris après
   retrait ou suppression de la fiche cliente. Le registre est en ajout seul.
7. **Preuve** : la version du texte, la date, le canal et l'origine
   suffisent-ils ? Faut-il conserver le texte exact de chaque version, et
   ailleurs que dans le code ?
8. **Consentement noté par l'établissement** (une cliente qui accepte de vive
   voix) : est-ce recevable ? Si oui, avec quel texte et quelle preuve ? En
   attendant, l'espace pro ne permet que de **retirer** un accord.
9. **Mineures** : âge minimal pour consentir seule à la prospection ?
10. **Délai d'annulation de la désinscription** (30 minutes, depuis le même
    lien) : acceptable ?
11. **Plages horaires et fréquence** des SMS commerciaux : contraintes
    légales ou recommandations à respecter ?
12. **Formulation** : « offres et nouveautés » décrit-il assez précisément la
    finalité ? Faut-il citer les types de messages (promotions, actualités,
    relances) ?

## Ce qui est prêt dans le code (rien n'est branché)

- `wording.ts` : le texte, sa version, `validated: false`, et
  `consentCollectionOpen = false`.
- `MarketingOptIn` : les deux cases, jamais précochées, avec les mentions.
  Utilisé seulement dans l'aperçu.
- `ConsentHistory` : l'historique, du plus récent au plus ancien. Il attend
  le contrat ci-dessous.

## Ce qui manque côté serveur (demandé à Cloud)

1. **Lecture de l'historique** (le registre en ajout seul le contient déjà) :
   `getClientConsentHistoryAction({ clientId })` →
   `ConsentEventDto[] = { channel, state: "granted"|"withdrawn", proofVersion,
source, businessName, occurredAt }`.
   `source` ajoute `booking` et `client_hub` aux origines actuelles.
2. **Refus des versions non validées** : un `grant` n'est accepté que pour
   une version de texte enregistrée comme validée côté serveur. Aujourd'hui,
   toute `proofVersion` bien formée passe. Tant qu'aucune version n'est
   validée, **tout `grant` est refusé**. C'est la vraie garantie : le
   verrou de l'interface ne suffit pas.
3. **Plus tard, après validation** : la collecte à la réservation (champ
   facultatif dans la commande, accord enregistré dans la même transaction
   que le rendez-vous, `source: "booking"`), et le retrait depuis l'espace
   client (`source: "client_hub"`).

## Pour ouvrir la collecte (après validation seulement)

1. Une nouvelle version du texte, avec son propre identifiant, et le texte
   validé conservé.
2. Côté serveur, enregistrer cette version comme validée (point 2 ci-dessus).
3. `validated: true` et `consentCollectionOpen = true`, en relecture de code.
4. Brancher `MarketingOptIn` dans `ContactStep` et la commande de
   réservation.
