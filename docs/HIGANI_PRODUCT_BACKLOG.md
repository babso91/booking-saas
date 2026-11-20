# Higani · répartition des 234 pistes produit

Le brief réunit 214 pistes initiales et 20 sur la personnalisation de la réservation. Chaque ligne garde son numéro, sa priorité et un responsable proposé. Une piste peut déjà fonctionner dans Higani. Avant de la prendre, la tester sur la branche d’intégration et consigner le résultat dans la demande de changement.

Claude UI prend le mini-site, sa vitrine, son catalogue public et le Studio qui les édite. Claude Cloud prend les règles métier, les données et les intégrations. Codex garde le dashboard prestataire, ses univers et les composants partagés de choix de format. Sur un sujet transversal, le responsable livre le parcours de bout en bout. UI peut ajuster le serveur pour un besoin concret de son interface et Cloud peut ajuster un écran pour rendre sa règle utilisable.

## Premier travail en parallèle

- **Claude UI** teste les points 1, 5, 17, 34 et 54 sur téléphone. Partir d’un site publié, trouver une prestation, comprendre son tarif et sa durée, puis entrer dans le format choisi avec la prestation présélectionnée.
- **Claude Cloud** teste les points 53, 57, 71, 78, 151, 203 et 204. Relier le créneau proposé, le prix confirmé et le lien d’annulation d’un rendez-vous de test. Vérifier aussi un créneau qui vient d’être pris. Si le moteur passe ces essais, documenter le résultat et traiter le prochain écart P0.
- **Codex** couvre la réservation classique et quatre présentations, les trois présentations supplémentaires de l’agenda Signature, les vues Jour, Semaine et Mois et les préférences par membre. Le choix d’un praticien et la réservation de plusieurs prestations restent des chantiers métier.
- **Relecture croisée** sur un changement qui traverse les deux parties. La demande de changement indique les numéros traités, les essais réalisés, les résultats et le lien vers la branche. Chaque personne peut avancer sur son lot pendant que l’autre relit.

Les quatre formats publics sont ouverts à Core et Signature pendant les essais. Le choix du format d’agenda pro appartient à Signature. La décision commerciale après les essais reste ouverte.

