import { redirectAuthenticatedUser } from "@/features/auth/data/guards";

// Signed-in users never see the sign-up page: they go to /onboarding or /app.
export default async function SignupLayout({
  children,
}: LayoutProps<"/signup">) {
  await redirectAuthenticatedUser();

  return children;
}
