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
	} catch (e) {
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

export function clearKeyCache(): void {
	keyCache.clear();
}