## Mini-site et vitrine

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                    |
| --- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0       | Claude UI    | En-tête informatif. Montrer nom, métier, localisation générale et bouton Réserver dès l'arrivée, sans masquer la création visuelle d'Higani.         |
| 2   | P0       | Claude Cloud | Prochaine disponibilité. Afficher le prochain créneau réellement réservable, éventuellement selon la prestation sélectionnée.                        |
| 3   | P0       | Claude UI    | Liens sociaux configurables. Instagram, TikTok, Facebook, LinkedIn, YouTube, site personnel et autres liens pertinents, sans imposer un réseau.      |
| 4   | P0       | Claude UI    | Contact immédiat. E-mail, téléphone, messagerie ou formulaire, au choix du professionnel. Pas nécessairement tous visibles.                          |
| 5   | P0       | Claude UI    | Informations pratiques centralisées. Adresse ou zone d'intervention, horaires, accès, paiement accepté, consignes et accessibilité.                  |
| 6   | P0       | Claude UI    | Conditions avant engagement. Annulation, retard, acompte, absence, accompagnants, préparation : visibles avant de réserver.                          |
| 7   | P1       | Claude UI    | Présentation personnalisée. Biographie, approche, expérience, spécialités, formations ou certifications pertinentes et vérifiables.                  |
| 8   | P1       | Claude Cloud | Avis clients authentiques. Affichage d'avis vérifiés ou issus d'une source externe autorisée, avec possibilité de masquer cette section.             |
| 9   | P1       | Claude UI    | Galerie organisée. Photos, vidéos courtes, légendes, avant/après lorsque pertinent, regroupées par prestation ou réalisation.                        |
| 10  | P1       | Claude UI    | Présentation de l'équipe. Portraits, spécialités, prestations assurées et possibilité de réserver avec une personne précise.                         |
| 11  | P1       | Claude UI    | Réponses aux questions fréquentes. Une FAQ configurable évitant les mêmes demandes par message.                                                      |
| 12  | P1       | Claude UI    | Informations spécifiques au métier. Déplacement à domicile, matériel fourni, séance à distance, durée de préparation ou conditions particulières.    |
| 13  | P1       | Claude UI    | Preuves de confiance. Certifications, assurances ou autres garanties lorsque pertinentes, sans badges trompeurs ou invérifiables.                    |
| 14  | P2       | Claude Cloud | Témoignages enrichis. Avis associés aux prestations et réalisations, avec autorisation de publication.                                               |
| 15  | P2       | Claude UI    | Présentation multilingue. Traductions maîtrisées par l'entreprise, notamment pour les professionnels qui travaillent à l'international.              |
| 16  | P0       | Claude UI    | Sections réellement modulables. Conserver les scènes actuelles, mais permettre de compléter la vitrine avec des sections informatives.               |
| 17  | P0       | Claude UI    | Navigation rapide. Accéder directement à Prestations, Réalisations, Informations, Avis et Réservation lorsqu'elles existent.                         |
| 18  | P0       | Claude UI    | Hiérarchie d'information. Les éléments essentiels apparaissent d'abord ; les détails restent accessibles sans être imposés.                          |
| 19  | P0       | Claude UI    | Bouton Réserver persistant et intelligent. Visible au bon moment, mais jamais au détriment des descriptions ou des contrôles.                        |
| 20  | P1       | Claude UI    | Sections réordonnables et facultatives. Le professionnel compose sa page selon son activité, sans devoir remplir tous les blocs.                     |
| 21  | P1       | Claude UI    | Pages ou sous-sections dédiées. Permettre une vitrine riche sans imposer un défilement excessif.                                                     |
| 22  | P1       | Claude UI    | Mise en avant éditoriale. Une prestation signature, une réalisation forte ou une spécialité peut devenir l'élément central de la page.               |
| 23  | P1       | Claude UI    | Contenus conditionnels. Ne pas afficher une galerie vide, des horaires inexistants ou une section d'avis sans avis.                                  |
| 24  | P1       | Claude UI    | Rendu adapté au volume. Une entreprise avec 3 prestations ne doit pas avoir exactement la même organisation qu'une entreprise avec 80 prestations.   |
| 25  | P2       | Claude UI    | Rubriques propres à chaque activité. Par exemple : portfolio pour un photographe, modalités des cours pour un professeur, équipement pour un coach.  |
| 26  | P0       | Claude UI    | Référencement naturel. Pages indexables lorsque publiées volontairement, métadonnées, titres, descriptions et informations locales structurées.      |
| 27  | P0       | Claude UI    | Partage optimisé. Quand quelqu'un partage une page sur WhatsApp, Instagram ou Messenger, son aperçu doit être convaincant.                           |
| 28  | P1       | Claude Cloud | Domaine personnalisé. Utiliser son propre domaine ou sous-domaine sans perdre son mini-site ni son système de réservation.                           |
| 29  | P1       | Claude UI    | Lien direct vers une prestation. Une publication Instagram peut mener directement au soin concerné, pas simplement à l'accueil.                      |
| 30  | P1       | Claude UI    | QR code professionnel. Pour cartes de visite, vitrines physiques, supports imprimés et événements.                                                   |
| 31  | P1       | Claude Cloud | Intégration avec la présence Google du professionnel. Liens de réservation et informations cohérentes avec son profil d'établissement.               |
| 32  | P2       | Claude Cloud | Analyse des sources de trafic. Savoir quelles visites proviennent du site, des réseaux sociaux, de Google ou de liens partagés, sans suivi intrusif. |

## Catalogue des prestations

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                             |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 33  | P0       | Claude UI    | Catégories intuitives. Conserver les catégories libres, avec navigation et regroupement efficaces sur mobile.                                                 |
| 34  | P0       | Claude UI    | Prix et durée immédiatement lisibles. Montrer un tarif exact ou « dès » lorsque des options peuvent le modifier.                                              |
| 35  | P0       | Claude UI    | Description détaillée mais facultative. Expliquer le contenu, le résultat attendu et les conditions de la prestation.                                         |
| 36  | P0       | Claude UI    | Comparaison rapide. Distinguer deux prestations proches sans obliger à ouvrir et fermer plusieurs fenêtres.                                                   |
| 37  | P0       | Claude UI    | Recherche dans les grands catalogues. Trouver une prestation par nom, catégorie ou mot-clé.                                                                   |
| 38  | P1       | Claude UI    | Photos propres aux prestations. Ne pas dépendre uniquement d'une galerie générale.                                                                            |
| 39  | P1       | Claude Cloud | Options configurables intelligemment. Suppléments, durée supplémentaire, choix de variantes et options obligatoires ou facultatives.                          |
| 40  | P1       | Claude Cloud | Options réutilisables. Éviter de recréer manuellement les mêmes choix pour 20 prestations similaires.                                                         |
| 41  | P1       | Claude Cloud | Duplication d'une prestation. Reprendre description, prix, durée et options, puis modifier seulement ce qui change.                                           |
| 42  | P1       | Claude UI    | Édition rapide. Modifier un tarif, une durée ou la visibilité sans naviguer à travers plusieurs écrans.                                                       |
| 43  | P1       | Claude UI    | Aperçu public immédiat. Voir exactement comment les changements apparaîtront pour les clientes.                                                               |
| 44  | P1       | Claude Cloud | Prestations réservables ou informatives. Certaines activités doivent pouvoir présenter un service nécessitant un devis plutôt qu'une réservation instantanée. |
| 45  | P1       | Claude Cloud | Choix de plusieurs prestations. Lorsque les règles métier le permettent, combiner des soins ou interventions dans un même rendez-vous.                        |
| 46  | P1       | Claude Cloud | Conditions par prestation. Préavis, durée tampon, personnes habilitées, lieux et disponibilités propres à un service.                                         |
| 47  | P2       | Claude Cloud | Forfaits et packs. Plusieurs séances achetées ensemble, avec consommation progressive.                                                                        |
| 48  | P2       | Claude Cloud | Séances collectives. Capacité maximale, places restantes, inscriptions et liste des participants.                                                             |
| 49  | P2       | Claude Cloud | Prestations à domicile. Zone de déplacement, temps de trajet et frais éventuels.                                                                              |
| 50  | P2       | Claude Cloud | Prestations en visioconférence. Lien de réunion, fuseau horaire et instructions de connexion.                                                                 |
| 51  | P2       | Claude Cloud | Ressources nécessaires. Salle, équipement, cabine ou matériel pouvant limiter les créneaux.                                                                   |
| 52  | P2       | Claude Cloud | Versions et historique. Une modification de prestation ne doit pas réécrire les informations des rendez-vous déjà confirmés.                                  |

