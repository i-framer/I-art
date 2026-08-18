/**
 * Object storage service for Artwork Bank.
 *
 * Supports two backends, selected by environment:
 *
 * - "replit"      — Replit App Storage via the local sidecar HTTP API
 *                   (requires PRIVATE_OBJECT_DIR; only works inside Replit).
 * - "vercel-blob" — Vercel Blob (requires BLOB_READ_WRITE_TOKEN; used on
 *                   Vercel or anywhere else with a Blob store token).
 *
 * Selection order: explicit STORAGE_PROVIDER env var, else vercel-blob when
 * BLOB_READ_WRITE_TOKEN is set, else replit when PRIVATE_OBJECT_DIR is set.
 * A clear error is thrown when neither is configured.
 *
 * The DB always stores provider-agnostic object paths of the form
 * "/objects/uploads/<uuid>" so records stay portable between backends.
 */

import { del as blobDel, list as blobList, put as blobPut } from "@vercel/blob";
import { getPlatformBaseUrl } from "@/lib/base-url";

export type StorageProvider = "replit" | "vercel-blob";

export class StorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

export function getStorageProvider(): StorageProvider {
  const explicit = process.env.STORAGE_PROVIDER;
  if (explicit === "replit" || explicit === "vercel-blob") return explicit;
  if (explicit) {
    throw new StorageNotConfiguredError(
      `Unknown STORAGE_PROVIDER "${explicit}" (expected "replit" or "vercel-blob")`,
    );
  }
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  if (process.env.PRIVATE_OBJECT_DIR) return "replit";
  throw new StorageNotConfiguredError(
    "No storage backend configured. Set BLOB_READ_WRITE_TOKEN (Vercel Blob) or PRIVATE_OBJECT_DIR (Replit App Storage).",
  );
}

/** Extracts "uploads/<uuid>" from a stored "/objects/uploads/<uuid>" path. */
function toEntityId(objectPath: string): string {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error(`Invalid objectPath: ${objectPath}`);
  }
  return objectPath.slice("/objects/".length);
}

// ─── Replit sidecar backend ──────────────────────────────────────────────────

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function parseGcsPath(path: string): { bucketName: string; objectName: string } {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GCS path: ${path}`);
  return { bucketName: parts[0]!, objectName: parts.slice(1).join("/") };
}

async function signObjectURL(
  bucketName: string,
  objectName: string,
  method: "GET" | "PUT" | "DELETE",
  ttlSec: number,
): Promise<string> {
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to sign URL (${response.status}): ${text}`);
  }
  const { signed_url } = (await response.json()) as { signed_url: string };
  return signed_url;
}

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new StorageNotConfiguredError("PRIVATE_OBJECT_DIR env var not set");
  }
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function replitGcsLocation(entityId: string) {
  return parseGcsPath(`${getPrivateObjectDir()}/${entityId}`);
}

// ─── Vercel Blob backend ─────────────────────────────────────────────────────

/**
 * Blob URLs look like https://<store-id>.public.blob.vercel-storage.com/<pathname>.
 * The store host isn't exposed as an env var, so we resolve each pathname's
 * public URL via the Blob list API and cache it (URLs are stable).
 * Optionally set BLOB_BASE_URL to skip the lookup entirely.
 */
const blobUrlCache = new Map<string, string>();
let blobBaseUrl: string | null = process.env.BLOB_BASE_URL?.replace(/\/$/, "") ?? null;

