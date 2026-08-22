import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function credentialsKey(): Buffer {
  const secret = process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret || secret.trim().length < 32) {
    throw new Error(
      "Freight credential storage is unavailable. Set FREIGHT_CREDENTIALS_ENCRYPTION_KEY to a 32+ character secret before connecting a carrier.",
    );
  }

  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a carrier credential payload using AES-256-GCM. The random IV and
 * authentication tag are stored with the ciphertext; the encryption key stays
 * in the server environment and is never returned to the browser.
 */
export function encryptCarrierCredentials(value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", credentialsKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptCarrierCredentials<T>(ciphertext: string): T {
  const [version, ivValue, authTagValue, encryptedValue, ...extra] =
    ciphertext.split(".");
  if (
    version !== VERSION ||
    !ivValue ||
    !authTagValue ||
    !encryptedValue ||
    extra.length > 0
  ) {
    throw new Error("Stored carrier credentials have an invalid format.");
  }

  const iv = Buffer.from(ivValue, "base64url");
  const authTag = Buffer.from(authTagValue, "base64url");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Stored carrier credentials have an invalid format.");
  }

  const decipher = createDecipheriv("aes-256-gcm", credentialsKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext) as T;
}