# Dashboard professionnel : état des lieux, direction et plan (phase 2)

Branche : `feat/dashboard-experience`, partie de `main` (`249aff1`). Aucune dépendance aux PR #26 (Client Hub) et #27 (tests datés), ni au laboratoire (`proto/experience-engine`).

Principe : on améliore le back-office qui existe. Pas de second dashboard, pas de nouvelle logique de réservation, pas de modèle de données refait pour une question d'interface.

## 1. Ce qui existe (vérifié dans le code)

| Écran | Route | Contenu | Données |
| --- | --- | --- | --- |
| Agenda (accueil actuel) | `/app` | Semaine dès 768 px, jour sur téléphone. Création de rendez-vous ou de blocage depuis un créneau, fiche du rendez-vous, statut (Terminé, Absente, Annulé avec motif), case « inclure les annulés », liste de configuration à terminer | Serveur : jour de l'établissement (PostgreSQL), progression de configuration. Client : actions `getAgenda`, `listAgendaServices`. Écritures idempotentes (`requestId`), conflits gérés |
| Clientes | `/app/clients` | Annuaire : recherche, filtres, pagination par curseur, création | `listClients` |
| Fiche cliente | `/app/clients/[id]` | Contact, édition, notes privées, historique paginé, fidélité (points, récompenses, ajustement, grand livre) | Profil, historique, notes et fidélité chargés séparément |
| Prestations | `/app/services` | Créer, modifier, activer, réordonner, supprimer ; brouillons locaux ; verrou optimiste (`version`) | Nom 1–120, description ≤ 1000, durée 5–720 min, prix 0–100 000 €, actif, ordre. **Pas de catégories ni d'options** |
| Fidélité | `/app/loyalty` | Mode (rendez-vous ou montant), règles par prestation, catalogue de récompenses | Quatre lectures parallèles, erreurs par section |
| Horaires | `/app/settings/hours` | Semaine type, brouillon local, conflit relu | `replaceBusinessHours` |
| Google Calendar | `/app/settings/calendar` | Connexion, reconnexion, déconnexion | OAuth |
| Bienvenue | `/app/welcome` | Fin d'onboarding | Progression |

**Coquille :**

- Sur ordinateur, une barre latérale de 240 px.
- Sur téléphone, une barre haute et une barre d'onglets à 4 entrées : Agenda, Clientes, Prestations, Compte. Fidélité, Horaires et Google Calendar sont rangés dans « Compte ».

**Identité visuelle :**

- Palette « atelier » : ivoire, espresso et accent bois de rose.
- Polices : Hanken Grotesk et Instrument Serif.
- Variables CSS sémantiques (`--paper`, `--ink`, `--accent`…) exposées à Tailwind.
- Pas de mode sombre. « Réduire les animations » est respecté.

**Rendez-vous :**

- Statuts : `confirmed`, `completed`, `cancelled`, `no_show`.
- Instantanés figés à la réservation : nom, durée et **prix** (`price_cents_snapshot`), avec la devise.
- **Aucun concept de paiement**, en base comme dans l'interface. Les textes existants le disent d'ailleurs : « pas un encaissement ».

## 2. Ce qu'on garde, ce qu'on améliore

**À garder tel quel :**

- les contrats de données et les actions serveur ;
- l'idempotence, les conflits et la gestion du fuseau horaire et du changement d'heure dans l'agenda ;
- les états de chargement, d'erreur et de conflit, déjà soignés partout ;
- le système de variables sémantiques : c'est lui qui rend la personnalisation possible sans réécrire les écrans ;
- les primitives (`Sheet`, `Button`, `Field`, `Switch`…).

**À améliorer :**

1. **La coquille est remontée à chaque navigation.**
   - Chaque page répète la garde et `<AppShell>`, au lieu de la laisser au layout `/app`.
   - Effets : état perdu, travail inutile, `current` passé à la main.
   - Elle vit dans `features/agenda` alors qu'elle concerne tout le back-office.
2. **Pas d'accueil.** `/app`, c'est l'agenda. Aucun écran ne répond à « où en est ma journée, ma semaine ? ».
3. **Sur téléphone :**
   - Fidélité (une fonction produit) est cachée dans « Compte », avec les réglages.
   - Pas de déplacement rapide d'un rendez-vous (pas de glisser, il faut passer par « Modifier »).
   - « Terminer » et « encaisser » devront former un seul geste en fin de prestation.
4. **Couleurs codées en dur :** une quarantaine, surtout des ombres et quelques teintes de texte, dans une dizaine de fichiers. Elles empêchent tout thème cohérent (sombre en particulier).
5. **Libellés au féminin** (« Clientes », « Absente ») : c'est un choix produit à confirmer, car la clientèle peut être mixte.

