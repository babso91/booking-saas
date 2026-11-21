import { ImageResponse } from "next/og";
import sharp from "sharp";
import { z } from "zod";

import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import type { SiteConfig } from "@/features/experience/engine/config";
import { publicView } from "@/features/experience/published";
import { coverCrop } from "@/features/experience/share";
import { getPublishedSite } from "@/features/sites/data/sites";
import { readPublicSitePhoto } from "@/features/sites/data/photos";
import { PUBLIC_PHOTO_CACHE } from "@/features/sites/photos/http";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The picture of her page when its link is shared (WhatsApp, Instagram,
// Messenger: Higani point 27). Her published cover, cut around its focal
// point; without one, her name in her universe's colours. JPEG: every
// messenger reads it (her photos are stored as WebP, which some do not).
// Only what her page already shows publicly: the cover goes through the
// same check as her public photos (published, hers, not revoked).

export const alt = "Aperçu de sa page";
export const size = { width: 1200, height: 630 };
export const contentType = "image/jpeg";

const jpeg = (input: Buffer) =>
  sharp(input).flatten().jpeg({ quality: 80, mozjpeg: true }).toBuffer();

/** Her published cover, cut to the preview around its focal point. */
async function coverOf(slug: string, config: SiteConfig) {
  const cover = config.content.cover;
  if (!cover || !z.uuid().safeParse(cover).success) return null;
  const body = await readPublicSitePhoto(
    createAdminSupabaseClient() as AppSupabaseClient,
    slug,
    cover,
    1200,
  );
  if (!body) return null;
  const input = Buffer.from(body);
  const { width, height } = await sharp(input).metadata();
  if (!width || !height) return null;
  const crop = coverCrop({ width, height }, size, config.content.focals[cover]);
  return jpeg(
    await sharp(input)
      .resize(crop.width, crop.height)
      .extract({ ...size, left: crop.left, top: crop.top })
      .toBuffer(),
  );
}

/** Her name, what she does and where, in her colours (or Higani's). */
async function cardOf(name: string, config: SiteConfig | null) {
  const bg = config?.tokens.palette.bg ?? "#f6f1ea";
  const ink = config?.tokens.palette.ink ?? "#1f1a17";
  const kind = config?.brand.kind.trim();
  const where = config?.brand.location.trim();
  const card = new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        background: bg,
        color: ink,
      }}
    >
      <div style={{ display: "flex", fontSize: 26, letterSpacing: 6 }}>
        {kind ? kind.toUpperCase() : "RÉSERVATION EN LIGNE"}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: name.length > 22 ? 84 : 112,
          lineHeight: 1.05,
        }}
      >
        {name}
      </div>
      <div style={{ display: "flex", fontSize: 30, opacity: 0.75 }}>
        {where || " "}
      </div>
    </div>,
    size,
  );
  return jpeg(Buffer.from(await card.arrayBuffer()));
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const slug = businessSlugSchema.safeParse((await params).slug);
  if (!slug.success) return new Response(null, { status: 404 });
  const client = createPublicSupabaseClient();
  const business = await getPublicBusiness(client, slug.data);
  if (!business) return new Response(null, { status: 404 });

  let config: SiteConfig | null = null;
  let picture: Buffer | null = null;
  try {
    const site = await getPublishedSite(client, slug.data).catch(
      (error: unknown) => {
        if (
          error instanceof AppException &&
          error.code === "site_not_published"
        )
          return null;
        throw error;
      },
    );
    config = site ? publicView(site) : null;
    picture = config ? await coverOf(slug.data, config) : null;
  } catch (error) {
    // Her cover could not be read: her name stands in for it.
    console.error("Share preview cover failed", error);
  }
  const name = config?.brand.name.trim() || business.name;
  const body = picture ?? (await cardOf(name, config));
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": PUBLIC_PHOTO_CACHE,
    },
  });
}
