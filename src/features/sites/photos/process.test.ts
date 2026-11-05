import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { processSitePhoto, realType } from "@/features/sites/photos/process";
import { AppException } from "@/lib/errors";

// The server's verification and conversion of an uploaded photo
// (docs/SITE_PUBLISHING_CONTRACT.md § 8), on real files made here.

/** A photo with texture (so encoders do real work), `width` × `height`. */
function picture(width: number, height: number) {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      pixels[offset] = (x * 7) & 255;
      pixels[offset + 1] = (y * 3) & 255;
      pixels[offset + 2] = ((x + y) * 5) & 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels } });
}

/** A phone's JPEG: turned (EXIF orientation 6), with GPS and a camera. */
async function phoneJpeg() {
  return picture(1600, 1200)
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Phone", Model: "Camera 15" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "48/1 51/1 2400/100",
        GPSLongitudeRef: "E",
        GPSLongitude: "2/1 21/1 300/100",
      },
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function codeOf(run: () => Promise<unknown>) {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
}

describe("site photo conversion", () => {
  it("a phone's JPEG: upright, WebP at 480/828/1200, no metadata left", async () => {
    const input = await phoneJpeg();
    const original = await sharp(input).metadata();
    expect(original.orientation).toBe(6);
    expect(original.exif).toBeDefined();
    expect(input.toString("latin1")).toContain("Camera 15");

    const photo = await processSitePhoto(input);

    expect(photo.contentType).toBe("image/jpeg");
    // Turned a quarter: 1200 wide, 1600 high.
    expect([photo.width, photo.height]).toEqual([1200, 1600]);
    expect(photo.derivatives.map((d) => d.width)).toEqual([480, 828, 1200]);
    for (const derivative of photo.derivatives) {
      const meta = await sharp(derivative.data).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(derivative.width);
      // Upright: portrait, no orientation flag left to apply.
      expect(meta.height).toBe(Math.round((derivative.width * 1600) / 1200));
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.comments).toBeUndefined();
      // Nothing of the camera or the place, anywhere in the bytes.
      const bytes = derivative.data.toString("latin1");
      expect(bytes).not.toContain("Camera 15");
      expect(bytes).not.toContain("Exif");
    }
  });

  it("the upright pixels: the top of the photo stays on top", async () => {
    // Red band on the LEFT of the stored pixels; orientation 6 (turn 90°
    // clockwise) puts it on TOP.
    const width = 800;
    const height = 600;
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 100; x++) {
        const offset = (y * width + x) * 3;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();

    const photo = await processSitePhoto(input);
    const derivative = photo.derivatives.find((d) => d.width === 480)!;
    const { data, info } = await sharp(derivative.data)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const [r, g, b] = at(info.width / 2, 5);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    const [, gBottom] = at(info.width / 2, info.height - 5);
    expect(gBottom).toBeGreaterThan(200);
  });

  it("PNG, WebP and AVIF are accepted, with their REAL type", async () => {
    const source = picture(900, 700);
    const cases = [
      [await source.clone().png().toBuffer(), "image/png"],
      [await source.clone().webp().toBuffer(), "image/webp"],
      [await source.clone().avif({ effort: 0 }).toBuffer(), "image/avif"],
    ] as const;
    for (const [input, type] of cases) {
      const photo = await processSitePhoto(input);
      expect(photo.contentType).toBe(type);
      expect([photo.width, photo.height]).toEqual([900, 700]);
      // Never enlarged: 900 wide at most.
      expect(photo.derivatives.map((d) => d.width)).toEqual([480, 828, 1200]);
      const largest = await sharp(photo.derivatives[2]!.data).metadata();
      expect(largest.width).toBe(900);
    }
  });

  it("an animated image becomes its first frame", async () => {
    const frames = await Promise.all(
      [0, 1].map((shift) =>
        picture(400 + shift, 400)
          .resize(400, 400)
          .png()
          .toBuffer(),
      ),
    );
    const input = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(input).metadata()).pages).toBe(2);
    const photo = await processSitePhoto(input);
    expect([photo.width, photo.height]).toEqual([400, 400]);
    const meta = await sharp(photo.derivatives[0]!.data).metadata();
    expect(meta.pages ?? 1).toBe(1);
  });

  it("anything that is not one of these photos is refused", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800"/></svg>',
    );
    const gif = await picture(400, 400).gif().toBuffer();
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    const truncated = (await phoneJpeg()).subarray(0, 2000);
    for (const input of [svg, gif, html, truncated, Buffer.alloc(0)]) {
      expect(await codeOf(() => processSitePhoto(input))).toBe(
        "site_photo_unsupported",
      );
    }
  });

  it("HEIC (HEVC) is refused with its own message; AVIF passes", () => {
    let heic: unknown;
    try {
      realType({ format: "heif", compression: "hevc" });
    } catch (error) {
      heic = error;
    }
    expect(heic).toBeInstanceOf(AppException);
    expect((heic as AppException).code).toBe("site_photo_unsupported");
    expect((heic as AppException).message).toMatch(/HEIC/);
    expect(realType({ format: "heif", compression: "av1" })).toBe("image/avif");
  });

  it("too small, too elongated, too heavy, too many pixels: refused", async () => {
    const small = await picture(300, 900).jpeg().toBuffer();
    const sliver = await picture(2000, 400).jpeg().toBuffer();
    expect(await codeOf(() => processSitePhoto(small))).toBe(
      "site_photo_invalid",
    );
    expect(await codeOf(() => processSitePhoto(sliver))).toBe(
      "site_photo_invalid",
    );
    expect(
      await codeOf(() => processSitePhoto(Buffer.alloc(10 * 1024 * 1024 + 1))),
    ).toBe("site_photo_too_large");
    // 8000 × 8000: 64 MP, refused from its header, before decoding.
    const bomb = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: "#fff" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(await codeOf(() => processSitePhoto(bomb))).toBe(
      "site_photo_too_large",
    );
  });
});
