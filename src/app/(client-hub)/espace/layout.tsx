import type { Metadata } from "next";

import { HubRoot } from "@/features/client-hub/components/hub-shell";

// The customer's hub. Its pages are shells: the session cookie is scoped to
// /api/client-hub, so nothing private is read or rendered on the server;
// every read is a same-origin request from the browser (no-store). The
// layout stays mounted across the hub's pages and holds the session.
export const metadata: Metadata = {
  title: { default: "Mon espace", template: "%s · Mon espace" },
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default function ClientHubLayout({ children }: LayoutProps<"/espace">) {
  return <HubRoot>{children}</HubRoot>;
}