## 3. Direction artistique

Un outil de travail quotidien, premium et calme : l'élégance éditoriale des mini-sites, sans leur mise en scène.

- **Typographie :** la serif pour les titres et les grands chiffres (le « 3 rendez-vous » du jour, les montants), la grotesque pour tout ce qui est fonctionnel.
- **Ambiances :** quelques palettes conçues, chacune en clair et en sombre, que la professionnelle choisit. Pas de couleurs libres partout.
- **Accent personnel :** sa couleur, avec une lisibilité garantie par calcul (même principe que le filet du labo).
- **Mouvement :** discret par nature (≤ 240 ms, jamais avant une action), avec trois niveaux au choix : Standard, Discret, Aucun. « Réduire les animations » du système l'emporte toujours.
- **Densité :** des cibles de 44 px, et l'agenda prioritaire. Rien ne s'anime avant que les données soient lisibles.

## 4. Personnalisation (Core)

| Réglage | Portée | Persistance |
| --- | --- | --- |
| Ambiance (Atelier, Lin, Sauge) | tout le back-office | tranche 1 : sur l'appareil (cookie) ; ensuite : son compte (backend) |
| Clair / Sombre / Système | idem | idem |
| Couleur d'accent (préréglages ou libre) | idem, lisibilité garantie | idem |
| Animations : Standard / Discret / Aucun | idem | idem |
| Widgets de l'accueil (afficher, masquer, ordonner) | accueil | backend |
| Image personnelle facultative | accueil | backend (stockage, taille et type contrôlés) |

**Rendu sans flash :**

- la préférence est un cookie lisible par le serveur ;
- le layout `/app` rend directement les bons attributs (`data-ambiance`, `data-mode`, `data-motion`) et l'accent ;
- un effet client les reporte sur `<html>` pour les panneaux rendus en portail (`Sheet`), et les retire à la sortie de `/app`.

**Tokens :**

- chaque ambiance redéfinit les mêmes variables sémantiques ;
- les composants ne changent pas, une fois les couleurs codées en dur remplacées ;
- des tests vérifient chaque couple texte/fond réellement utilisé, dans chaque ambiance, chaque mode et avec des accents aléatoires.

## 5. Suivi manuel des encaissements

### Principe

