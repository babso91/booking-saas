import type { SiteConfig } from "@/features/sites/config";

/** A complete, readable configuration (tests and examples). */
export function sampleSiteConfig(
  overrides: Partial<SiteConfig> = {},
): SiteConfig {
  return {
    universe: "mila",
    brand: {
      name: "Studio Mila",
      kind: "Extensions de cils",
      location: "Lyon",
      intro: "Un regard, travaillé cil à cil.",
    },
    content: {
      cover: null,
      works: [],
      portrait: { photo: null, name: "Mila", role: "Fondatrice", text: "" },
      focals: {},
    },
    tokens: {
      // Mila's "Encre", a designed palette: readable under both plans.
      palette: {
        bg: "#0b0b0b",
        ink: "#f2f0ec",
        paper: "#f2f0ec",
        inkOnPaper: "#0b0b0b",
        muted: "#8b8883",
        line: "#2a2927",
        accent: "#ff3b1f",
        onAccent: "#0b0b0b",
      },
      type: "didone",
      grade: "silver",
      motion: "cut",
      shape: "sharp",
    },
    sections: [
      { kind: "opening", variant: "didone-cut" },
      { kind: "work", variant: "lookbook" },
      { kind: "services", variant: "index" },
    ],
    booking: "sheet",
    quickBook: "pill",
    ...overrides,
  };
}
