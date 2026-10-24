import { describe, expect, it } from "vitest";

import { qrModules, qrSvg } from "./qr";

// Decoding needs a camera-grade reader: every version (1 to 10, ASCII and
// UTF-8) was checked once with the system's QR decoder (CoreImage), and
// this matrix, read back as "https://x.fr", is kept as the reference.
const reference = [
  "111111100100001111111",
  "100000100011101000001",
  "101110101100101011101",
  "101110101000101011101",
  "101110101101101011101",
  "100000101010101000001",
  "111111101010101111111",
  "000000001001100000000",
  "101111100100101111100",
  "101001010110111111111",
  "001000111101011100110",
  "111111001100010011100",
  "110011101101011011001",
  "000000001000101111101",
  "111111100100100100110",
  "100000101010000111100",
  "101110101000101111011",
  "101110101101011010100",
  "101110101111101100100",
  "100000100000010011100",
  "111111101001101101010",
];

const rows = (modules: boolean[][]) =>
  modules.map((row) => row.map((on) => (on ? "1" : "0")).join(""));

describe("QR encoder", () => {
  it("encodes a short link exactly as the decoded reference", () => {
    expect(rows(qrModules("https://x.fr")!)).toEqual(reference);
  });

  it.each([
    [1, 1],
    [20, 2],
    [35, 3],
    [61, 4],
    [104, 6],
    [200, 10],
  ])("%i bytes: the smallest version that fits (%i)", (length, version) => {
    expect(qrModules("a".repeat(length))!.length).toBe(version * 4 + 17);
  });

  it("draws the three finder patterns and the timing lines", () => {
    const modules = qrModules("https://exemple.fr/labo/mila")!;
    const size = modules.length;
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(modules[y]!.slice(x, x + 7)).toEqual(new Array(7).fill(true));
      expect(modules[y + 2]![x + 2]).toBe(true);
      expect(modules[y + 1]![x + 1]).toBe(false);
    }
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true); // the dark module
  });

  it("says no rather than drawing a code that cannot hold the text", () => {
    expect(qrModules("x".repeat(214))).toBeNull();
    expect(qrSvg("x".repeat(214))).toBeNull();
  });

  it("an SVG with its quiet zone and her colours", () => {
    const svg = qrSvg("https://x.fr", { dark: "#123456", light: "#FAFAFA" })!;
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#FAFAFA"');
  });
});
