// The experience engine's model. A professional's site is a SiteConfig:
// her content, the tokens of her universe (palette, type, photo grade,
// motion, shape) and an ordered list of scenes, each naming a variant.
//
// Variants are hand-designed compositions (scenes/*), not generic blocks:
// the engine composes them and feeds them tokens and content, so a new
// universe is configuration while each scene keeps its own art.

export type Work = { id: string; photo: string; title: string; note: string };

export type Service = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  blurb: string;
};

export type Palette = {
  /** Night surface (opening, work) and its ink. */
  bg: string;
  ink: string;
  /** Day surface (services, booking) and its ink. */
  paper: string;
  inkOnPaper: string;
  muted: string;
  line: string;
  accent: string;
  /** Text on the accent. */
  onAccent: string;
};

export type TypePairId = "didone" | "soft-serif" | "condensed" | "neutral";
export type GradeId = "silver" | "warm" | "natural" | "chrome";
export type MotionId = "cut" | "settle" | "snap";
export type ShapeId = "sharp" | "soft" | "round";

export type SceneKind = "opening" | "intro" | "work" | "services";

export type OpeningVariant = "didone-cut" | "bloom" | "kinetic";
export type IntroVariant = "statement" | "lines";
export type WorkVariant = "lookbook" | "arches" | "filmstrip";
export type ServicesVariant = "index" | "shelf" | "tiles";

export type Section =
  | { kind: "opening"; variant: OpeningVariant }
  | { kind: "intro"; variant: IntroVariant }
  | { kind: "work"; variant: WorkVariant }
  | { kind: "services"; variant: ServicesVariant };

export type SiteConfig = {
  /** The universe this site was started from (its designed defaults). */
  universe: string;
  brand: { name: string; kind: string; location: string; intro: string };
  content: { cover: string; works: Work[]; services: Service[] };
  tokens: {
    palette: Palette;
    type: TypePairId;
    grade: GradeId;
    motion: MotionId;
    shape: ShapeId;
  };
  sections: Section[];
  /** How booking enters: a full page or a sheet from the bottom. */
  booking: "page" | "sheet";
  /** The always-present quick booking (mobile first): a bar or a pill. */
  quickBook: "bar" | "pill";
};
