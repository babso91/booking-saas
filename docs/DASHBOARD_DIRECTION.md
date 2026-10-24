# Dashboard professionnel : cahier de direction (phase 2)

Ce document consigne les décisions produit prises pour la phase 2. **Rien de ce qui suit n'est construit dans le laboratoire.** La logique métier et la persistance reviendront à Claude Cloud, les audits à Codex, et l'interface à une mission dédiée.

## Les trois phases

1. **Terminer le laboratoire Experience Engine** : mini-sites, Studio, catalogue multi-métiers, options, réservation fictive (branche `proto/experience-engine`).
2. **Perfectionner le dashboard existant** : agenda, rendez-vous, CRM, fidélité, prestations, paramètres. On reprend d'abord l'expérience visuelle et l'ergonomie, puis on ajoute les fonctionnalités prévues.
3. **Intégrer les deux** en PR contrôlées : le Studio raccordé au dashboard, un catalogue métier unique, le moteur de réservation sécurisé. Aucune fusion improvisée.

## Tarifs

Aucun tarif n'est une hypothèse métier. Chaque professionnelle fixe et modifie librement ses prix, ses durées et ses options. Les montants des exemples (25 €, 35 €, +5 €) ne servent qu'aux démonstrations.

## Suivi manuel des encaissements

**Aucun paiement intégré :** ni Stripe, ni encaissement par carte dans l'application, ni acompte en ligne. La professionnelle encaisse avec ses moyens habituels, puis confirme elle-même qu'elle a reçu l'argent.

- **Exemple :**
  1. Une cliente réserve une prestation à 35 € ; le rendez-vous apparaît dans l'agenda.
  2. La cliente paie en espèces.
  3. La professionnelle ouvre le rendez-vous, choisit « Espèces » et confirme ; l'encaissement entre dans ses indicateurs.
  4. Même geste avec « Carte sur place » quand la cliente a payé sur un terminal externe, après vérification.
- **États d'un encaissement :**
  - restant à encaisser (non confirmé) ;
  - reçu, confirmé par la professionnelle ;
  - corrigé ou annulé quand il a été saisi par erreur, avec traçabilité : une écriture d'annulation, jamais un effacement.
- **Indépendance des statuts :** le statut d'un rendez-vous ne dit rien de son paiement. Une prestation terminée n'est pas payée pour autant, et une réservation n'est jamais du chiffre d'affaires encaissé.
- **Plus tard, sans alourdir la première démonstration :** paiements partiels et remboursements.
- **Indicateurs :**
  - encaissé aujourd'hui, sur la semaine et sur le mois ;
  - répartition carte / espèces ;
  - montants restant à encaisser ;
  - historique des encaissements ;
  - accès direct aux rendez-vous non payés.
- **Responsabilités :**
  - l'interface est prototypée d'abord ;
  - la persistance et la logique reviennent à Claude Cloud : traçabilité, isolation multi-tenant, tests, audit ;
  - Claude Cloud vérifie aussi les exigences réglementaires applicables aux logiciels de caisse, qui sont à confirmer avant tout enregistrement réel ;
  - aucun paiement réel n'est stocké en dehors du backend.

## Personnalisation du dashboard (accessible en Core)

- Plusieurs thèmes visuels, des couleurs personnalisables, un mode clair et un mode sombre lorsque c'est cohérent.
- Des widgets à afficher, masquer ou réorganiser.
- Des animations légères au choix, et un mode sans animation (qui respecte aussi la préférence du système).
- **Le mouvement :** plus discret que sur les mini-sites, mais aussi soigné. Le dashboard est l'outil de travail quotidien : il doit rester extrêmement rapide, sans aucune animation qui retarde une action.
- Une expérience mobile excellente.
