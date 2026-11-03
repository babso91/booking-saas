# Carnet : dossier d'audit (le carnet imprimé)

Branche `feat/dashboard-carnet`, partie du commit combiné `1ff74ea` (`refs/pull/35/merge`), puis synchronisée par un merge avec `main` `1ca2d38` (#35 fusionnée ; arbre identique au socle de départ). La PR est basée sur `main`. Carnet n'est pas déclaré READY : ce dossier prépare l'audit de Codex. HEAD, diff et résultats CI : voir le corps de la PR.

**Hors périmètre :** aucune migration, RPC, RLS ni Server Action ; aucune dépendance. Deux polices Google chargées par `next/font`, sans préchargement (Newsreader, IBM Plex Mono).

## 1. Architecture : un seul moteur, une quatrième mise en scène

`AgendaView` reste le contrôleur unique. En style Carnet, il délègue le dessin à `CarnetAgenda`, avec le contrat de Studio et d'Écrin (`StudioAgendaProps`). Lectures, « aujourd'hui » validé par PostgreSQL, fiches, formulaires, actions, conflits, statuts, fuseaux : rien n'est réimplémenté. Le placement vient de `agenda/client/layout.ts`, les modèles de `todayModel` et `dayFlow`.

| Fichier (`features/dashboard/carnet/`) | Rôle                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `carnet-shell.tsx`                     | Feuille sur le bureau, titre courant, onglets sur la tranche, ruban téléphone |
| `carnet-today.tsx`                     | Page du jour : date, phrase, ordre du jour, marge                             |
| `carnet-entries.tsx`                   | Le jour écrit : entrées, tampons, renvois, pauses, temps libre                |
| `carnet-margin.tsx`                    | Registre, notes par renvoi, semaine en fioles                                 |
| `carnet-agenda.tsx`                    | En-tête, vues, bande des dates, « + Noter », balayage, retour sur l'onglet    |
| `carnet-week.tsx`                      | Semaine en double page                                                        |
| `folio.ts`                             | Pur : semaine ISO, page de l'année, titres de semaine, phrase du jour         |
| `carnet.module.css`                    | Le langage imprimé, uniquement sur les jetons sémantiques                     |

**Palettes sans migration.** Les variantes du prototype (Terre, Encre, Olive) réutilisent `ambiance`, déjà stockée : `atelier` = Sienne, `lin` = Encre bleue, `sauge` = Olive, en clair et en sombre. L'accent reste son encre. Revenir en Classique rend son ambiance intacte (testé).

## 2. Fonctionnalités couvertes

| Geste                                           | Comment                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ouvrir un rendez-vous                           | Fiche partagée `AppointmentDetails`, depuis la semaine, le jour ou l'accueil (`?rdv=`) |
| Créer                                           | Formulaire de l'agenda : bouton, temps libre, clic dans la semaine, « Noter » partout  |
| Modifier, terminer, absente, annuler            | Fiche partagée, mêmes actions                                                          |
| Pauses et fermetures                            | Hachurées, ouvrent le formulaire de blocage ; « Bloquer un créneau »                   |
| Naviguer                                        | Semaine, jour, aujourd'hui, bande des dates, balayage, onglets, ruban, « Plus »        |
| Annulés                                         | Affichés sur demande, barrés, tamponnés                                                |
| Clientes, Prestations, Fidélité, Horaires, etc. | Composants partagés, habillés sous `[data-style="carnet"]`                             |
| Style, papier, encre, sombre, animations        | Page Apparence, sauvegardés sur son compte                                             |

**Seul ajout au contrôleur :** `initialCreate` (`/app?noter=1`), pour « Noter » depuis une autre page. Il ouvre le formulaire une fois, puis retire le paramètre de l'adresse. Les autres styles ne l'utilisent pas.

## 3. Comparaison avec le prototype

| Prototype                                    | Livré                                                                                              | Pourquoi                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Page, date géante, phrase du jour            | Conservés ; phrase calculée depuis l'agenda                                                        | La signature                                                            |
| « Deux premières fois », « neuvième visite » | Retirés ; seul « pris en ligne » est surligné                                                      | L'agenda ne sait pas le dire : rien n'est inventé                       |
| Onglets sur la tranche, ruban                | Conservés ; mêmes mots que les autres styles, avec Fidélité et Réglages                            | Invariant « mêmes rubriques, mêmes mots »                               |
| **Caisse du jour** (`useState`)              | **Remplacée par le Registre** : rendez-vous, passés, à venir, en ligne, temps libre. Aucun montant | Pas de backend de paiement : aucun chiffre d'affaires, un test l'impose |
| **Tampon « Réglé »**                         | **Tampons de ses vrais statuts** : Terminé, Absente, Annulé. Pas d'« Encaisser »                   | Idem                                                                    |
| Prix sur chaque entrée                       | Retiré ; le prix convenu reste dans la fiche partagée                                              | Même règle que Studio et Écrin                                          |
| Notes en marge, visibles                     | Renvois ¹ visibles ; texte sur demande                                                             | Une cliente peut voir l'écran                                           |
| Double page, 6 jours (3 + 3)                 | 7 jours (3 + 4), heures sur chaque page, pli central                                               | Une visite du dimanche ne doit jamais disparaître                       |
| Téléphone : grille d'un jour                 | Jour écrit, sur `dayFlow` ; bande des dates, « + Noter » au pouce, balayage                        | Lisible avec des visites courtes et des chevauchements                  |
| Fioles de la semaine                         | Conservées, chaque jour mène à l'agenda ; fermé = hachuré                                          | Calcul réel (`bookableMinutes`)                                         |
| Pli, pages empilées, surligneur, hachures    | Conservés, sur les jetons                                                                          | Sombre et encres libres gardent leur lisibilité                         |

Améliorations proposées : « + noter » sur chaque temps libre à venir, une annotation « Prochain, dans 55 min », le temps gardé écrit en toutes lettres, un tampon qui s'imprime quand un statut change sous ses yeux (respecte les réglages d'animation).

