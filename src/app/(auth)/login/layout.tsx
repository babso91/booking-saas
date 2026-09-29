import { redirectAuthenticatedUser } from "@/features/auth/data/guards";

// Signed-in users never see the login page: they go to /onboarding or /app.
export default async function LoginLayout({ children }: LayoutProps<"/login">) {
  await redirectAuthenticatedUser();

  return children;
}
