import type { SiteConfig as SavedConfig } from "@/features/sites/config";

import type { SiteConfig } from "../engine/config";
import { isDemo } from "./photos";
import type { Universe } from "./universes";

// Her studio edits the engine's configuration (a photo is an asset id, or
// null). Between it and her saved draft (docs/SITE_PUBLISHING_CONTRACT.md
// § 4, a photo is { asset }), nothing else changes. A demo photo can never
// reach her draft: the studio does not put one in it, and this is where it
// would be stopped anyway.

const own = (id: string | null) => (id && !isDemo(id) ? id : null);

/** Her draft as the server keeps it. */
export function savedConfigOf(config: SiteConfig): SavedConfig {
  const cover = own(config.content.cover);
  const portrait = own(config.content.portrait.photo);
  // A work is a photo of hers: without one, it is not saved.
  const works = config.content.works.filter((work) => own(work.photo));
  const kept = new Set(
    [cover, portrait, ...works.map((work) => work.photo)].filter(Boolean),
  );
  return {
    ...config,
    content: {
      ...config.content,
      cover: cover ? { asset: cover } : null,
      portrait: {
        ...config.content.portrait,
        photo: portrait ? { asset: portrait } : null,
      },
      works: works.map((work) => ({ ...work, photo: { asset: work.photo } })),
      // Only the focal points of her photos still in the site.
      focals: Object.fromEntries(
        Object.entries(config.content.focals).filter(([id]) => kept.has(id)),
      ),
    },
  } as SavedConfig;
}

/**
 * What her studio's preview shows of her draft when she wants to see her
 * universe dressed: each place she has no photo for yet takes the
 * universe's demo photo (and an empty gallery, its demo works). Only ever
 * rendered, never saved.
 */
export function withDemoPhotos(
  config: SiteConfig,
  universe: Universe,
): SiteConfig {
  const sample = universe.config.content;
  return {
    ...config,
    content: {
      ...config.content,
      cover: config.content.cover ?? sample.cover,
      portrait: {
        ...config.content.portrait,
        photo: config.content.portrait.photo ?? sample.portrait.photo,
      },
      works: config.content.works.length ? config.content.works : sample.works,
    },
  };
}

/**
 * A first draft for her: the universe's design and texts in her business's
 * name, without any photo (she adds hers; the preview can show the
 * universe's own meanwhile).
 */
export function firstDraft(universe: Universe, name: string): SiteConfig {
  const start = universe.config;
  return {
    ...start,
    brand: { ...start.brand, name },
    content: {
      cover: null,
      works: [],
      portrait: { ...start.content.portrait, photo: null },
      focals: {},
    },
  };
}
