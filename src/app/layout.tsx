import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Booking SaaS",
    template: "%s · Booking SaaS",
  },
  description:
    "Réservation, gestion clientes et fidélisation pour les indépendantes beauté.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
