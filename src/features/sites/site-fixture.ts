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
      palette: {
        bg: "#111111",
        ink: "#f5f5f5",
        paper: "#fafafa",
        inkOnPaper: "#1a1a1a",
        muted: "#bbbbbb",
        line: "#333333",
        accent: "#6b2fb3",
        onAccent: "#ffffff",
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
