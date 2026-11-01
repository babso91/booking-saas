# Mémoire de continuité — direction produit du SaaS beauté

> **Snapshot : 1er novembre 2026 (Europe/Paris).** Ce document sert de point d'entrée aux nouvelles conversations et aux agents. Il **n'est pas** une preuve que le code est fusionné ou déployé. Mettre à jour les HEAD et statuts GitHub avant toute décision.  
> **Mode :** passation, sans merge ni déploiement. Les rapports de Claude et les audits Codex sont des éléments à vérifier, pas des preuves absolues.

## 0. Comment reprendre correctement

1. Lire ce document, puis [PRODUCT_SPEC.md](PRODUCT_SPEC.md), [ARCHITECTURE.md](ARCHITECTURE.md) et les contrats ciblés. La spec principale date du 28 septembre : certaines décisions plus récentes se trouvent sur des branches non fusionnées.
2. Relire **sur GitHub** les PR ouvertes, leurs HEAD, leurs bases, leurs audits et leurs CI. Ne jamais confondre une PR empilée avec `main`.
3. Conserver le rôle de **direction produit** dans ChatGPT : arbitrages, spécifications, critères d'acceptation et stress test. **Claude UI** (y compris « Claude UI labo », même agent) exécute l'UI/Experience Engine sur des branches isolées ; **Claude Cloud** traite backend/sécurité ; **Codex** réalise l'audit indépendant. Claude garde le droit de suggérer spontanément des améliorations techniques ; cela ne vaut pas validation produit.
4. Avant d'ouvrir une nouvelle tâche : consulter les contrats, choisir une base de branche explicite, préciser le périmètre et les non-objectifs, exiger des tests et un rapport de limites. Aucun merge, migration d'environnement ou déploiement sans décision explicite.

## 1. Vision et cible

Le produit s'adresse initialement aux **professionnelles indépendantes de la beauté**, mais ne doit **jamais être codé comme un outil réservé aux cils** : les cas réels couvrent aussi henné et épilation, avec extension à ongles, coiffure et autres prestations. Izabela est l'une des pilotes ; sa configuration staging doit pouvoir être conservée lors du passage en production par un processus explicite, sécurisé et contrôlé.

**Proposition de valeur :** la réservation est l'entrée ; la **fidélisation et la rétention** sont le différenciateur. Boucle : réservation → visite terminée → points → récompense → nouvelle réservation ; relance consentie si inactivité. Produit simple à utiliser mais robuste sous le capot. Ne pas le réduire à un clone de calendrier ou de Planity.

La cliente réserve depuis un **lien web**, sans application native obligatoire. Un espace cliente sans friction et, éventuellement, une carte fidélité Wallet sont des pistes ; ne pas transformer ces pistes en fonctionnalités déjà livrées.

**Multi-métiers :** sections, prestations, durées, prix et options doivent être configurables librement par établissement ; ne pas imposer de catégories « cils/sourcils ». Attention : l'état d'interface répertorié dans DASHBOARD_EXPERIENCE indique que catégories/options ne sont **pas encore implémentées**. Distinguer exigence produit et livraison effective.

## 2. Direction d'expérience : trois surfaces, qualité élevée

1. **Site marketing** : singulier, immersif, cinématique ; pas une landing page de template « SaaS IA ».
2. **Pages publiques et Client Hub** : mini-sites premium, composables et personnalisables par les professionnelles, adaptés à leur marque ; réservation et fidélité lisibles sans friction.
3. **Back-office** : sobre au quotidien, mais plusieurs **univers visuels réellement distincts**, pas de simples changements de couleurs.

Rejet des interfaces génériques / vibe-coded, néon sombre de circonstance ou simple reskin. Niveau visé : expérience originale et soignée, « effet agence à 10 000 € », **sans sacrifier vitesse, accessibilité, cohérence ni fiabilité**.

Décision de conception : **un moteur métier commun et plusieurs mises en scène**. Classique demeure la base ; **Studio** (planning mural, graphique), **Écrin** (cadran, temps tactile) et **Carnet** (éditorial) sont les univers prévus. À date Studio 1/2 et Écrin existent **en PR non fusionnées** ; Carnet n'est pas implémenté. Les écrans secondaires gardent leur logique partagée. Une préférence d'apparence individuelle n'est jamais la marque publique de l'établissement.

