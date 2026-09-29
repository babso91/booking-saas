import { requirePendingOnboarding } from "@/features/auth/data/guards";

// Only signed-in users without a business may see onboarding:
// unauthenticated → /login, already onboarded → /app.
export default async function OnboardingLayout({
  children,
}: LayoutProps<"/onboarding">) {
  await requirePendingOnboarding();

  return children;
}
