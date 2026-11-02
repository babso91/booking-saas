import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AccountAppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { loadArea } from "@/features/appearance/server/area-appearance";

// Server-side gate of the professional area: unauthenticated → /login,
// signed in without business → /onboarding. Data access is still authorised
// by the DAL and RLS on every request; this only routes the visitor.
//
// Her appearance is read from her account, for this business, so the area is
// rendered in it at once, on every device.
export default async function PrivateAppLayout({
  children,
}: LayoutProps<"/app">) {
  await requireReadyBusiness();
  const area = await loadArea();

  return (
    <AccountAppearanceProvider area={area}>
      {children}
    </AccountAppearanceProvider>
  );
}
