import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { siteFontClasses } from "@/features/experience/fonts";
import { SiteFrame } from "@/features/experience/studio/site-frame";

export const metadata: Metadata = {
  title: "Comme mes clientes",
  robots: { index: false, follow: false },
};

// The frame of « Comme mes clientes » in her studio (Higani points 122,
// 123): it shows only what her studio, on this same site, sends it. Read
// nothing here: her studio already holds her draft and her data.
export default async function ClientViewFramePage() {
  const { business } = await requireReadyBusiness();
  return <SiteFrame slug={business.slug} fontClasses={siteFontClasses} />;
}
