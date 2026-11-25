import { contrast, isHexColor, mix, readableTone } from "@/lib/color/contrast";

export type StoryStyle = { color: string; gradient: boolean };
export const defaultStoryStyle: StoryStyle = {
  color: "#793e55",
  gradient: true,
};

export function readStoryStyle(key: string): StoryStyle {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isHexColor(saved?.color) && typeof saved.gradient === "boolean")
      return { color: saved.color.toLowerCase(), gradient: saved.gradient };
  } catch {
    // A blocked or unavailable store still permits sharing a story.
  }
  return defaultStoryStyle;
}

export function storyPalette({ color }: StoryStyle) {
  const black = "#000000",
    white = "#ffffff";
  if (color === defaultStoryStyle.color) {
    return {
      stops: ["#442a39", "#8a5667", "#684052", "#372531"],
      outside: "#fff7f2",
      paper: "#fffaf6",
      ink: "#34222c",
      muted: "#76636b",
      quiet: "#918189",
      accent: color,
      chip: "#f2e5e8",
      footer: "#f3dfdf",
      footerInk: "#492b39",
    };
  }
  const lightText = contrast(color, white) >= contrast(color, black);
  const outside = lightText ? white : black;
  const towards = lightText ? black : white;
  const paper = mix(color, white, 0.98);
  const chip = mix(color, white, 0.9);
  const footer = mix(color, white, 0.84);
  const accent = readableTone(color, [paper, chip, footer], black);
  return {
    stops: [
      mix(color, black, 0.35),
      mix(color, white, 0.25),
      color,
      mix(color, black, 0.55),
    ].map((stop) => readableTone(stop, [outside], towards)),
    outside,
    paper,
    ink: mix(accent, black, 0.55),
    muted: mix(accent, "#555555", 0.75),
    quiet: readableTone("#767676", [paper], black),
    accent,
    chip,
    footer,
    footerInk: accent,
  };
}
