import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyFromSecret = (secret: string): Buffer => createHash("sha256").update(secret).digest();

export type EncryptedCredential = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

export const encryptCredential = (value: Record<string, unknown>, secret: string, keyVersion = 1): EncryptedCredential => {
  if (!secret) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for connector credentials");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), keyVersion };
};

export const decryptCredential = (value: EncryptedCredential, secret: string): Record<string, unknown> => {
  if (!secret) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for connector credentials");
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8")) as Record<string, unknown>;
};
