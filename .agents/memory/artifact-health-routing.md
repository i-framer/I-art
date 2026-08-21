---
name: Artifact health routing
description: Preview proxy behavior when a path belongs to a stopped artifact service.
---

An artifact service can own a path even when its managed workflow is stopped; the proxy returns a 502 for that path while sibling artifact pages may still render normally.

**Why:** A page-level smoke check can look healthy while an independently routed health endpoint fails at the preview proxy boundary.

**How to apply:** When a browser report names a 502 on an artifact-owned path, verify the owning managed workflow is running and probe the route through the public proxy, not only its local service port.