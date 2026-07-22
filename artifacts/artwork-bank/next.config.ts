import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Transpile TypeScript workspace packages
  transpilePackages: ["@workspace/db"],
  // Keep native Node.js modules out of the bundle
  serverExternalPackages: ["pg"],
  // Monorepo: trace files from the workspace root so standalone/Vercel
  // builds include hoisted pnpm dependencies
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
