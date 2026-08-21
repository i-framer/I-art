---
name: Artifact WebSocket routing
description: Development HMR requirements for artifacts behind Replit's preview proxy.
---

Next.js development HMR needs both an explicit `/_next/webpack-hmr` artifact service path and the preview loopback host in `allowedDevOrigins`.

**Why:** The page can render successfully while the browser reports a 502 from the HMR WebSocket; adding only one side of the configuration either leaves the proxy rejecting the connection or has Next reject its origin.

**How to apply:** After changing a web artifact's route configuration, restart its managed workflow and verify the browser console in the proxied preview, not only with an HTTP request.