## Réservation côté cliente

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                               |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 53  | P0       | Claude Cloud | Réservation sans compte obligatoire. Conserver ce principe, y compris pour les clients qui découvrent l'entreprise.             |
| 54  | P0       | Claude UI    | Accès direct depuis chaque prestation. Éviter de redemander ce que le visiteur a déjà choisi.                                   |
| 55  | P0       | Claude UI    | Choix lisible des options. Chaque supplément affiche son influence sur le prix et la durée avant validation.                    |
| 56  | P0       | Claude UI    | Informations essentielles sans surprise. Tarif, durée, lieu, professionnel, conditions et éventuel acompte.                     |
| 57  | P0       | Claude Cloud | Détection des premières disponibilités. Proposer les créneaux les plus proches sans parcourir manuellement de nombreuses dates. |
| 58  | P0       | Codex        | Vues Jour / Semaine / Mois. Fiabiliser et évaluer les vues déjà développées dans la PR #118, notamment sur téléphone.           |
| 59  | P0       | Claude UI    | Disponibilités sur plusieurs jours. Une cliente doit comparer plusieurs journées sans cliquer sur chacune.                      |
| 60  | P0       | Claude UI    | États vides utiles. Si aucun créneau n'existe, proposer une autre date, une autre personne ou la liste d'attente si disponible. |
| 61  | P1       | Claude UI    | Filtres de créneaux. Matin, après-midi, soir, semaine, week-end, prochain créneau.                                              |
| 62  | P1       | Claude Cloud | Choix de la personne. Professionnel précis ou première personne disponible, lorsque l'entreprise dispose d'une équipe.          |
| 63  | P1       | Claude Cloud | Choix du lieu. Cabinet, salon, domicile ou visioconférence selon la prestation.                                                 |
| 64  | P2       | Claude Cloud | Créneaux pour plusieurs prestations consécutives. Rechercher une durée compatible avec l'ensemble des services choisis.         |
| 65  | P0       | Claude UI    | Progression évidente. La cliente comprend où elle en est et ce qu'il reste à faire.                                             |
| 66  | P0       | Claude UI    | Saisie minimale. Prénom et e-mail lorsqu'ils suffisent ; téléphone seulement si nécessaire.                                     |
| 67  | P0       | Claude UI    | Conservation des choix. Ne jamais faire recommencer le parcours après une erreur récupérable.                                   |
| 68  | P0       | Claude UI    | Retour sans perte. Modifier date, service ou option sans effacer inutilement les autres informations.                           |
| 69  | P0       | Claude UI    | Récapitulatif complet. Prestation, options, prix, durée, date, heure, lieu et conditions.                                       |
| 70  | P0       | Claude UI    | Confirmation sans ambiguïté. Distinguer créneau consulté, demande en cours et réservation confirmée.                            |
| 71  | P0       | Claude Cloud | Gestion des créneaux devenus indisponibles. Informer clairement et proposer des alternatives sans perdre la saisie.             |
| 72  | P0       | Claude Cloud | Gestion des erreurs réseau. Éviter qu'un réessai crée deux réservations ou qu'une cliente ignore si son rendez-vous existe.     |
| 73  | P1       | Claude Cloud | Formulaires adaptés aux prestations. Ne demander que les réponses réellement nécessaires, au bon moment.                        |
| 74  | P1       | Claude Cloud | Paiement ou acompte intégré. Lorsque l'entreprise le choisit, sans frais imprévus ni obligation générale.                       |
| 75  | P1       | Claude UI    | Fonctionnement mobile irréprochable. Clavier, calendrier, défilement, boutons et validation.                                    |
| 76  | P2       | Claude Cloud | Réservation pour quelqu'un d'autre. Par exemple un parent ou un proche, avec règles de contact et de confidentialité adaptées.  |
| 77  | P0       | Claude UI    | Confirmation utile. Date, heure, service, adresse ou lien visio, conditions et contact.                                         |
| 78  | P0       | Claude Cloud | Gestion autonome. Consulter, annuler ou déplacer un rendez-vous dans les limites définies par l'entreprise.                     |
| 79  | P1       | Claude UI    | Ajout au calendrier personnel. Google, Apple, Outlook ou fichier calendrier.                                                    |
| 80  | P1       | Claude Cloud | Rappels personnalisables. E-mail, puis éventuellement SMS ou messagerie autorisée.                                              |
| 81  | P1       | Claude UI    | Rebooking simplifié. Reprendre la même prestation et, si souhaité, le même professionnel.                                       |
| 82  | P1       | Claude Cloud | Liste d'attente. Être averti lorsqu'un créneau compatible se libère, sans promesse trompeuse.                                   |
| 83  | P1       | Claude UI    | Instructions avant la visite. Préparation, matériel, documents, accès et consignes spécifiques.                                 |
| 84  | P2       | Claude UI    | Parcours après la prestation. Conseils, fidélité, avis et proposition de prochain rendez-vous quand cela a du sens.             |

