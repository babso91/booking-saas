# Ambiances « trio » — direction artistique

Statut : **prêt, base comprise**. La migration
`20261114100000_color_trios.sql` ajoute les six trios à la liste fermée des
préférences et fait d'Égyptien le défaut (colonne, lecture et enregistrement
d'une pro sans préférence). Les pros qui ont déjà choisi une ambiance la
gardent ; celles qui n'ont rien choisi passent en Égyptien, comme les pages
hors compte. Les trios sont proposés dans la page Apparence.

## La règle

Deux couleurs calmes font le travail en aplats (fond, encre, champ de
Studio) ; une troisième, forte, vient les casser **par touches** : l'action
principale, une marque, l'heure en cours. Jamais en fond.

| Trio     | Deux calmes                                    | Celle qui casse                        |
| -------- | ---------------------------------------------- | -------------------------------------- |
| Égyptien | bleu égyptien `#03203D`, bleu pierre `#639CC5` | écarlate `#E0262B`                     |
| Moka     | sable doux `#F0E5DB`, vert moka `#474329`      | rose pastèque `#FC75B4`                |
| Prune    | rose flamant `#FAC7E1`, prune `#A5467C`        | bleu électrique `#004AFD`              |
| Néon     | noir `#020306`, cyan `#7CE6FC`                 | magenta `#FC38BE` (`#D1009A` en clair) |
| Dune     | ocre dune `#AE6C37`, terre d'ombre `#2B1A12`   | turquoise `#1FC7C9`                    |
| Indigo   | noir indigo `#070C29`, os `#EFE7DA`            | ambre `#FF9E0D`                        |

Chaque trio existe en clair et en sombre. Les teintes fortes qui portent du
texte sont, au besoin, très légèrement approfondies pour rester lisibles
(écarlate `#EB2F33` → `#E0262B` sous un texte blanc).

## Jetons

- `--pop` / `--on-pop` / `--pop-hover` : la couleur forte, son texte, son
  survol (qui s'éloigne de la couleur du texte). Porte le **bouton
  principal**. Dans les ambiances neutres (Atelier, Lin, Sauge), le pop est
  l'encre : leur bouton ne change pas.
- `--mark` / `--on-mark` : la marque forte dans la composition d'un style
  (Studio : « Nouveau rendez-vous », bouton flottant mobile, étiquette et
  ligne de l'heure en cours). Trio : la couleur forte ; sinon le champ,
  comme avant.
- Le champ de Studio (`--signature`) prend la couleur calme du trio.

Toutes les paires texte/surface (et texte sur pop, sur pop survolé) passent
4,5:1, vérifiées par `appearance.test.ts` et `button-contrast.test.ts` dans
chaque style, ambiance et mode.

## Base de données

- Domaine `public.member_preference_ambiance` : les six trios ajoutés.
- Défaut `egyptien` : colonne `member_preferences.ambiance`,
  `read_member_preferences` (pas de ligne) et `save_member_preferences`
  (premier enregistrement), qui doivent rester d'accord, sinon un premier
  enregistrement depuis les défauts de l'appareil serait jugé périmé.
- `preferenceAmbiances` et les défauts TypeScript suivent ;
  `tests/integration/member-preferences.test.ts` vérifie l'accord.