## 4. Cas limites

Journées chargées et denses (`jeu=charge`, `jeu=dense`) ; rendez-vous courts (forme compacte) ; tampons (queue pointillée non cliquable, aucune pour un annulé) ; chevauchements (couloirs en semaine, accolade et phrase en jour) ; minuit (« jusqu'à demain », « depuis hier ») ; fuseaux (décalages de PostgreSQL, jamais ceux du navigateur) ; semaine à cheval sur l'année (semaine 53, double année) ; heure répétée d'automne (`2ᵉ fois`, occurrence) ; jour fermé, fermeture exceptionnelle et partielle ; noms très longs ; cookies hostiles.

## 5. Vérifications

- **Unitaires et composants :** `folio.test.ts`, `carnet.test.tsx` (sur le vrai `AgendaView`), palettes sur 150 encres aléatoires par papier et par mode, contraste des boutons, changement de style sans fuite.
- **Navigateur sur aperçus (Chromium + axe-core, WCAG 2.1 AA, local) :** 138 passages, largeurs 320, 375, 390, 768, 1024, 1440 ; 3 papiers, clair et sombre, 2 encres difficiles ; 9 scénarios. Aucune violation, aucun défilement horizontal. Une seule cible trop petite trouvée (le nom de l'établissement), corrigée ; le balayage n'a pas été relancé en entier après ce correctif. Fiche au repos : aucune violation. Interactions réelles : fiche et retour du focus, jour/semaine, semaine suivante, Réglages, menu Options dans l'écran à 320 px, « Plus ».
- **Parcours avec backend réel (CI seulement, pas de Docker sur ce poste) :** `tests/e2e/carnet-agenda-browser.test.ts` (fiche, accueil, isolation entre établissements avec capture réseau, création et refus d'un chevauchement en page et en base, brouillon protégé, `?noter=1`, liens malformés, retour sur l'onglet, changement de style, axe sur quatre apparences, téléphone 320, 375, 390) et `tests/e2e/carnet-secondary-browser.test.ts` (écrans partagés, ordinateur et téléphone, clair et sombre, axe).

**Persistance du quatrième style.** Un parcours e2e choisit Carnet, le papier Encre bleue, Sombre et l'encre Prune dans Apparence. Il vérifie la ligne `member_preferences` (`style = carnet`, `ambiance = lin`, `color_mode = dark`, accent), puis le rendu après rechargement. Le changement de style Carnet → Studio → Classique → Écrin → Carnet est rejoué avec rechargement à chaque étape.

**Captures.** Les parcours e2e enregistrent chaque écran contrôlé (vraies données, ordinateur et téléphone, clair et sombre, quatre apparences). `ci.yml` les publie dans l'artefact `screens`, en `if: always()`, sans rien comparer. Cette étape est un ajout à la CI partagée, à retirer avant fusion si on préfère.

**Stabilité des tests.** Deux échecs e2e venaient des tests : un bouton radio masqué coché directement et une colonne mal nommée, dans mon nouveau test, puis un rechargement avant l'acquittement de la sauvegarde. Ce dernier, vu une fois, existait aussi dans le test d'Écrin dont le mien est copié : les deux attendent désormais « Enregistré sur ton compte. ».

## 6. Régressions possibles sur Classique, Studio et Écrin

| Fichier partagé                                        | Changement                                                                                               | À regarder                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `app/layout.tsx`                                       | Deux polices, sans préchargement                                                                         | Poids de la page : seulement à l'usage                         |
| `agenda-view.tsx`                                      | Choix de la présentation ; `initialCreate`                                                               | Sans `?noter=1`, l'effet ne fait rien                          |
| `app-shell.tsx`, `today/page.tsx`, `app/page.tsx`      | Routage                                                                                                  | Lignes ajoutées uniquement                                     |
| `appearance.ts`, `palettes.ts`                         | Valeur `carnet`, `carnetPapers`                                                                          | Les autres styles passent par les mêmes branches qu'avant      |
| `appearance-settings.tsx`                              | Quatrième choix, grille `sm:2 / xl:4` pour tous                                                          | Mise en page de la page Apparence dans **tous** les styles     |
| `globals.css`                                          | Bloc sous `[data-style="carnet"]`                                                                        | Aucun autre sélecteur touché                                   |
| `ci.yml`, `.gitignore`, `tests/e2e/support/capture.ts` | Captures publiées en artefact                                                                            | Aucun effet sur le résultat de la CI                           |
| `tests/e2e/ecrin-agenda-browser.test.ts`               | Attente de l'enregistrement avant rechargement                                                           | Même garantie, sans course                                     |
| Tests existants                                        | « Carnet s'affiche en Classique » devient « en Carnet » ; `cahier` remplace `carnet` comme style inconnu | Garantie conservée (style inconnu = Classique), valeur changée |

Un compte déjà en `carnet` en base passe de Classique à Carnet au déploiement : c'est l'effet voulu.

## 7. Limites

- Le scénario de refus et l'isolation ne sont prouvés qu'en CI ; les contrôles visuels locaux portent sur des aperçus sans base.
- Écrans secondaires : mêmes composants, donc encore des cartes aux angles presque carrés, pas une réécriture éditoriale. Vérifiés en CI, pas au même niveau d'art que l'accueil et l'agenda.
- Le changement d'heure et la semaine à cheval sur l'année sont testés en composant, pas vus sur un aperçu : les jeux d'essai sont fixés à octobre 2026.
- `carnet-week.tsx` et `carnet-agenda.tsx` reprennent de petits blocs d'Écrin (colonnes de la semaine, balayage, retour sur l'onglet) plutôt que de toucher Écrin. Une factorisation est possible après validation.
- Encaissement : aucun bouton ni montant. Sa place est la fiche partagée, puis le Registre, quand le backend existera.
- Comme en Studio et Écrin, les notes internes restent dans la charge React même repliées.

## 8. Réponse à l'audit Codex de `00593e1` (2 IMPORTANT, 1 MINOR)

### IMPORTANT 1 : un établissement ne voit rien d'un autre (`d1ffc6e`)

- Cause : rien ne liait l'état client à l'identité serveur. Une page rendue à nouveau pour B (actualisation, navigation sur la même page) gardait l'état React de A : rendez-vous lus, prestations, panneaux, notes dépliées.
- Correction : chaque page passe à `AppShell` l'identité résolue par son garde `requireReadyBusiness()` (utilisateur, établissement, membership ; `area-identity.ts`). La coquille et toute la page sont clées sur elle : une autre identité, ou la même entreprise sous une membership renouvelée, repart de rien. Les réponses encore en route arrivent dans des composants démontés et ne s'affichent jamais. La clé provient du rendu de la page, pas du layout : Next ne re-rend pas un layout partagé lors d'une navigation douce, alors que la page l'est toujours. `cacheComponents` (Activity) n'est pas activé ; s'il l'était, la clé suivrait encore le rendu de la page. Une date, un style ou une page différents dans la même identité ne réinitialisent rien.
- Identité perdue : une lecture refusée (`unauthenticated`, `no_business`, `forbidden`) n'affiche plus la période lue auparavant ni un panneau ouvert.
- Voisin trouvé en chemin : le lien de retour vers le répertoire Clientes (sessionStorage) est rangé par identité ; une recherche faite dans A ne devient plus le lien d'une fiche de B.
- Tests (`area-isolation.test.tsx`, vrai parent React sans démontage, en Classique, Studio, Écrin et Carnet) : fiche et note ouvertes, lecture de A retardée, prestations de A lues ou en route, membership renouvelée, brouillon conservé pour la même identité, lecture refusée, notes d'Aujourd'hui. Sans la correction, 20 sur 27 échouent ; les 7 restants sont les cas « même identité ».

### IMPORTANT 2 : le tampon de la veille (`4d6e315`)

- Cause : Aujourd'hui lisait sa semaine à partir du lundi. Un dimanche 23 h 30–23 h 50 suivi de 30 min de tampon n'était pas lu : 2 h libres annoncées au lieu de 1 h 40.
- Correction : `readTodayWeek` lit comme l'agenda, avec `agendaRangeWithBuffers` puis `restrictToDays(…, { buffers: true })`. La veille n'est pas un jour de la semaine, et sa visite ne compte pas parmi celles du lundi : elle ne fait que tenir du temps. Studio et Écrin comptent des visites, pas du temps libre : leur texte est identique avec ou sans elle.
- Tests : en composant (fin de semaine, de mois, d'année, dimanche de 25 h, tampon finissant pile à l'ouverture, sans tampon) ; sur PostgreSQL (`tests/integration/today-week.test.ts`, horaires réels, Paris, New York, Auckland). Sans la correction, 8 sur 12 échouent en composant.

### MINOR : rendez-vous très courts (`6bf0939`)

- Chaque visite reçoit au moins 24 px à partir de son début exact. Quand ces cibles se chevaucheraient et qu'une visite est trop courte pour la sienne :
  - les visites restent tracées à leur place exacte ;
  - une accolade, dans la marge du jour, les rassemble : « N rendez-vous rapprochés, de … à …, voir la liste » ;
  - elle ouvre une liste (une ligne de 57 px par visite), puis la fiche habituelle.
- Une visite courte isolée garde sa propre cible, de 24 px. Les visites longues côte à côte ne changent pas.
- Vérifié dans un vrai navigateur à 768, 1024 et 1440 px, en clair et en sombre :
  - axe WCAG 2.2 AA sans violation ;
  - aucune cible sous 24 px, aucun chevauchement ;
  - toucher sur tablette, clavier (Entrée, Tab, Échap avec retour du focus sur l'accolade).
- Aperçu : `/apercu/carnet/agenda?jeu=courts`.

### Limites restantes

- Une visite très courte qui touche une visite longue partage l'accolade avec elle : la longue reste tracée et nommée, mais s'ouvre depuis la liste.
- Le cas A → B est prouvé en composant, avec un vrai parent React, et non dans un parcours e2e qui ferait basculer une session entre deux établissements : l'application ne propose pas encore de changer d'établissement.
- Studio et Écrin n'ont pas reçu l'accolade : leurs grilles gardent leur propre traitement des visites courtes.
