# Polices auto-hébergées

Les polices sont servies depuis le dépôt avec `next/font/local`, et non
depuis Google Fonts. Le build ne dépend donc d'aucun service de polices :
un build qui échouait parce que Google Fonts répondait mal ne peut plus
arriver.

## Contenu

- **Source :** les fichiers complets du dépôt officiel
  [`google/fonts`](https://github.com/google/fonts) (`ofl/<famille>/`).
- **Deux fichiers par face**, comme les sert Google Fonts :
  - `<face>.woff2` : la plage « latin » ;
  - `<face>-ext.woff2` : la plage « latin-ext » (Ł, ő, ș, ğ…).

  Les deux portent le même nom de famille, chacun avec sa `unicode-range`
  (celles de Google Fonts). Un navigateur ne télécharge le fichier
  latin-ext que si la page contient l'un de ses caractères. Une page en
  français ne charge donc que le fichier latin, de la même taille que celui
  de Google.

- **Gardé :**
  - les fonctionnalités OpenType standard de `fontTools` (ligatures,
    crénage, accents, fractions) ;
  - les chiffres que l'application utilise : `tnum`, `lnum`, `pnum`,
    `onum`, `case`, `zero`.
- **Retiré :** le hinting.
- **Axes variables :** conservés tels que l'application les utilise : `wght`
  partout, `wdth` pour Archivo, `opsz` pour Newsreader. Pour les faces que
  Google servait sans taille optique, l'axe est figé à sa valeur par
  défaut, et leur rendu ne change donc pas.
- **Licence :** SIL Open Font License 1.1. Le texte de chaque famille est
  dans `licenses/`.

## Régénérer ou ajouter une police

Les fichiers ont été produits avec `fontTools` (`pyftsubset` : sortie
woff2, sans hinting, fonctionnalités standard plus `tnum`, `lnum`, `pnum`,
`onum`, `case` et `zero`), avec les plages latin et latin-ext de Google
Fonts. Pour ajouter une face :

1. Prendre le fichier complet dans `google/fonts`, avec son `OFL.txt`.
2. En tirer les deux fichiers.
3. Les déclarer comme les autres : une déclaration `localFont` latin
   (avec la variable CSS, le préchargement et le fallback), et une
   déclaration latin-ext sous le même `font-family`, sans préchargement.
   Chacune porte sa `unicode-range`.
