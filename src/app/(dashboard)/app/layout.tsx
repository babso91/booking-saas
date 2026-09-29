import { requireReadyBusiness } from "@/features/auth/data/guards";

// Server-side gate of the professional area: unauthenticated → /login,
// signed in without business → /onboarding. Data access is still authorised
// by the DAL and RLS on every request; this only routes the visitor.
export default async function PrivateAppLayout({
  children,
}: LayoutProps<"/app">) {
  await requireReadyBusiness();

  return children;
}
