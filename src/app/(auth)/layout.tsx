import { BrandMark } from "@/components/shared/brand-mark";
import { MockScenarioPanel } from "@/features/auth/components/mock-scenario-panel";
import { AuthShowcase } from "@/features/auth/components/auth-showcase";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-4 lg:p-4">
      <div className="flex flex-1 flex-col px-5 pt-[max(env(safe-area-inset-top),1.25rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] sm:px-10 lg:px-12 lg:py-8 xl:px-20">
        <header className="flex items-center justify-between">
          <BrandMark />
        </header>
        <main className="flex flex-1 flex-col justify-center py-10 lg:py-12">
          <div className="mx-auto w-full max-w-[400px]">{children}</div>
        </main>
      </div>
      <AuthShowcase />
      <MockScenarioPanel />
    </div>
  );
}