## Agenda et travail quotidien

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                      |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 85  | P0       | Codex        | Tableau de bord utile dès l'ouverture. Prochains rendez-vous, changements, absences, tâches urgentes et informations vraiment pertinentes.             |
| 86  | P0       | Codex        | Vues Jour / Semaine / Mois professionnelles. Consolider les développements de #118 et tester leur lisibilité avec de vrais agendas chargés.            |
| 87  | P0       | Codex        | Rendez-vous et temps libres visibles ensemble. Voir ce qui est occupé et ce qui peut encore être réservé.                                              |
| 88  | P0       | Codex        | Modification rapide d'un rendez-vous. Depuis l'agenda, pouvoir changer horaire, prestation, statut ou personne selon les droits et règles applicables. |
| 89  | P0       | Codex        | Gestion simple des imprévus. Retard, absence, annulation, fermeture exceptionnelle, dépassement de durée.                                              |
| 90  | P0       | Codex        | Blocage d'une plage horaire. Pause, rendez-vous personnel, déplacement ou indisponibilité.                                                             |
| 91  | P0       | Codex        | Horaires exceptionnels accessibles depuis l'agenda. Éviter de chercher dans plusieurs paramètres.                                                      |
| 92  | P0       | Codex        | Fermetures multi-jours. Congés, vacances et événements exceptionnels ; vérifier les fonctions déjà introduites dans #118.                              |
| 93  | P0       | Codex        | Conflits expliqués clairement. Si une action est refusée, expliquer quel rendez-vous ou quelle règle pose problème.                                    |
| 94  | P0       | Codex        | Accès à la fiche cliente depuis le rendez-vous. Historique et informations pertinentes sans quitter son contexte.                                      |
| 95  | P1       | Codex        | Vue compacte ou détaillée. Adapter la densité d'information aux écrans et préférences des professionnels.                                              |
| 96  | P1       | Codex        | Déplacement direct dans l'agenda. Glisser-déposer ou alternative simple et accessible, avec confirmation des effets.                                   |
| 97  | P1       | Codex        | Filtres d'agenda. Praticien, lieu, prestation, statut, disponibilité, selon l'organisation.                                                            |
| 98  | P1       | Codex        | Réservation manuelle ultra-rapide. Pour les rendez-vous pris par téléphone ou sur place.                                                               |
| 99  | P1       | Claude Cloud | Répétition de rendez-vous. Vérifier le parcours de création et modification des séries déjà développées en PR.                                         |
| 100 | P1       | Claude Cloud | Historique des modifications. Savoir qui a changé un rendez-vous et ce qui a été modifié.                                                              |
| 101 | P1       | Claude Cloud | Annulation et déplacement groupés. En cas de fermeture imprévue, avec confirmation explicite et notifications adaptées.                                |
| 102 | P1       | Claude Cloud | Règles de disponibilité par personne. Horaires, congés, spécialités et capacité propres à chaque praticien.                                            |
| 103 | P1       | Claude Cloud | Règles par lieu ou ressource. Ne pas attribuer simultanément une salle ou un équipement indisponible.                                                  |
| 104 | P1       | Codex        | Détection des trous dans l'agenda. Identifier les intervalles difficiles à remplir et proposer des actions pertinentes.                                |
| 105 | P1       | Codex        | Actions contextuelles. Depuis un rendez-vous terminé, proposer par exemple « Reprendre rendez-vous », et non un menu généraliste.                      |
| 106 | P2       | Claude Cloud | Actions multiples. Modifier plusieurs plages, affectations ou règles en une opération contrôlée.                                                       |
| 107 | P2       | Codex        | Prévision de charge. Montrer les journées surchargées, les disponibilités futures et les périodes creuses.                                             |
| 108 | P2       | Codex        | Mode lecture en connexion dégradée. Consulter des données déjà chargées si possible, sans autoriser de fausses réservations hors ligne.                |
| 109 | P0       | Codex        | Navigation pensée par intention. « Ajouter un rendez-vous », « Modifier mes horaires », « Retrouver une cliente », plutôt que des menus obscurs.       |
| 110 | P0       | Codex        | Parité des tâches essentielles sur mobile. Pas de dépendance systématique à l'ordinateur.                                                              |
| 111 | P0       | Codex        | Réduction des changements d'écran. Favoriser les panneaux contextuels quand ils rendent l'action plus rapide.                                          |
| 112 | P0       | Codex        | Retour immédiat après une action. En cours, enregistré, refusé ou à vérifier : pas d'état ambigu.                                                      |
| 113 | P0       | Codex        | Brouillons préservés. Une erreur réseau ou un changement de page ne doit pas détruire le travail.                                                      |
| 114 | P1       | Codex        | Actions rapides personnalisables. Chaque professionnel retrouve ses opérations fréquentes.                                                             |
| 115 | P1       | Codex        | Recherche transversale. Retrouver une cliente, une prestation ou un rendez-vous depuis un même point d'entrée.                                         |
| 116 | P1       | Claude Cloud | Annulation de dernière action. Lorsque c'est techniquement et fonctionnellement sûr.                                                                   |
| 117 | P1       | Codex        | Explications intégrées. Des aides courtes, directement à côté des paramètres inhabituels.                                                              |
| 118 | P1       | Codex        | Tableau de bord adaptable. Un indépendant, une équipe et un professionnel itinérant ne doivent pas subir exactement la même disposition.               |
| 119 | P2       | Codex        | Raccourcis clavier. Pour les utilisateurs intensifs sur ordinateur.                                                                                    |

