import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Lab only (branch proto/experience-engine): open the dev server to a
  // phone on the same Wi-Fi, for testing /labo with real professionals.
  allowedDevOrigins: ["192.168.1.16"],
};

export default nextConfig;
