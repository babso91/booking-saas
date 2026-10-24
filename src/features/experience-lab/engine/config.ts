// The experience engine's model. A professional's site is a SiteConfig:
// her content, the tokens of her universe (palette, type, photo grade,
// motion, shape) and an ordered list of scenes, each naming a variant.
//
// Variants are hand-designed compositions (scenes/*), not generic blocks:
// the engine composes them and feeds them tokens and content, so a new
// universe is configuration while each scene keeps its own art.

export type Work = { id: string; photo: string; title: string; note: string };

/**
 * Where the subject of a photo is (percent from the left and the top).
 * It belongs to the photo, not to a scene: every composition (portrait,
 * arch, band, tilted card) crops around it.
 */
export type Focal = { x: number; y: number };

/** A photo spot of the site: the cover, or a work by its position. */
export type PhotoSlot = "cover" | number;

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

/**
 * A site's design and its showcase content. Her services are NOT here:
 * they are business data (catalog/model.ts), given to the engine to show.
 */
export type SiteConfig = {
  /** The universe this site was started from (its designed defaults). */
  universe: string;
  brand: { name: string; kind: string; location: string; intro: string };
  content: {
    cover: string;
    works: Work[];
    /** Focal point of each photo, by photo id (centre when absent). */
    focals: Record<string, Focal>;
  };
  tokens: {
    palette: Palette;
    type: TypePairId;
    grade: GradeId;
    motion: MotionId;
    shape: ShapeId;
    /**
     * The booking buttons' colour (the "Réserver" pill or bar and the
     * booking's main button); the universe's own when absent. Their text
     * colour is always computed to stay readable.
     */
    cta?: string;
  };
  sections: Section[];
  /** How booking enters: a full page or a sheet from the bottom. */
  booking: "page" | "sheet";
  /** The always-present quick booking (mobile first): a bar or a pill. */
  quickBook: "bar" | "pill";
};
