# Polices auto-hébergées

Les polices de l'application sont servies depuis le dépôt via
`next/font/local`, et non depuis Google Fonts. Le build ne dépend donc
d'aucun service de polices : un build qui échouait parce que Google Fonts
répondait mal ne peut plus arriver.

## Contenu

- **Source :** les fichiers complets du dépôt officiel
  [`google/fonts`](https://github.com/google/fonts) (`ofl/<famille>/`).
- **Sous-ensemble :** une seule woff2 par face, avec les plages Unicode
  « latin » et « latin-ext » de Google Fonts. Les prénoms et noms
  d'Europe (Ł, ő, ș, ğ…) restent dans la police au lieu de basculer sur
  une police système.
- **Préservé :** toutes les fonctionnalités OpenType sont conservées, dont
  les chiffres tabulaires (`tnum`).
- **Supprimé :** le hinting, comme pour les fichiers que sert Google.
- **Axes variables :** conservés tels que l'application les utilise :
  - `wght` partout ;
  - `wdth` pour Archivo ;
  - `opsz` pour Newsreader.

  Pour les faces que Google servait sans taille optique, l'axe `opsz` est
  figé à sa valeur par défaut. Leur rendu ne change donc pas.

- **Licence :** toutes ces polices sont sous SIL Open Font License 1.1. Le
  texte de chaque famille est dans `licenses/`.

| Fichier                                                   | Famille          | Utilisation                          |
| --------------------------------------------------------- | ---------------- | ------------------------------------ |
| `hanken-grotesk.woff2`                                    | Hanken Grotesk   | texte (`--font-body`)                |
| `instrument-serif.woff2`, `instrument-serif-italic.woff2` | Instrument Serif | titres (`--font-serif`)              |
| `archivo.woff2`                                           | Archivo          | style Studio (`--font-studio`)       |
| `marcellus.woff2`                                         | Marcellus        | style Écrin (`--font-engraved`)      |
| `jost.woff2`                                              | Jost             | style Écrin (`--font-ecrin`)         |
| `newsreader.woff2`, `newsreader-italic.woff2`             | Newsreader       | style Carnet (`--font-carnet-serif`) |
| `ibm-plex-mono-400.woff2`, `ibm-plex-mono-500.woff2`      | IBM Plex Mono    | style Carnet (`--font-carnet-mono`)  |

## Régénérer ou ajouter une police

Les fichiers ont été produits avec `fontTools` (`pyftsubset` : sortie
woff2, `--layout-features='*'`, `--no-hinting`, plages latin et latin-ext
de Google Fonts). Pour ajouter une face :

1. Prendre le fichier complet dans `google/fonts`, avec son `OFL.txt`.
2. Le découper avec les mêmes options.
3. Le déclarer avec `localFont`, en précisant sa plage de graisses
   (`weight: "100 900"` pour une police variable) et son fallback
   (`sans-serif`, `serif` ou `monospace`, avec
   `adjustFontFallback: "Times New Roman"` pour un serif).
