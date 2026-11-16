import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Discovery } from "@/features/discovery/discovery";

export const metadata: Metadata = {
  title: "Découvrir les univers",
  robots: { index: false, follow: false },
};

/**
 * Discovering the universes before signing up: an experiment (16/11), not
 * the sign-up. It exists only where it is switched on (DISCOVERY_PREVIEW=1,
 * or the previews' DASHBOARD_PREVIEW=1); elsewhere it is a 404. The sign-up,
 * its beta invitation and its checks are unchanged: an invitation in the
 * address is only carried on to /signup.
 */
export default async function DiscoverPage({
  searchParams,
}: PageProps<"/decouvrir">) {
  if (
    process.env.DISCOVERY_PREVIEW !== "1" &&
    process.env.DASHBOARD_PREVIEW !== "1"
  )
    notFound();
  const { invitation } = await searchParams;
  return (
    <Discovery
      invitation={
        typeof invitation === "string" &&
        /^[A-Za-z0-9_-]{8,200}$/.test(invitation)
          ? invitation
          : null
      }
    />
  );
}
