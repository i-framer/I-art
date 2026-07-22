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

import { del as blobDel, list as blobList } from "@vercel/blob";

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

  return blobUrlFor(entityId);
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