## Studio de personnalisation

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                         |
| --- | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 120 | P0       | Claude UI    | Éditeur visuel réellement intuitif. Chaque élément de la page doit être facile à trouver, modifier et prévisualiser.                                      |
| 121 | P0       | Claude UI    | Séparer contenu et apparence. Changer d'univers ne doit jamais faire perdre descriptions, prestations, horaires ou liens.                                 |
| 122 | P0       | Claude UI    | Prévisualisation mobile et ordinateur. Vérifier la page avec des données réelles, pas uniquement une maquette.                                            |
| 123 | P0       | Claude UI    | Vue « Comme mes clients ». Tester tout le parcours public depuis le Studio, sans créer une vraie réservation.                                             |
| 124 | P0       | Claude UI    | Informations manquantes signalées. Indiquer ce qui rendrait la fiche plus utile, sans forcer à remplir chaque rubrique.                                   |
| 125 | P1       | Claude UI    | Ajout de sections depuis un catalogue. Galerie, FAQ, tarifs, équipe, réseaux, informations pratiques, témoignages, etc.                                   |
| 126 | P1       | Claude UI    | Variantes de mise en page par section. Une information peut avoir plusieurs présentations sans multiplier son contenu.                                    |
| 127 | P1       | Claude Cloud | Historique et restauration. Revenir à une version publiée antérieure en préservant les données métier.                                                    |
| 128 | P1       | Claude UI    | Personnalisation adaptée au niveau de maîtrise. Mode simple avec choix guidés, puis réglages avancés.                                                     |
| 129 | P1       | Claude UI    | Suggestions de contenu selon le métier. Exemple : un photographe pourrait être invité à présenter ses formules, son portfolio et ses délais de livraison. |
| 130 | P1       | Claude UI    | Accessibilité automatique des thèmes. Contrastes lisibles, boutons repérables et typographie utilisable.                                                  |
| 131 | P2       | Claude UI    | Bibliothèque de composants personnalisés. Pour ajouter des contenus avancés sans rendre le Studio incompréhensible.                                       |
| 132 | P2       | Claude UI    | Variantes de pages. Adapter la présentation à une prestation, une campagne ou un lien spécifique lorsque le besoin est justifié.                          |