La professionnelle encaisse par ses propres moyens (espèces, ou carte sur un terminal qui n'est pas le nôtre), puis elle **déclare** le paiement reçu. Le SaaS ne fait aucune transaction.

- Un rendez-vous terminé n'est pas payé pour autant, et une réservation n'est pas un encaissement.
- **Montant attendu :** le prix figé du rendez-vous (`price_cents_snapshot`).
- **Montant reçu :** ce qu'elle déclare. Il peut différer : geste commercial, supplément, paiement partiel.

### Cadre réglementaire, à valider avant tout développement backend

Le BOFiP définit un système de caisse comme un outil qui mémorise et enregistre, hors comptabilité, les paiements reçus en contrepartie d'une vente ou d'une prestation (BOI-TVA-DECLA-30-10-30, version du 25/03/2026). Pour les professionnelles assujetties à la TVA qui servent des particuliers, ce module en relèverait très probablement.

- **Conditions ISCA :**
  - **Inaltérabilité :** aucune modification ni suppression ; une erreur se corrige par une écriture inverse, traçable.
  - **Sécurisation :** chaînage ou signature des écritures.
  - **Conservation :** 6 ans.
  - **Archivage :** clôtures périodiques (jour, mois, exercice) avec leurs totaux.
- **Justificatif :** un certificat d'un organisme accrédité (NF525, LNE), ou une **attestation individuelle de l'éditeur**. Cette dernière possibilité a été rétablie par la loi de finances 2026 (art. 125), après sa suppression par la loi de finances 2025.
- **Sanction :** une amende de 7 500 € par logiciel non justifié.
- **À trancher avec un expert-comptable ou un avocat fiscaliste :**
  - le cas des professionnelles en franchise en base de TVA (nombreuses parmi les micro-entrepreneuses de la beauté) ;
  - la portée exacte pour un enregistrement déclaratif sans terminal ;
  - le choix entre certification et attestation d'éditeur.

**Conséquence de conception :** même si une partie des utilisatrices n'est pas concernée, on conçoit dès le départ un **journal append-only conforme ISCA**. Le corriger après coup coûterait beaucoup plus cher.

### Contrat backend proposé (Claude Cloud ; rien n'est construit ici)

- **`payments`, en ajout seul :**
  - `id`, `business_id`, `appointment_id` (nullable : vente hors rendez-vous), `client_id` ;
  - `amount_cents` (> 0), `currency`, `method` (`cash`, `card_external`, `other`), `received_at` ;
  - `recorded_by`, `recorded_at`, `kind` (`payment`, `reversal`), `reverses_id` ;
  - `sequence` par établissement, `hash` chaîné (précédent, contenu) ;
  - pas d'`update`, pas de `delete` : RLS, révocation des droits et déclencheur de refus.
- **Correction :** une écriture `reversal` du montant opposé, avec un motif obligatoire, puis éventuellement une nouvelle écriture. L'historique garde les deux.
- **`payment_closures` :** clôture journalière, mensuelle et annuelle, avec totaux par méthode, plage de séquences et hash. C'est le support des indicateurs et de l'archivage.
- **Dérivés, jamais stockés :**
  - état d'un rendez-vous terminé : non encaissé, partiellement encaissé, encaissé ;
  - reste à encaisser ;
  - totaux du jour, de la semaine et du mois dans le fuseau de l'établissement ;
  - répartition carte / espèces.
- **Permissions :** membres de l'établissement uniquement (RLS existante). Pas d'accès cliente.
- **Tests :** isolation multi-tenant, concurrence (double clic, idempotence par `requestId`), chaînage, refus de modification.
- **Hors périmètre volontaire :** remboursements bancaires, paiements fractionnés complexes, TVA détaillée et facturation (pour l'instant).

### Interface prévue

- **Fiche du rendez-vous :**
  - « Terminé » propose « Encaisser » ;
  - montant prérempli au prix figé et modifiable, méthode, date ;
  - une confirmation explicite ;
  - correction : « Annuler cet encaissement » (motif), ce qui crée une écriture inverse.
- **Écran Encaissements :**
  - aujourd'hui, cette semaine, ce mois ;
  - carte / espèces ;
  - reste à encaisser, avec un accès direct aux rendez-vous non encaissés ;
  - historique, corrections comprises (lignes inverses visibles).
- **Accueil :** un widget avec l'encaissé du jour et le reste à encaisser.
- **Prototype :** avant le backend, ces écrans existent dans la galerie de prévisualisation, avec des données **explicitement fictives**. Aucun stockage, et aucun chemin vers des données réelles.

## 6. Préparer l'intégration avec le Studio (sans fusionner les branches)

- **Catalogue :**
  - une seule source de vérité, la table `services` ;
  - plus les catégories et options proposées par le labo (`docs/EXPERIENCE_ENGINE.md`, contrat backend) ;
  - l'écran Prestations du dashboard et l'onglet Prestations du Studio deviendront deux vues de la même donnée.
- **Réservations :** le mini-site publié réservera via `POST /api/bookings` existant, donc dans le même agenda.
- **Studio :** une entrée « Mon site » dans la navigation du dashboard, qui ouvrira le Studio (route à définir) avec la même session professionnelle.
- **Apparence :** les préférences du dashboard (ambiance, accent) sont distinctes du design du mini-site (ses univers). On pourra proposer « reprendre l'accent de mon site ».

## 7. Découpage en PR indépendantes

| # | PR | Contenu | Données / sécurité | Responsable |
| --- | --- | --- | --- | --- |
| 1 | **Apparence : fondations** | Couleurs codées en dur remplacées par des tokens ; ambiances claires et sombres ; accent garanti lisible ; niveaux d'animation ; page Apparence ; préférence par appareil (cookie) ; galerie de prévisualisation désactivée en production | Aucune donnée, aucune sécurité | Claude Code |
| 2 | Coquille partagée | `AppShell` dans le layout `/app` (plus de remontage), déplacée hors de `agenda` ; navigation repensée (Accueil, Agenda, Clientes, Prestations, Fidélité, Encaissements ; réglages groupés) | Lecture seule | Claude Code |
| 3 | Accueil et widgets | Aujourd'hui, prochains rendez-vous, à faire, fidélité ; ordre et visibilité des widgets | Lecture des données existantes | Claude Code |
| 4 | Préférences synchronisées | Table de préférences par membre (RLS), image personnelle (Storage) | Migration, RLS | Claude Cloud |
| 5 | Encaissements : backend | Journal ISCA, clôtures, actions, RLS, audit | Migration, conformité | Claude Cloud, avec validation d'un expert |
| 6 | Encaissements : interface | Fiche du rendez-vous, écran Encaissements, widget, branchés sur la PR 5 | Données réelles via les contrats de la PR 5 | Claude Code |
| 7 | Agenda | Déplacement rapide, « Terminer et encaisser », vue jour sur téléphone retravaillée | Actions existantes | Claude Code |
| 8 | Catalogue unifié | Catégories et options (backend), puis interface commune au dashboard et au Studio | Migration | Claude Cloud, puis Claude Code |

Chaque PR est auditée avant fusion. La PR 1 est la première tranche, livrée sur cette branche.
