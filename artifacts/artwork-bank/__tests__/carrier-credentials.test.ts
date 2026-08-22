import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptCarrierCredentials,
  encryptCarrierCredentials,
} from "@/lib/carrier-credentials";

const originalKey = process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY =
    "unit-test-freight-credentials-encryption-key-123456789";
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY;
  } else {
    process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY = originalKey;
  }
});

describe("carrier credential encryption", () => {
  it("round-trips credentials without retaining plaintext in the ciphertext", () => {
    const credentials = {
      apiKey: "aupost-secret-key",
      accountNumber: "123456",
    };
    const encrypted = encryptCarrierCredentials(credentials);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain(credentials.apiKey);
    expect(decryptCarrierCredentials<typeof credentials>(encrypted)).toEqual(
      credentials,
    );
  });

  it("fails closed when the encryption secret is missing", () => {
    delete process.env.FREIGHT_CREDENTIALS_ENCRYPTION_KEY;
    expect(() => encryptCarrierCredentials({ apiKey: "secret" })).toThrow(
      /FREIGHT_CREDENTIALS_ENCRYPTION_KEY/,
    );
  });
});