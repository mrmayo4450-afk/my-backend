import assert from "node:assert/strict";
import crypto from "crypto";
import { hashPassword, verifyPassword } from "./password-security";

const firstHash = await hashPassword("self-check-password");
const secondHash = await hashPassword("self-check-password");
assert.notEqual(firstHash, secondHash, "new password hashes must use unique salts");
assert.deepEqual(await verifyPassword("self-check-password", firstHash), { valid: true, needsUpgrade: false });
assert.deepEqual(await verifyPassword("wrong-password", firstHash), { valid: false, needsUpgrade: false });

const legacyHash = crypto.createHash("sha256").update("self-check-passwordmarketplacesalt").digest("hex");
assert.deepEqual(await verifyPassword("self-check-password", legacyHash), { valid: true, needsUpgrade: true });
assert.deepEqual(await verifyPassword("wrong-password", legacyHash), { valid: false, needsUpgrade: true });
console.log("Password hashing self-check passed.");