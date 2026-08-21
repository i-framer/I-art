import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Transpile TypeScript workspace packages
  transpilePackages: ["@workspace/db"],
  // Keep native Node.js modules out of the bundle
  serverExternalPackages: ["pg", "nodemailer"],
  // Monorepo: trace files from the workspace root so standalone/Vercel
  // builds include hoisted pnpm dependencies
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Allow build:no-db to use a separate output directory so it never races
  // with the concurrent `next dev` process in the Replit workspace.
  distDir: process.env.BUILD_DIR ?? ".next",
  // Silence the cross-origin warning from the Replit preview proxy.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "*.riker.replit.dev",
    "*.replit.dev",
  ],
};

export default nextConfig;