async function blobUrlFor(entityId: string): Promise<string> {
  if (blobBaseUrl) return `${blobBaseUrl}/${entityId}`;
  const cached = blobUrlCache.get(entityId);
  if (cached) return cached;
  const { blobs } = await blobList({ prefix: entityId, limit: 1 });
  const blob = blobs.find((b) => b.pathname === entityId) ?? blobs[0];
  if (!blob) throw new Error(`Blob not found: ${entityId}`);
  blobUrlCache.set(entityId, blob.url);
  // Derive and remember the store base URL for future lookups
  blobBaseUrl = blob.url.slice(0, blob.url.length - blob.pathname.length - 1);
  return blob.url;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface UploadTarget {
  provider: StorageProvider;
  /** Path to store in the DB, e.g. "/objects/uploads/<uuid>". */
  objectPath: string;
  /** replit only: presigned PUT URL the client uploads to directly. */
  uploadURL?: string;
  /** vercel-blob only: blob pathname for the client-upload flow. */
  pathname?: string;
}

/**
 * Prepare a new object upload. For the Replit backend this returns a
 * presigned PUT URL; for Vercel Blob it returns the pathname the client
 * should upload via the /api/storage/blob-upload client-token exchange.
 */
export async function getUploadTarget(): Promise<UploadTarget> {
  const provider = getStorageProvider();
  const uuid = crypto.randomUUID();
  const entityId = `uploads/${uuid}`;
  const objectPath = `/objects/${entityId}`;

  if (provider === "replit") {
    const { bucketName, objectName } = replitGcsLocation(entityId);
    const uploadURL = await signObjectURL(bucketName, objectName, "PUT", 900);
    return { provider, objectPath, uploadURL };
  }

  return { provider, objectPath, pathname: entityId };
}

/**
 * Resolve a URL that serves the stored object. objectPath must start with
 * /objects/ (as stored in the DB). For Replit this is a presigned GET URL
 * with the given TTL; Vercel Blob URLs are public and the TTL is ignored.
 */
export async function getServeUrl(
  objectPath: string,
  ttlSec = 3600,
): Promise<string> {
  const entityId = toEntityId(objectPath);
  const provider = getStorageProvider();

  if (provider === "replit") {
    const { bucketName, objectName } = replitGcsLocation(entityId);
    return signObjectURL(bucketName, objectName, "GET", ttlSec);
  }

  // Vercel Blob: the production store is PRIVATE, so raw blob URLs return
  // 403 to browsers.  Serve through the app's public image route instead,
  // which streams the object using server-side credentials.  Return an
  // absolute URL when the platform base URL is known (required for external
  // consumers such as Stripe checkout line-item images).
  const publicPath = `/api/storage/public?path=${encodeURIComponent(objectPath)}`;
  const base = getPlatformBaseUrl();
  return base ? `${base}${publicPath}` : publicPath;
}

/**
 * Upload an object body directly to the storage backend.
 *
 * For Vercel Blob this uses the server-side put() API (server-to-server, no
 * CORS). For Replit it proxies the PUT through the sidecar-signed URL.
 *
 * Warms the in-process URL cache so the first getServeUrl() call after an
 * upload is instant (no blobList() round-trip required).
 */
export async function putObject(
  entityId: string,
  body: ReadableStream<Uint8Array> | Blob,
  contentType: string,
): Promise<void> {
  const provider = getStorageProvider();

  if (provider === "vercel-blob") {
    const result = await blobPut(entityId, body, {
      access: "private",
      contentType,
      addRandomSuffix: false,
    });
    // Warm the serve-URL cache so the first render after upload is instant.
    blobUrlCache.set(entityId, result.url);
    if (!blobBaseUrl) {
      blobBaseUrl = result.url.slice(
        0,
        result.url.length - entityId.length - 1,
      );
    }
    return;
  }

  // Replit: proxy through the sidecar-signed PUT URL.
  const { bucketName, objectName } = replitGcsLocation(entityId);
  const putUrl = await signObjectURL(bucketName, objectName, "PUT", 900);
  const res = await fetch(putUrl, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
    // Node.js requires duplex:"half" when the request body is a stream.
    // @ts-expect-error -- non-standard but required at runtime
    duplex: "half",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload object (${res.status}): ${text}`);
  }
}

/**
 * Fetch the raw bytes of a stored object, returning the upstream Response so
 * the caller can stream the body directly to the browser.
 *
 * For Replit this fetches through the sidecar-signed GET URL.
 * For Vercel Blob this fetches the public blob URL.
 *
 * The returned Response's `body` and `headers` (Content-Type, Content-Length,
 * etc.) come straight from the storage backend.
 */
export async function fetchObject(objectPath: string): Promise<Response> {
  const entityId = toEntityId(objectPath);
  const provider = getStorageProvider();

  let url: string;
  let fetchHeaders: Record<string, string> | undefined;
  if (provider === "replit") {
    const { bucketName, objectName } = replitGcsLocation(entityId);
    url = await signObjectURL(bucketName, objectName, "GET", 60);
  } else {
    url = await blobUrlFor(entityId);
    // Private blob stores require the read/write token to fetch raw blob URLs.
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (token) fetchHeaders = { Authorization: `Bearer ${token}` };
  }

  const upstream = await fetch(url, {
    headers: fetchHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upstream.ok) {
    throw new Error(
      `Storage backend returned ${upstream.status} for ${objectPath}`,
    );
  }
  return upstream;
}

/** Delete a stored object. Throws on backend errors (callers may best-effort). */
export async function deleteObject(objectPath: string): Promise<void> {
  const entityId = toEntityId(objectPath);
  const provider = getStorageProvider();

  if (provider === "replit") {
    const { bucketName, objectName } = replitGcsLocation(entityId);
    const url = await signObjectURL(bucketName, objectName, "DELETE", 300);
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete object (${res.status})`);
    }
    return;
  }

  const url = await blobUrlFor(entityId);
  await blobDel(url);
  blobUrlCache.delete(entityId);
}
