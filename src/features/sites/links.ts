// Her links elsewhere (Higani point 3): the networks a link can be, in the
// order her studio offers them. No network is imposed; none is required.

export const siteLinkNetworks = [
  "instagram",
  "tiktok",
  "facebook",
  "linkedin",
  "youtube",
  "pinterest",
  "website",
  "other",
] as const;

export type SiteLinkNetwork = (typeof siteLinkNetworks)[number];

export type SiteLink = {
  network: SiteLinkNetwork;
  /** What she typed: an address, or her @name on that network. */
  url: string;
  /** Its name, for « other ». */
  label?: string;
};