## Fiches clientes et suivi

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                     |
| --- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 133 | P0       | Codex        | Fiche cliente unifiée. Coordonnées, rendez-vous, prestations effectuées, notes, fidélité et interactions autorisées au même endroit.                  |
| 134 | P0       | Codex        | Historique lisible. Voir rapidement la dernière visite, les rendez-vous à venir et les événements importants.                                         |
| 135 | P0       | Codex        | Recherche efficace. Nom, téléphone ou e-mail, avec contrôles d'accès et prévention des mélanges de fiches.                                            |
| 136 | P0       | Codex        | Notes professionnelles. Ajouter des informations pertinentes sans exposer les données internes à la cliente.                                          |
| 137 | P1       | Codex        | Préférences de la cliente. Professionnel préféré, habitudes, contraintes exprimées et préférences de contact.                                         |
| 138 | P1       | Codex        | Étiquettes configurables. Pour organiser les clientes sans imposer de catégories propres à la beauté.                                                 |
| 139 | P1       | Codex        | Fiches techniques par visite. Composition flexible selon le métier, comme envisagé dans les PR CRM avancées.                                          |
| 140 | P1       | Claude Cloud | Formulaires avant rendez-vous. Questionnaires personnalisés, réutilisables et associés à la bonne visite.                                             |
| 141 | P1       | Claude Cloud | Historique des prestations réellement effectuées. Distinguer ce qui était prévu de ce qui a eu lieu.                                                  |
| 142 | P1       | Codex        | Suivi des annulations et absences. Indicateurs contextualisés, sans étiquetage abusif des clientes.                                                   |
| 143 | P1       | Codex        | Fidélité visible et compréhensible. Points, récompenses, niveaux éventuels et conditions faciles à expliquer.                                         |
| 144 | P1       | Claude Cloud | Rappels de rebooking. À partir des habitudes réelles, lorsque la cliente a autorisé les communications concernées.                                    |
| 145 | P1       | Claude Cloud | Segments de clientèle. Fréquence de visite, prestations réservées, inactivité, nouveaux clients, etc.                                                 |
| 146 | P1       | Claude Cloud | Import et export des données. Pour permettre au professionnel de changer de logiciel sans être prisonnier d'Higani.                                   |
| 147 | P1       | Claude Cloud | Détection prudente des doublons. Proposer une vérification plutôt qu'une fusion automatique dangereuse.                                               |
| 148 | P2       | Claude Cloud | Suivi post-prestation. Conseils, documents ou informations propres au service rendu.                                                                  |
| 149 | P2       | Claude Cloud | Indicateurs de fidélisation. Taux de retour, temps entre les visites, progression des cohortes et efficacité des actions.                             |
| 150 | P2       | Codex        | Personnalisation du CRM par métier. Une professeure particulière, un photographe et une technicienne de cils n'ont pas besoin des mêmes informations. |

## Communication et fidélisation

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                        |
| --- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 151 | P0       | Claude Cloud | Communications transactionnelles fiables. Confirmations, rappels, annulations et modifications, avec suivi des échecs d'envoi.           |
| 152 | P0       | Claude Cloud | Préférences de communication claires. Séparer rappels de réservation et messages commerciaux.                                            |
| 153 | P1       | Claude Cloud | Modèles de messages personnalisables. Ton, signature, informations pratiques et identité de l'entreprise.                                |
| 154 | P1       | Claude Cloud | Demandes d'avis après prestation. Envoi facultatif, aux clients éligibles, sans fabriquer ni filtrer artificiellement les avis négatifs. |
| 155 | P1       | Claude Cloud | Campagnes de réactivation. Contacter des clientes inactives avec consentement approprié et règles anti-spam.                             |
| 156 | P1       | Claude Cloud | Relances intelligentes. Cibler selon le service, l'intervalle habituel et l'absence de rendez-vous futur.                                |
| 157 | P1       | Claude Cloud | Programme de parrainage. Récompenser les recommandations directes entre clients d'une même entreprise.                                   |
| 158 | P1       | Claude Cloud | Promotions ciblées. Codes, offres limitées ou avantages, avec prix total clair et contrôle des quotas.                                   |
| 159 | P1       | Claude Cloud | Résultats mesurables. Distinguer messages envoyés, délivrés, réservations attribuables et revenus réellement confirmés.                  |
| 160 | P2       | Claude Cloud | Aide au remplissage des créneaux libres. Identifier des clients potentiellement intéressés sans les solliciter de manière excessive.     |
| 161 | P2       | Claude Cloud | Campagnes saisonnières. Préparation, planification et suivi, sans devenir une plateforme publicitaire complexe.                          |
| 162 | P2       | Claude Cloud | Tests de communication. Comparer des messages ou moments d'envoi avec des mesures fiables et des volumes suffisants.                     |

## Paiements et commerce

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                         |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 163 | P1       | Claude Cloud | Acomptes configurables. Montant fixe ou pourcentage selon les règles de la prestation.                                    |
| 164 | P1       | Claude Cloud | Paiement intégral à la réservation. Lorsque le professionnel souhaite cette option.                                       |
| 165 | P1       | Claude Cloud | Paiement sur place. Conserver un parcours de réservation sans paiement en ligne.                                          |
| 166 | P1       | Claude UI    | Conditions de remboursement transparentes. Informations visibles et application cohérente des règles autorisées.          |
| 167 | P1       | Claude Cloud | Historique des paiements et acomptes. Associé au rendez-vous correspondant, sans stockage dangereux des cartes bancaires. |
| 168 | P1       | Claude Cloud | Gestion des soldes. Distinguer prix du service, acompte versé, montant restant et éventuel remboursement.                 |
| 169 | P2       | Claude Cloud | Cartes cadeaux. Montant ou prestation offerte, validité et solde restant.                                                 |
| 170 | P2       | Claude Cloud | Abonnements et forfaits clients. Plusieurs séances, crédits ou visites incluses, séparés de l'abonnement SaaS Higani.     |
| 171 | P2       | Claude Cloud | Factures et justificatifs. Selon les obligations et paramètres applicables à l'activité.                                  |
| 172 | P2       | Claude Cloud | Intégration avec l'encaissement physique. Pour les professionnels qui utilisent déjà un terminal ou une caisse.           |
| 173 | P2       | Claude Cloud | Devis commerciaux. Pour les prestations dont le prix final nécessite un échange préalable.                                |

