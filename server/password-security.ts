import crypto from "crypto";

const SCRYPT_KEY_LENGTH = 64;
const LEGACY_SALT = "marketplacesalt";

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await deriveScrypt(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (storedHash.startsWith("scrypt$")) {
    const [, saltHex, keyHex, ...extra] = storedHash.split("$");
    if (extra.length || !/^[0-9a-f]{32}$/i.test(saltHex || "") || !/^[0-9a-f]{128}$/i.test(keyHex || "")) {
      return { valid: false, needsUpgrade: false };
    }
    const actual = await deriveScrypt(password, Buffer.from(saltHex, "hex"));
    const expected = Buffer.from(keyHex, "hex");
    return {
      valid: crypto.timingSafeEqual(actual, expected),
      needsUpgrade: false,
    };
  }

  // Existing accounts use SHA256(password + static salt); retain verification
  // during migration, but only produce scrypt hashes for all new passwords.
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return { valid: false, needsUpgrade: false };
  const actual = crypto.createHash("sha256").update(password + LEGACY_SALT).digest();
  const expected = Buffer.from(storedHash, "hex");
  return {
    valid: crypto.timingSafeEqual(actual, expected),
    needsUpgrade: true,
  };
}