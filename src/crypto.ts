import { base64ToUint8, uint8ToBase64 } from "./util";

/**
 * End-to-end encryption for document content.
 *
 * Format of an encrypted payload (string):
 *   "v1:<saltB64>:<ivB64>:<cipherB64>"
 *
 * - AES-256-GCM for confidentiality + integrity (auth tag included by WebCrypto).
 * - Key derived from the user passphrase via PBKDF2 (SHA-256, 210k iterations).
 * - A random 16-byte salt and 12-byte IV are generated per message, so the same
 *   plaintext never produces the same ciphertext. Derived keys are cached by salt.
 *
 * This protects data AT REST on the CouchDB server. Data IN TRANSIT is additionally
 * protected by TLS (the server URL must be https). The passphrase never leaves the
 * device and is never written to the database.
 */

const PREFIX = "v1";
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const keyCache = new Map<string, CryptoKey>();

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
	const cacheKey = uint8ToBase64(salt) + "|" + passphrase;
	const cached = keyCache.get(cacheKey);
	if (cached) return cached;

	const baseKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: salt as unknown as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
	keyCache.set(cacheKey, key);
	return key;
}

export function isEncrypted(payload: string): boolean {
	return typeof payload === "string" && payload.startsWith(PREFIX + ":");
}

export async function encryptString(plaintext: string, passphrase: string): Promise<string> {
	if (!passphrase) throw new Error("Cannot encrypt: passphrase is empty");
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(passphrase, salt);
	const cipher = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		enc.encode(plaintext)
	);
	return [
		PREFIX,
		uint8ToBase64(salt),
		uint8ToBase64(iv),
		uint8ToBase64(new Uint8Array(cipher)),
	].join(":");
}

export async function decryptString(payload: string, passphrase: string): Promise<string> {
	if (!passphrase) throw new Error("Cannot decrypt: passphrase is empty");
	const parts = payload.split(":");
	if (parts.length !== 4 || parts[0] !== PREFIX) {
		throw new Error("Invalid encrypted payload format");
	}
	const salt = base64ToUint8(parts[1]);
	const iv = base64ToUint8(parts[2]);
	const cipher = base64ToUint8(parts[3]);
	const key = await deriveKey(passphrase, salt);
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as unknown as BufferSource },
			key,
			cipher as unknown as BufferSource
		);
		return dec.decode(plain);
	} catch {
		throw new Error(
			"Decryption failed. The passphrase is most likely different from the device that wrote this note."
		);
	}
}

/**
 * Encrypt raw bytes and return a single binary blob laid out as
 *   salt(16) || iv(12) || ciphertext(+GCM tag)
 * Used for chunk payloads stored as CouchDB attachments — no base64 wrapping, so
 * the stored size is ~the plaintext size instead of the old base64-of-encrypt-of-
 * base64 (~1.77x) format.
 */
export async function encryptBytes(plain: Uint8Array, passphrase: string): Promise<Uint8Array> {
	if (!passphrase) throw new Error("Cannot encrypt: passphrase is empty");
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(passphrase, salt);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as unknown as BufferSource },
			key,
			plain as unknown as BufferSource
		)
	);
	const out = new Uint8Array(salt.length + iv.length + cipher.length);
	out.set(salt, 0);
	out.set(iv, salt.length);
	out.set(cipher, salt.length + iv.length);
	return out;
}

/** Inverse of encryptBytes. Throws a clear error on a wrong passphrase / corrupt blob. */
export async function decryptBytes(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
	if (!passphrase) throw new Error("Cannot decrypt: passphrase is empty");
	if (blob.length < SALT_BYTES + IV_BYTES + 16) {
		throw new Error("Invalid encrypted chunk (too short)");
	}
	const salt = blob.subarray(0, SALT_BYTES);
	const iv = blob.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
	const cipher = blob.subarray(SALT_BYTES + IV_BYTES);
	const key = await deriveKey(passphrase, salt);
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as unknown as BufferSource },
			key,
			cipher as unknown as BufferSource
		);
		return new Uint8Array(plain);
	} catch {
		throw new Error(
			"Decryption failed. The passphrase is most likely different from the device that wrote this note."
		);
	}
}

/** Verify a passphrase can round-trip (used by the settings "test" button). */
export async function selfTest(passphrase: string): Promise<boolean> {
	const sample = "couchdb-sync-selftest";
	const out = await decryptString(await encryptString(sample, passphrase), passphrase);
	return out === sample;
}

// --- deterministic path HMAC (for metadata-private document ids) ------------

/**
 * Key used to HMAC vault paths into opaque document ids. Unlike the content key,
 * this is derived with a FIXED salt so every device with the same passphrase
 * derives the SAME key — two devices must map a given path to the same id, or they
 * would create duplicate docs instead of one shared, conflict-mergeable doc.
 *
 * Security note: the fixed salt is acceptable here because the secret is the
 * passphrase and the goal is a *keyed* one-way mapping (not password storage). The
 * HMAC hides the plaintext path from anyone without the passphrase and defeats the
 * offline dictionary attack that a plain SHA-256(path) would allow.
 */
const PATH_HMAC_SALT = enc.encode("couchdb-sync:path-hmac:v1");
const pathKeyCache = new Map<string, CryptoKey>();

async function derivePathKey(passphrase: string): Promise<CryptoKey> {
	const cached = pathKeyCache.get(passphrase);
	if (cached) return cached;
	const baseKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: PATH_HMAC_SALT as unknown as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"]
	);
	pathKeyCache.set(passphrase, key);
	return key;
}

/**
 * Deterministic keyed hash of a vault path → 64-char lowercase hex. Same path +
 * passphrase always yields the same value (so all devices agree on the doc id);
 * a different passphrase yields a completely different value. One-way: the path
 * cannot be recovered from the hash (the real path travels encrypted in the doc
 * body instead).
 */
export async function hmacPath(path: string, passphrase: string): Promise<string> {
	if (!passphrase) throw new Error("Cannot hash path: passphrase is empty");
	const key = await derivePathKey(passphrase);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(path)));
	let hex = "";
	for (const b of mac) hex += b.toString(16).padStart(2, "0");
	return hex;
}

export function clearKeyCache(): void {
	keyCache.clear();
	pathKeyCache.clear();
}
