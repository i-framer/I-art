---
name: Next.js instrumentation Edge bundling
description: Why Node-only imports in instrumentation.ts break the Vercel build and the split-file pattern that fixes it
---

Next.js compiles `instrumentation.ts` for BOTH the Node and Edge runtimes. Any module reachable from it that pulls Node builtins (nodemailer → stream/fs/crypto) breaks `next build` with "Module not found: Can't resolve 'stream'" — even when the import is dynamic and behind an early `if (NEXT_RUNTIME !== "nodejs") return`, because webpack does not dead-code-eliminate past an early return.

**Why:** hit this in production (Vercel build failure) after adding an email-transport check to instrumentation.

**How to apply:** keep `instrumentation.ts` a thin shim: `if (process.env.NEXT_RUNTIME === "nodejs") { await (await import("./instrumentation-node")).register(); }` — Next replaces NEXT_RUNTIME with a literal so webpack DCEs the branch from the Edge bundle. Put all Node-only startup checks in `instrumentation-node.ts`. Also list Node-native packages (pg, nodemailer) in `serverExternalPackages` in next.config. `typecheck` (tsc) will NOT catch this — only `next build` (the `build-no-db` workflow) does; run it after touching instrumentation or its imports. Note: `build-no-db` can also fail spuriously on `.next/types/routes.d.ts is not a module` if the concurrent dev server left broken types — restart the dev workflow and re-run the build.
