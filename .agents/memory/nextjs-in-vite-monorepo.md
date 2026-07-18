---
name: Next.js in Vite Monorepo
description: How to add a Next.js 15 artifact to a pnpm monorepo that is primarily Vite-based, including critical config to transpile workspace TypeScript packages.
---

# Next.js in Vite Monorepo

## The Rule
When adding a Next.js app to a pnpm workspace that has other TypeScript workspace packages (`@workspace/db`, `@workspace/api-spec`, etc.), you MUST add those packages to `transpilePackages` in `next.config.ts` — otherwise Next.js will try to require their `.ts` files directly and crash.

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/db"],
  serverExternalPackages: ["pg"],  // native Node modules must NOT be bundled
};
```

**Why:** Workspace packages in this monorepo export `.ts` files (not compiled JS). Vite handles TypeScript natively; Next.js does not unless told to transpile the package. The `pg` PostgreSQL driver uses native Node.js modules that cannot be webpack-bundled.

**How to apply:** Any time you add an `import` from a `@workspace/*` package in a new Next.js artifact, add that package name to `transpilePackages`. Add its native node deps (pg, etc.) to `serverExternalPackages`.

## tsconfig
Next.js 15 auto-modifies tsconfig on first run. Start with individual strict options (`strictNullChecks`, `noImplicitAny`, etc.) rather than `strict: true`, because Next.js sets `strict: false`. Also requires `esModuleInterop: true` and `isolatedModules: true` — either set them yourself or let Next.js add them.

## Package placement
In a Next.js artifact (server-rendered), treat all runtime packages as `dependencies` (not `devDependencies`). Tailwind CSS and PostCSS go in `devDependencies`.

## PostCSS config
Tailwind v4 in Next.js requires the `@tailwindcss/postcss` plugin:
```js
// postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } };
```