## Intégrations

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                        |
| --- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 174 | P0       | Claude Cloud | Synchronisation calendrier fiable. Vérifier les créations, déplacements, annulations, conflits et reconnexions Google Calendar.                          |
| 175 | P1       | Claude Cloud | Calendriers Outlook et Microsoft 365. Connexion et synchronisation selon un contrat clairement défini.                                                   |
| 176 | P1       | Claude Cloud | Apple Calendar et abonnements ICS. Offrir une compatibilité pratique, en distinguant lecture et synchronisation bidirectionnelle.                        |
| 177 | P1       | Claude UI    | Intégration au site existant. Widget ou module de réservation intégrable sur WordPress, Webflow, Squarespace et autres sites.                            |
| 178 | P1       | Claude Cloud | Google Business Profile. Faciliter le lien de réservation depuis la fiche de l'entreprise ; une intégration native dépend des conditions du fournisseur. |
| 179 | P1       | Claude UI    | Liens sociaux et partage. Instagram, TikTok, Facebook, WhatsApp et autres canaux utilisés par la clientèle.                                              |
| 180 | P1       | Claude Cloud | Prestataire de paiement. Intégration réelle, sécurisée et adaptée au modèle financier finalement retenu.                                                 |
| 181 | P1       | Claude Cloud | Calendriers d'équipe. Permettre des connexions séparées pour les personnes qui en ont besoin.                                                            |
| 182 | P1       | Claude Cloud | Import/export CSV. Prestations, données clientes autorisées, rendez-vous et paramètres pertinents.                                                       |
| 183 | P1       | Claude Cloud | Suivi de l'état des intégrations. Connexion active, erreur, dernière synchronisation et solution de réparation.                                          |
| 184 | P2       | Claude Cloud | Réunions en ligne. Google Meet, Zoom ou Teams pour les prestations à distance.                                                                           |
| 185 | P2       | Claude Cloud | API et webhooks documentés. Permettre l'interopérabilité sans donner un accès excessif aux données.                                                      |
| 186 | P2       | Claude Cloud | Connecteurs d'automatisation. Zapier, Make ou n8n selon la demande réelle.                                                                               |
| 187 | P2       | Claude Cloud | Messagerie professionnelle. WhatsApp Business ou SMS via des fournisseurs autorisés, avec respect des consentements.                                     |
| 188 | P2       | Claude Cloud | Outils de comptabilité. Export structuré ou connecteurs adaptés aux marchés ciblés.                                                                      |
| 189 | P2       | Claude Cloud | Ressources externes. Documents de préparation, visioconférence, accès géographique ou autres besoins métiers pertinents.                                 |

## Préférences du poste de travail

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                                            |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 190 | P0       | Codex        | Préserver les univers actuels. Les enrichir plutôt que remplacer toute la direction artistique.                                                              |
| 191 | P0       | Codex        | Séparer l'univers du poste de travail et celui du mini-site. Deux usages, deux besoins, une identité cohérente.                                              |
| 192 | P1       | Codex        | Organisation de l'accueil professionnel. Choix des modules affichés et de leur ordre.                                                                        |
| 193 | P1       | Codex        | Affichage d'agenda configurable. Densité, vue préférée, filtres et horaires affichés.                                                                        |
| 194 | P1       | Codex        | Préférences propres à chaque membre. Une praticienne n'a pas forcément les mêmes besoins que la responsable.                                                 |
| 195 | P1       | Codex        | Réglages simples et avancés. Limiter l'encombrement sans limiter les capacités.                                                                              |
| 196 | P1       | Codex        | Valeurs par défaut pertinentes. Adapter certaines suggestions aux métiers, sans enfermer les utilisateurs dans des catégories imposées.                      |
| 197 | P1       | Claude UI    | Personnalisation de l'expérience cliente. Pouvoir choisir quelles informations sont montrées, et à quel endroit, tout en préservant les obligations légales. |
| 198 | P2       | Codex        | Différents modes d'affichage métier. Compact pour un salon très actif, détaillé pour un indépendant ayant peu de rendez-vous mais beaucoup de notes.         |
| 199 | P2       | Claude Cloud | Gestion multi-établissements. Lorsque le marché ciblé le justifie, avec séparation claire des équipes, lieux et données.                                     |

