import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image (Dockerfile) runs the standalone server; elsewhere
  // (dev, CI, next start) the default output is unchanged.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
};

export default nextConfig;
