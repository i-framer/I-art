import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile TypeScript workspace packages
  transpilePackages: ["@workspace/db"],
  // Keep native Node.js modules out of the bundle
  serverExternalPackages: ["pg"],
};

export default nextConfig;
