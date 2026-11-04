// The professional area's ambiances. Each one defines the SAME semantic
// tokens as src/app/globals.css (the components only know those names), in
// a light and a dark version, designed, not generated. "Atelier · clair" is
// the identity the app always had (globals.css), unchanged.
//
// Every text/surface pair the screens use is checked in palettes.test.ts
// (4.5:1), in every ambiance and mode.

export type Mode = "light" | "dark";
export type AmbianceId = "atelier" | "lin" | "sauge";

export type Palette = {
  paper: string;
  paperRaised: string;
  sand: string;
  sandDeep: string;
  line: string;
  lineStrong: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  success: string;
  successSoft: string;
  successStrong: string;
  danger: string;
  dangerSoft: string;
  dangerStrong: string;
  warning: string;
  warningSoft: string;
  warningStrong: string;
  /** Shadows' colour, as "r g b" (they get their own alpha). */
  shadowRgb: string;
};

export const ambiances: Record<
  AmbianceId,
  { name: string; mood: string; light: Palette; dark: Palette }
> = {
  atelier: {
    name: "Atelier",
    mood: "Ivoire chaud, espresso, bois de rose",
    light: {
      paper: "#F6F1EA",
      paperRaised: "#FFFCF8",
      sand: "#ECE2D5",
      sandDeep: "#E1D3C2",
      line: "#E0D4C6",
      lineStrong: "#C9B6A2",
      ink: "#231C18",
      inkSoft: "#594E47",
      inkMuted: "#756960",
      accent: "#97493A",
      accentStrong: "#7C3A2D",
      accentSoft: "#F2E2D8",
      success: "#3D6A4C",
      successSoft: "#E2ECE3",
      successStrong: "#2C4F38",
      danger: "#9C3D2E",
      dangerSoft: "#F7E3DC",
      dangerStrong: "#7A2F23",
      warning: "#8A5A1C",
      warningSoft: "#F6EAD4",
      warningStrong: "#6B4613",
      shadowRgb: "35 28 24",
    },
    dark: {
      paper: "#16120F",
      paperRaised: "#1F1A16",
      sand: "#2A231E",
      sandDeep: "#352C26",
      line: "#3A312B",
      lineStrong: "#5A4C42",
      ink: "#F4EDE5",
      inkSoft: "#D3C6B9",
      inkMuted: "#B0A293",
      accent: "#E09A84",
      accentStrong: "#F0B9A7",
      accentSoft: "#3B2620",
      success: "#86C09A",
      successSoft: "#1C2B21",
      successStrong: "#AEDABB",
      danger: "#EE9682",
      dangerSoft: "#3B1F19",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#33281A",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
  lin: {
    name: "Lin",
    mood: "Blanc de lin, graphite, bleu ardoise",
    light: {
      paper: "#F4F3F0",
      paperRaised: "#FFFFFF",
      sand: "#E9E7E2",
      sandDeep: "#DDDAD3",
      line: "#DEDBD4",
      lineStrong: "#BCB7AD",
      ink: "#1C1C1A",
      inkSoft: "#4C4A45",
      inkMuted: "#68655E",
      accent: "#3A5779",
      accentStrong: "#2B425D",
      accentSoft: "#E2E8F0",
      success: "#3B6849",
      successSoft: "#E1EBE3",
      successStrong: "#2A4D35",
      danger: "#A03C2E",
      dangerSoft: "#F6E1DC",
      dangerStrong: "#7B2D22",
      warning: "#875819",
      warningSoft: "#F4E8D3",
      warningStrong: "#684412",
      shadowRgb: "28 28 26",
    },
    dark: {
      paper: "#131315",
      paperRaised: "#1B1B1E",
      sand: "#25252A",
      sandDeep: "#2F2F35",
      line: "#34343A",
      lineStrong: "#52525A",
      ink: "#EEEDEA",
      inkSoft: "#C9C8C3",
      inkMuted: "#A4A39D",
      accent: "#93B3DB",
      accentStrong: "#B9CFEB",
      accentSoft: "#1E2836",
      success: "#86C09A",
      successSoft: "#1B2A20",
      successStrong: "#AEDABB",
      danger: "#EE9682",
      dangerSoft: "#3A1E19",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#322719",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
  sauge: {
    name: "Sauge",
    mood: "Vert sauge, encre de forêt, terracotta",
    light: {
      paper: "#EEF0EA",
      paperRaised: "#FAFBF7",
      sand: "#E1E5DA",
      sandDeep: "#D4DACB",
      line: "#D6DBCE",
      lineStrong: "#B2BBA5",
      ink: "#1D2620",
      inkSoft: "#47544A",
      inkMuted: "#5F6C61",
      accent: "#97553A",
      accentStrong: "#77412B",
      accentSoft: "#F1E2D8",
      success: "#3A6847",
      successSoft: "#DFEADF",
      successStrong: "#294D34",
      danger: "#9E3C2E",
      dangerSoft: "#F5E1DB",
      dangerStrong: "#7A2E23",
      warning: "#865818",
      warningSoft: "#F2E7D1",
      warningStrong: "#674412",
      shadowRgb: "29 38 32",
    },
    dark: {
      paper: "#131815",
      paperRaised: "#1A201C",
      sand: "#232B25",
      sandDeep: "#2D362F",
      line: "#323C34",
      lineStrong: "#4F5B51",
      ink: "#EAEEE6",
      inkSoft: "#C3CBBE",
      inkMuted: "#9EA897",
      accent: "#DE9C7E",
      accentStrong: "#EDBAA2",
      accentSoft: "#37261F",
      success: "#8AC39C",
      successSoft: "#1C2B21",
      successStrong: "#B0DBBD",
      danger: "#EE9682",
      dangerSoft: "#3A1F19",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#322819",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
};

/** Accents to pick from in one tap (any colour is also possible). */
export const accentPresets = [
  { name: "Bois de rose", color: "#97493A" },
  { name: "Ardoise", color: "#3A5779" },
  { name: "Terracotta", color: "#B05A35" },
  { name: "Prune", color: "#7A3E66" },
  { name: "Forêt", color: "#2F6B4F" },
  { name: "Encre", color: "#2B2B6E" },
] as const;

// ——— Styles ———
// A style is the whole design of her area: composition, navigation,
// typography. "Classique" is the area as it was, worn in her ambiance.
// "Studio" is a poster: one family pushed across its widths, a neutral
// ground (its own, not an ambiance) and her signature colour as a field.
// The components still only know the semantic tokens; a style brings its
// own neutrals and how big moments are set.

export type StyleId = "classique" | "studio" | "ecrin" | "carnet";

export const styles: Record<StyleId, { name: string; line: string }> = {
  classique: {
    name: "Classique",
    line: "Sobre et posé, dans l’ambiance de ton choix.",
  },
  studio: {
    name: "Studio",
    line: "Graphique et direct : ta journée comme une affiche, ta couleur en grand.",
  },
  ecrin: {
    name: "Écrin",
    line: "Délicat et tactile : ta journée sur un cadran, des matières douces.",
  },
  carnet: {
    name: "Carnet",
    line: "Éditorial et imprimé : ta journée écrite à l’encre, tes notes en marge.",
  },
};

/** Studio's neutrals; her signature colour does the rest. */
export const studioPalettes: Record<Mode, Palette> = {
  light: {
    paper: "#F1EFEA",
    paperRaised: "#FBFAF7",
    sand: "#E6E3DC",
    sandDeep: "#DAD6CD",
    line: "#D9D6CF",
    lineStrong: "#B4B0A7",
    ink: "#0E0E10",
    inkSoft: "#46464D",
    inkMuted: "#5F5F67",
    accent: "#2333C9",
    accentStrong: "#1A2696",
    accentSoft: "#E0E3FB",
    success: "#2F6743",
    successSoft: "#DFEBE1",
    successStrong: "#224D31",
    danger: "#A3361F",
    dangerSoft: "#F7E0D9",
    dangerStrong: "#7C2817",
    warning: "#835615",
    warningSoft: "#F3E6CF",
    warningStrong: "#664210",
    shadowRgb: "14 14 16",
  },
  dark: {
    paper: "#0C0C0E",
    paperRaised: "#161619",
    sand: "#1F1F23",
    sandDeep: "#29292E",
    line: "#2C2C31",
    lineStrong: "#4A4A52",
    ink: "#F2F1EE",
    inkSoft: "#C0C0C7",
    inkMuted: "#9C9CA5",
    accent: "#9AA5FF",
    accentStrong: "#BCC3FF",
    accentSoft: "#1D2255",
    success: "#86C09A",
    successSoft: "#17251B",
    successStrong: "#AEDABB",
    danger: "#F09A84",
    dangerSoft: "#3A1C15",
    dangerStrong: "#F7BBAD",
    warning: "#E2AE63",
    warningSoft: "#2F2416",
    warningStrong: "#F0CD97",
    shadowRgb: "0 0 0",
  },
};

/** Studio's signature colours, in one tap (any colour is also possible). */
export const signaturePresets = [
  { name: "Cobalt", color: "#2D3FE6" },
  { name: "Tomate", color: "#F2512E" },
  { name: "Pistache", color: "#C3DD4F" },
  { name: "Fuchsia", color: "#D9367F" },
  { name: "Émeraude", color: "#14865F" },
  { name: "Encre", color: "#1B1B2F" },
] as const;

export const STUDIO_SIGNATURE = signaturePresets[0].color;

/**
 * Écrin's neutrals: lavender, lilac, a warm-free grey. Its accent is the
 * amethyst of the ring and the hand; another colour can replace it.
 */
export const ecrinPalettes: Record<Mode, Palette> = {
  light: {
    paper: "#F3F0F6",
    paperRaised: "#FCFAFD",
    sand: "#E8E3EE",
    sandDeep: "#DCD5E4",
    line: "#DAD3E1",
    lineStrong: "#B8AEC4",
    ink: "#26212D",
    inkSoft: "#544D5E",
    inkMuted: "#686172",
    accent: "#6B4F96",
    accentStrong: "#533A7A",
    accentSoft: "#E9E1F3",
    success: "#2F6A52",
    successSoft: "#DEEBE5",
    successStrong: "#214E3C",
    danger: "#A0384A",
    dangerSoft: "#F6E0E4",
    dangerStrong: "#7B2838",
    warning: "#85581A",
    warningSoft: "#F3E8D3",
    warningStrong: "#664312",
    shadowRgb: "38 30 50",
  },
  dark: {
    paper: "#141118",
    paperRaised: "#1E1A23",
    sand: "#28232E",
    sandDeep: "#332D3A",
    line: "#38323F",
    lineStrong: "#564E60",
    ink: "#F1ECF5",
    inkSoft: "#CAC2D2",
    inkMuted: "#A89FB1",
    accent: "#C7AEEA",
    accentStrong: "#DDCCF5",
    accentSoft: "#33284A",
    success: "#86C8AC",
    successSoft: "#18271F",
    successStrong: "#AFDFCA",
    danger: "#F09AAA",
    dangerSoft: "#3A1B22",
    dangerStrong: "#F7BEC9",
    warning: "#E2AE63",
    warningSoft: "#302516",
    warningStrong: "#F0CD97",
    shadowRgb: "0 0 0",
  },
};

/** Écrin's stones, in one tap (any colour is also possible). */
export const stonePresets = [
  { name: "Lilas", color: "#A78BD4" },
  { name: "Poudre", color: "#B46A6C" },
  { name: "Jade", color: "#3F7A6A" },
  { name: "Saphir", color: "#2F3A66" },
  { name: "Prune", color: "#7A3E66" },
  { name: "Champagne", color: "#A8894F" },
] as const;

/**
 * Carnet's papers. Unlike Studio and Écrin it keeps her ambiance, as a choice
 * of paper and ink: the same stored value, its own colours. `paper` is the
 * page, `sand` the edge of the pages under it, `accentSoft` the highlighter.
 */
export const carnetPapers: Record<
  AmbianceId,
  { name: string; mood: string; light: Palette; dark: Palette }
> = {
  atelier: {
    name: "Sienne",
    mood: "Papier crème, encre noire, terre de Sienne",
    light: {
      paper: "#FBF8F1",
      paperRaised: "#FFFDF8",
      sand: "#F1EBDF",
      sandDeep: "#E6DECF",
      line: "#DDD3C3",
      lineStrong: "#C9BCA7",
      ink: "#1D1814",
      inkSoft: "#5A5047",
      inkMuted: "#6A6157",
      accent: "#AD3E2B",
      accentStrong: "#8F3121",
      accentSoft: "#F4DCC9",
      success: "#3D6A4C",
      successSoft: "#E2ECE3",
      successStrong: "#2C4F38",
      danger: "#9C3D2E",
      dangerSoft: "#F7E3DC",
      dangerStrong: "#7A2F23",
      warning: "#8A5A1C",
      warningSoft: "#F6EAD4",
      warningStrong: "#6B4613",
      shadowRgb: "32 24 16",
    },
    dark: {
      paper: "#1A1816",
      paperRaised: "#22201D",
      sand: "#2A2723",
      sandDeep: "#34302B",
      line: "#34302B",
      lineStrong: "#4F483F",
      ink: "#EFE8DC",
      inkSoft: "#C4BBAE",
      inkMuted: "#ADA497",
      accent: "#EA8A6E",
      accentStrong: "#F0A087",
      accentSoft: "#4A2A20",
      success: "#86C09A",
      successSoft: "#1C2B21",
      successStrong: "#AEDABB",
      danger: "#EE9682",
      dangerSoft: "#3B1F19",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#33281A",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
  lin: {
    name: "Encre bleue",
    mood: "Papier froid, encre de stylo bleue",
    light: {
      paper: "#FBFBFA",
      paperRaised: "#FFFFFF",
      sand: "#EFF1F3",
      sandDeep: "#E3E6EA",
      line: "#D5DAE1",
      lineStrong: "#B9C1CC",
      ink: "#121A2E",
      inkSoft: "#4A5263",
      inkMuted: "#5B6374",
      accent: "#2C44A8",
      accentStrong: "#253A91",
      accentSoft: "#DDE3FA",
      success: "#2F6743",
      successSoft: "#DFEBE1",
      successStrong: "#224D31",
      danger: "#A3361F",
      dangerSoft: "#F7E0D9",
      dangerStrong: "#7C2817",
      warning: "#835615",
      warningSoft: "#F3E6CF",
      warningStrong: "#664210",
      shadowRgb: "18 26 46",
    },
    dark: {
      paper: "#161A22",
      paperRaised: "#1D222C",
      sand: "#232936",
      sandDeep: "#2C3240",
      line: "#2C3240",
      lineStrong: "#485163",
      ink: "#E9ECF3",
      inkSoft: "#B6BDCD",
      inkMuted: "#A2AABC",
      accent: "#93A6FF",
      accentStrong: "#A9B8FF",
      accentSoft: "#27315A",
      success: "#86C09A",
      successSoft: "#17251B",
      successStrong: "#AEDABB",
      danger: "#F09A84",
      dangerSoft: "#3A1C15",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#2F2416",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
  sauge: {
    name: "Olive",
    mood: "Papier vert pâle, encre d’olivier",
    light: {
      paper: "#F9F8F0",
      paperRaised: "#FEFDF7",
      sand: "#EFEEE2",
      sandDeep: "#E4E2D3",
      line: "#D9D8C4",
      lineStrong: "#C1C0A6",
      ink: "#1E1F16",
      inkSoft: "#52533F",
      inkMuted: "#62634C",
      accent: "#5A672C",
      accentStrong: "#4D5825",
      accentSoft: "#E5E9C9",
      success: "#3A6847",
      successSoft: "#DFEADF",
      successStrong: "#294D34",
      danger: "#9E3C2E",
      dangerSoft: "#F5E1DB",
      dangerStrong: "#7A2E23",
      warning: "#865818",
      warningSoft: "#F2E7D1",
      warningStrong: "#674412",
      shadowRgb: "30 31 22",
    },
    dark: {
      paper: "#181A14",
      paperRaised: "#20221B",
      sand: "#272A21",
      sandDeep: "#31332A",
      line: "#31332A",
      lineStrong: "#4B4E3F",
      ink: "#ECEDDE",
      inkSoft: "#BDBFA7",
      inkMuted: "#A7A991",
      accent: "#BCCB7A",
      accentStrong: "#C9D68C",
      accentSoft: "#39401F",
      success: "#8AC39C",
      successSoft: "#1C2B21",
      successStrong: "#B0DBBD",
      danger: "#EE9682",
      dangerSoft: "#3A1F19",
      dangerStrong: "#F7BBAD",
      warning: "#E2AE63",
      warningSoft: "#322819",
      warningStrong: "#F0CD97",
      shadowRgb: "0 0 0",
    },
  },
};

/** Carnet's inks, in one tap (any colour is also possible). */
export const inkPresets = [
  { name: "Sienne", color: "#AD3E2B" },
  { name: "Bleu stylo", color: "#2C44A8" },
  { name: "Olive", color: "#5A672C" },
  { name: "Prune", color: "#7A3E66" },
  { name: "Sépia", color: "#6B4A2B" },
  { name: "Noir", color: "#1D1814" },
] as const;
