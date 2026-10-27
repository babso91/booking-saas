import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Design preview of the professional area: its real components with
// fictional data, to review and test them without an account or a database
// (no data is read or written here). Never part of a production build,
// except an instance explicitly enabled with DASHBOARD_PREVIEW=1.

export const metadata: Metadata = {
  title: "Aperçu",
  robots: { index: false, follow: false },
};

// Rendered per request: the gate reads the environment at runtime.
export const dynamic = "force-dynamic";

export default function PreviewLayout({ children }: LayoutProps<"/apercu">) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.DASHBOARD_PREVIEW !== "1"
  )
    notFound();
  return children;
}