## Qualité du produit

| N°  | Priorité | Responsable  | Objectif du brief                                                                                                                              |
| --- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 | P0       | Claude UI    | Performance mobile. Chargement rapide même avec une galerie, beaucoup de prestations et plusieurs sections visuelles.                          |
| 201 | P0       | Claude UI    | Accessibilité. Navigation clavier, lecteurs d'écran, zones tactiles, contrastes, messages d'erreur et réduction des animations.                |
| 202 | P0       | Claude Cloud | Robustesse réseau. Messages d'erreur compréhensibles, reprises sûres et absence d'actions doublées.                                            |
| 203 | P0       | Claude Cloud | Cohérence des règles. Ce que voit la cliente doit correspondre au planning et aux décisions du serveur.                                        |
| 204 | P0       | Claude Cloud | Sécurité multi-entreprises. Aucune fuite de données d'un établissement vers un autre.                                                          |
| 205 | P0       | Claude Cloud | Confidentialité. Droits par rôle, consentements, suppression, export et conservation maîtrisée des données.                                    |
| 206 | P0       | Claude Cloud | Sauvegardes et restauration. Capacité à récupérer les données et les configurations importantes après incident.                                |
| 207 | P1       | Claude Cloud | Observabilité. Savoir quand une réservation, une synchronisation ou une notification échoue réellement.                                        |
| 208 | P1       | Claude UI    | Localisation internationale. Langues, formats de date, fuseaux horaires, devises et particularités légales.                                    |
| 209 | P1       | Claude UI    | Référentiel de design unifié. Composants cohérents, mêmes conventions de navigation et comportements prévisibles.                              |
| 210 | P1       | Claude Cloud | Import facilité depuis un concurrent. Un professionnel doit pouvoir essayer Higani sans reconstruire manuellement tout son catalogue.          |
| 211 | P1       | Codex        | Tests avec données réalistes. Catalogues de 50 prestations, équipes, périodes chargées, clients récurrents et exceptions.                      |
| 212 | P1       | Claude UI    | Tests utilisateurs par métier. Évaluer indépendants, équipes, services à domicile, prestations en ligne et professions hors beauté.            |
| 213 | P1       | Claude UI    | Aide intégrée. Explications courtes, diagnostics de configuration, support et possibilité de signaler un problème.                             |
| 214 | P2       | Claude UI    | Expérimentation UX. Comparer des variantes avec des mesures de réussite, sans faire dépendre toutes les décisions d'une esthétique subjective. |

## Personnalisation de la réservation

| N°  | Priorité | Responsable  | Objectif du brief                                                                |
| --- | -------- | ------------ | -------------------------------------------------------------------------------- |
| 215 | P1       | Codex        | Choisir le modèle de réservation : calendrier, chronologique, vitrine ou assisté |
| 216 | P1       | Codex        | Choisir la vue par défaut : Jour, Semaine ou Mois                                |
| 217 | P1       | Claude UI    | Choisir combien de jours et de créneaux afficher simultanément                   |
| 218 | P0       | Claude Cloud | Définir les jours de réservation autorisés                                       |
| 219 | P0       | Claude Cloud | Définir les horaires d'ouverture, pauses et plages particulières                 |
| 220 | P1       | Claude Cloud | Choisir l'intervalle des créneaux proposés : 5, 10, 15, 20, 30, 60 minutes, etc. |
| 221 | P1       | Claude Cloud | Autoriser les horaires précis compatibles : 9 h 05, 9 h 10, 9 h 15, etc.         |
| 222 | P0       | Claude Cloud | Choisir le préavis minimal et l'horizon maximal de réservation                   |
| 223 | P1       | Claude Cloud | Définir des contraintes différentes par prestation, personne ou lieu             |
| 224 | P1       | Claude UI    | Choisir l'ordre des étapes du parcours lorsque c'est possible                    |
| 225 | P1       | Claude UI    | Choisir quelles informations apparaissent avant ou après le calendrier           |
| 226 | P1       | Claude Cloud | Permettre de préselectionner une prestation ou un membre d'équipe                |
| 227 | P1       | Claude Cloud | Choisir entre réservation immédiate et demande nécessitant validation            |
| 228 | P1       | Claude Cloud | Configurer les coordonnées et questions réellement nécessaires                   |
| 229 | P1       | Claude UI    | Personnaliser les couleurs, composants et présentation du module de réservation  |
| 230 | P0       | Codex        | Prévisualiser et tester le parcours comme une cliente                            |
| 231 | P1       | Claude UI    | Fournir des configurations de départ adaptées aux métiers                        |
| 232 | P1       | Claude Cloud | Mesurer les abandons et la réussite des réservations selon le modèle             |
| 233 | P0       | Codex        | Revenir au modèle par défaut sans perdre les règles métier                       |
| 234 | P0       | Claude UI    | Proposer des réglages avancés sans les imposer aux débutants                     |
