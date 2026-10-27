import { cookies } from "next/headers";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import {
  APPEARANCE_COOKIE,
  parseAppearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";

// Server-side gate of the professional area: unauthenticated → /login,
// signed in without business → /onboarding. Data access is still authorised
// by the DAL and RLS on every request; this only routes the visitor.
//
// Her appearance (ambiance, mode, accent, motion) is read from this device's
// cookie, strictly (parseAppearance), so the area is rendered in it at once.
export default async function PrivateAppLayout({
  children,
}: LayoutProps<"/app">) {
  await requireReadyBusiness();
  const appearance = parseAppearance(
    (await cookies()).get(APPEARANCE_COOKIE)?.value,
  );

  return (
    <AppearanceProvider initial={appearance}>{children}</AppearanceProvider>
  );
}
