/**
 * Object storage service for Artwork Bank.
 * Uses the Replit sidecar HTTP API directly — no @google-cloud/storage needed.
 */

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
  method: "GET" | "PUT",
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
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR env var not set");
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/**
 * Generate a presigned PUT URL for a new object upload.
 * Returns the upload URL (for the client to PUT to) and the objectPath
 * to store in the database.
 */
export async function getUploadUrl(): Promise<{
  uploadURL: string;
  objectPath: string;
}> {
  const privateDir = getPrivateObjectDir();
  const uuid = crypto.randomUUID();
  const fullGcsPath = `${privateDir}/uploads/${uuid}`;
  const { bucketName, objectName } = parseGcsPath(fullGcsPath);
  const uploadURL = await signObjectURL(bucketName, objectName, "PUT", 900);
  return { uploadURL, objectPath: `/objects/uploads/${uuid}` };
}

/**
 * Generate a presigned GET URL for serving a stored object.
 * objectPath must start with /objects/ (as stored in the DB).
 */
export async function getServeUrl(
  objectPath: string,
  ttlSec = 3600,
): Promise<string> {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error(`Invalid objectPath: ${objectPath}`);
  }
  const entityId = objectPath.slice("/objects/".length); // e.g. uploads/uuid
  const privateDir = getPrivateObjectDir();
  const fullGcsPath = `${privateDir}/${entityId}`;
  const { bucketName, objectName } = parseGcsPath(fullGcsPath);
  return signObjectURL(bucketName, objectName, "GET", ttlSec);
}
