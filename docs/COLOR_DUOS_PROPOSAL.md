# Ambiances « duo » — proposition (direction artistique)

Statut : **côté écran prêt, en attente d'une migration de Cloud** pour être
choisi et gardé sur le compte. Visible dès maintenant dans les aperçus via
`?apparence=<duo>.<light|dark>.standard.-.<style>`, par exemple
`/apercu/studio/aujourdhui?apparence=egyptien.dark.standard.-.studio`.

## L'idée

Deux couleurs calmes, assumées, posées en aplats : un ton profond et son
frère clair, ou un noir teinté et un seul accent. C'est la couleur « qui
manque ailleurs » qui rend l'espace reconnaissable, au lieu d'un crème
neutre partout.

| Duo      | Clair (fond / encre / accent)     | Sombre (fond / encre / accent)    |
| -------- | --------------------------------- | --------------------------------- |
| Égyptien | `#E7EEF5` / `#03203D` / `#1E5A8C` | `#03203D` / `#EAF2F9` / `#8FC0E6` |
| Moka     | `#F0E5DB` / `#2A2817` / `#474329` | `#1E1C10` / `#F0E5DB` / `#C9BE8E` |
| Prune    | `#FBE9F2` / `#3A1028` / `#94386D` | `#2A0D1E` / `#FFE9F4` / `#F7A8D0` |
| Indigo   | `#ECEEF8` / `#070C29` / `#0B6F78` | `#070C29` / `#EEF1FF` / `#5FE3EC` |
| Dune     | `#F3E9DD` / `#0B0B0C` / `#8A4F22` | `#0B0B0C` / `#F3E9DD` / `#D48A4E` |

Chaque duo définit les mêmes jetons sémantiques que les ambiances
existantes ; toutes les paires texte/surface utilisées par les écrans sont
vérifiées (4,5:1) par `appearance.test.ts`, en clair et en sombre.

## Ce qui change à l'écran

- Une ambiance duo est le **fond de tous les styles** (Classique, Studio,
  Écrin, Carnet). Les ambiances neutres existantes ne changent pas.
- Studio : sans couleur choisie, son champ prend la couleur du duo.
- Tous les écrans passent par les jetons : ceux déjà faits et ceux à venir
  prennent le duo sans être réécrits.

## Pour Cloud (seule dépendance)

Ajouter `egyptien`, `moka`, `prune`, `indigo`, `dune` à la liste fermée
`private.member_preferences_valid` (ambiance) et à
`preferenceAmbiances` (`src/features/preferences/model.ts`), test
`tests/integration/member-preferences.test.ts` compris. Dès que la liste les
contient, le sélecteur Apparence les propose ; avant, il ne les propose pas
et le fournisseur n'envoie jamais au compte une ambiance refusée.
