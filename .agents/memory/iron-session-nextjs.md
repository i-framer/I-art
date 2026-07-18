---
name: Iron-Session Next.js Auth Pattern
description: Correct pattern for iron-session v8 in Next.js 15 App Router — reading in server components vs. writing in server actions.
---

# Iron-Session v8 + Next.js 15 App Router

## Session Read (server components, layouts)
In server components, `cookies()` is readonly. `getIronSession` works for READING only.
```typescript
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";

const cookieStore = await cookies(); // Next.js 15: cookies() is async
const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
// session.userId, session.tenantId etc. are readable
// do NOT call session.save() or session.destroy() here
```

## Session Write (server actions only)
In server actions (`'use server'` files), `cookies()` is mutable — save/destroy work:
```typescript
"use server";
import { cookies } from "next/headers";

const cookieStore = await cookies();
const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
session.userId = user.id;
await session.save();
redirect("/dashboard");
```

**Why:** Next.js only allows cookie mutations inside server actions. Calling `session.save()` in a layout or server component silently fails or throws.

## SessionOptions
```typescript
export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "fallback-32char-dev-secret!!!!!",
  cookieName: "artwork_bank_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
  },
};
```
`SESSION_SECRET` must be ≥32 characters (iron-session requirement).

## useActionState pattern (Next.js 15 + React 19)
`useFormState` is deprecated. Use `useActionState` from `'react'` (React 19).
Server actions should return `{ error: string }` on failure and call `redirect()` on success.