Consulter [DASHBOARD_EXPERIENCE.md](https://github.com/babso91/booking-saas/blob/feat/dashboard-experience/docs/DASHBOARD_EXPERIENCE.md) pour les choix d'origine, et les dossiers d'audit dans les branches de Studio et Écrin. Le laboratoire Experience Engine est séparé du moteur métier et ne doit pas contaminer les branches livrables.

## 3. Règles non négociables d'architecture

- **Next.js / TypeScript / Supabase PostgreSQL/Auth/RLS / Vercel / Resend** ; ajouter une dépendance seulement si elle est nécessaire et justifiée.
- **Multi-tenant strict** : données métier isolées par `business_id`, contrôles PostgreSQL/RLS et serveur ; le frontend, les cookies et les paramètres d'URL ne sont pas des frontières de sécurité.
- **Réservations** : contrainte transactionnelle contre les chevauchements ; idempotence, cas de course, tampons, exceptions, minuit et transitions DST ; calendrier natif autoritaire.
- **Google Calendar facultatif** : sync entrante des indisponibilités, sync sortante des rendez-vous, dérives et réconciliation ; Google n'est pas source de vérité métier et ne doit pas devenir obligatoire à l'inscription.
- **CRM et fidélité** : historique et notes internes avec droits stricts ; crédits de points uniquement sur visite terminée, une seule fois ; ledger explicable ; actions email idempotentes.
- **Données temporelles** : UTC en stockage, fuseau IANA de l'établissement pour les règles et rendus ; ne pas s'en remettre au fuseau du terminal. Ne pas masquer les bugs de changement d'heure.
- **Sécurité** : clés et rôles de service côté serveur, vérification des droits avant lecture/écriture, tests croisés entre comptes et établissements, aucune donnée réelle fictive dans un écran de production.
- **Qualité d'expérience** : cible tactile `44px`, support mobile fort, animations réduites, transitions réversibles, accessibilité et contrastes vérifiés. La CI verte seule ne suffit pas à valider l'UX.

**Ne pas confondre** `service_role` et un utilisateur normal : ce rôle contourne la RLS dans Supabase et possède des privilèges élevés ; encadrer ses usages explicitement.

## 4. État vérifié du dépôt au 1er novembre 2026

Dépôt : [babso91/booking-saas](https://github.com/babso91/booking-saas). Branche `main` observée à `249aff15cf4b7438fa48c9aeabe65238955d60c8` (backend Client Hub #25 intégré). Les points ci-dessous restent **en PR** ; ne pas les présenter comme présents sur `main`.

| PR | Sujet | Base | HEAD observé | État / prochaine porte |
| --- | --- | --- | --- | --- |
| [#26](https://github.com/babso91/booking-saas/pull/26) | Interface Client Hub | `main` | `51abf2c` | Open, Draft ; vérifier audit et dépendances |
| [#27](https://github.com/babso91/booking-saas/pull/27) | Tests dates/DST/emails | `main` | `7462aaa` | Open ; correctif reporté sur #31 sous `5222ad3`, attention aux doublons |
| [#28](https://github.com/babso91/booking-saas/pull/28) | Studio 1 | `main` | `e6c95bc` | Open, Draft ; déclaré audité dans les PR dépendantes |
| [#29](https://github.com/babso91/booking-saas/pull/29) | Studio 2 | `feat/dashboard-studio-1` | `2ee3795` | Open, Draft ; annoncé READY après Codex, **pas fusionné** |
| [#30](https://github.com/babso91/booking-saas/pull/30) | Écrin | `feat/dashboard-studio-2` | `cd3eb8d` | Open, Draft ; CI GitHub success (run `41254546564`) ; audit Codex attendu |
| [#31](https://github.com/babso91/booking-saas/pull/31) | Préférences professionnelles persistantes | `main` | `0d29cd4` | Open, Draft ; corrections de l'audit poussées ; CI GitHub success (run `41254917160`) ; **contre-audit Codex attendu** |

**Conséquence** : chaîne UI = `main → #28 → #29 → #30`. La persistance #31 est **indépendante sur main** ; son branchement avec la chaîne UI doit être conçu/testé explicitement, pas supposé. Les HEAD doivent être revérifiés à chaque reprise.

## 5. PR #31 : reprise après corrections de Claude Cloud

Rapport Claude sur `0d29cd4` : six constats Codex traités (réponses d'autres comptes, réintégration/version, `24:00` terminal, re-scellement d'un snapshot, limites du SHA-256, vrais droits `service_role`). Architecture déclarée : génération de contexte + membership + ticket de sauvegarde ; incarnation UUID de ligne + version par incarnation ; `context_changed` ; pause après 5 `stale` ; aucune persistance d'UI encore raccordée. Report de #27 conservé.

**Tests rapportés, non réexécutés indépendamment ici** : 1 358 unitaires ; 1 068 tests PostgreSQL/Server Actions ; 54 upgrade ; 9 E2E ; mutations 18/18 (migration), 13/13 (état). GitHub CI du HEAD confirmée verte.

**À mettre à l'épreuve par Codex avant READY :**
- une réponse A ne s'affiche ni ne termine une écriture chez B, même avec requêtes/réponses dans un ordre adversarial ;
- A → B → A, déconnexion/reconnexion, retrait puis réintégration répétée, recréation de ligne, faux échecs et base indisponible ;
- `service_role` peut toujours écrire directement : tester les garanties réelles de table et les procédures autorisées ;
- `24:00` valide seulement en **fin** de plage ; distinction entre données validées et interprétées ;
- transferts : SHA-256 **ne prouve ni auteur ni consentement**. Aucun transfert réel, aucune signature, aucune copie d'Auth à ce stade ;
- **risque UX** : changements non envoyés abandonnés à la sortie de l'ancien contexte ; sauvegarde en pause lorsque la base absente est traitée comme `unauthenticated` ; analyser récupération et message utilisateur.

**Contrat Claude UI**, à lire impérativement dans [MEMBER_PREFERENCES_CONTRACT.md §6](https://github.com/babso91/booking-saas/blob/0d29cd4/docs/MEMBER_PREFERENCES_CONTRACT.md) : `loadAreaPreferences` renvoie `snapshot` + `appearance`; requêtes d'écriture/import portent `context {businessId,membershipId}` et `expected {incarnation,version}` ; machine `initialSyncState`, `enterContext`, `nextSave`, `saveAnswered/saveFailed`, `startRead/readAnswered`. Ne pas brancher l'UI sur l'ancien contrat.

## 6. Écrin #30 : points ouverts pour le rapport Codex à recevoir

Dossier : [ECRIN_AUDIT.md](https://github.com/babso91/booking-saas/blob/feat/dashboard-ecrin/docs/ECRIN_AUDIT.md), surtout §§15–17. Dernier HEAD `cd3eb8d` (ne pas utiliser un SHA précédent). Vérifier le résultat de Codex pour ce **SHA précis**, et l'ensemble des régressions Studio/Classique.

Axes prioritaires : isolation inter-établissement après hydratation ; `AgendaView` partagé ; tampon et frontières minuit/DST ; `freeMinutes` vs créneau effectivement réservable ; protection du brouillon face à `?rdv=` ; `booking-host.tsx` et `NEXT_PUBLIC_APP_URL` build/runtime ; accessibilité, fiches et écrans partagés ; compatibilité avec #31. Selon dossier, aucun paiement ni nouvelle migration dans #30.

Suivis transversaux identifiés : [TRANSVERSAL_FOLLOWUPS.md](https://github.com/babso91/booking-saas/blob/feat/dashboard-ecrin/docs/TRANSVERSAL_FOLLOWUPS.md) — nom accessible du monogramme WCAG 2.5.3, année aux semaines à cheval sur le Nouvel An, distinction entre temps libre brut et temps réservable. Éviter de déclarer « WCAG complet » sur la seule base de `axe 0 violation`.

## 7. Décisions / sujets à ne pas inventer

- **Paiement en ligne** hors V1 de départ. Le **suivi manuel des encaissements** a été exploré ultérieurement, mais **aucun backend d'encaissement n'est livré** ; une analyse juridique/fiscale française spécialisée est requise avant son développement. Ne jamais afficher un chiffre d'affaires encaissé à partir du simple prix d'un rendez-vous.
- **Personnalisation établissement** (logo, photos, mini-site, futurs `business_branding`/Storage) ≠ **préférences professionnelles** par membership #31. Aucun transfert staging → production effectif pour l'instant.
- **Carnet** prévu mais non implémenté ; le backend #31 peut connaître la valeur avant l'UI. Le rendu doit rester sûr avec une valeur non supportée.
- **Experience Engine** : laboratoire de recherche UI, isolé des PR métiers ; une belle démo n'est pas un produit valide.
- Les règles de catégories/options, l'éventuelle fidélité Wallet et les futures intégrations demandent une spécification et une PR dédiées, sans gonfler silencieusement le périmètre d'une PR de stabilisation.
- Le cahier des charges initial n'est pas automatiquement la vérité sur l'avancement du code ; le dernier état GitHub et les contrats versionnés priment pour toute affirmation de livraison.

## 8. Prochaines actions

1. Recevoir le **rapport Codex sur Écrin #30**, relever sévérité, reproductions, HEAD visé et verdict ; arbitrer corrections ou READY.
2. Déclencher / lire le **contre-audit de #31 au HEAD `0d29cd4`**. Demander preuves, pas seulement nombre de tests.
3. Préparer une **PR d'intégration UI ↔ préférences** après convergence des bases, avec tests de contexte et rendu sans flash.
4. Ne pas confondre « READY » de l'audit et permission de merge. Vérifier la chaîne #28 → #29 → #30, les branches, les migrations nécessaires, staging, rollback et validation visuelle réelle.
5. Mettre à jour ce document à chaque décision majeure, en inscrivant **date, auteur, source, statut, SHA, impact et prochaine action**. Garder les spécifications de détail dans leurs contrats d'origine ; le présent fichier est l'index stratégique, pas une copie géante.

### Modèle de décision à ajouter lors des prochaines sessions

| Date | Décision | Pourquoi / alternatives | Statut (proposée, acceptée, rejetée, livrée) | Source | Impact / suite |
| --- | --- | --- | --- | --- | --- |
| 2026-11-01 | Créer une mémoire de continuité versionnée | Une conversation a atteint sa limite ; éviter une direction dépendante de l'historique du chat | Acceptée ; document en revue | Direction produit | Actualiser après les audits de #30 et #31 |

---
**Règle finale :** ne jamais marquer une fonctionnalité « livrée » sur la seule foi d'un rapport d'agent. Distinguer **objectif produit**, **implémenté en branche**, **audité**, **fusionné**, **migré**, **déployé** et **testé par une vraie professionnelle**.
