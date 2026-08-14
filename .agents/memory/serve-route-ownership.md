---
name: Serve route ownership pattern
description: Tenant ownership check pattern for /api/storage/serve; artworkImagesTable row lifecycle
---

## Rule
After auth + path-prefix checks, query artworkImagesTable WHERE objectPath = <path> AND tenantId = session.tenantId. Missing/mismatched → 403. fetchObject is never called if ownership fails.

**Why:** Without this, any authenticated gallery-admin can read other tenants' images.

## Test mock pattern
Mock @workspace/db (findFirst returning {id:'img-1'} for grant, null for deny) and drizzle-orm (and/eq as no-ops). Session mock must include tenantId.

## artworkImagesTable row lifecycle
addArtworkImage server action creates the row before any serve route call renders the <img> tag. Row always exists for legitimate images by the time serve is called.
