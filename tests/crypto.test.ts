import { describe, it, expect } from "vitest";
import {
	encryptString,
	decryptString,
	encryptBytes,
	decryptBytes,
	isEncrypted,
	selfTest,
	clearKeyCache,
} from "../src/crypto";

describe("isEncrypted", () => {
	it("recognizes encrypted payloads", () => {
		expect(isEncrypted("v1:abc:def:ghi")).toBe(true);
	});

	it("rejects plain text", () => {
		expect(isEncrypted("hello world")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isEncrypted("")).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isEncrypted(null as unknown as string)).toBe(false);
		expect(isEncrypted(undefined as unknown as string)).toBe(false);
		expect(isEncrypted(42 as unknown as string)).toBe(false);
	});
});

describe("encrypt / decrypt round-trip", () => {
	it("round-trips a simple string", async () => {
		const passphrase = "test-passphrase-123";
		const plaintext = "Hello, CouchDB Sync!";
		const encrypted = await encryptString(plaintext, passphrase);
		expect(isEncrypted(encrypted)).toBe(true);
		const decrypted = await decryptString(encrypted, passphrase);
		expect(decrypted).toBe(plaintext);
	});

	it("round-trips Unicode content", async () => {
		const passphrase = "unicode-test";
		const plaintext = "日本語テスト 🎉 Ünïcödé";
		const encrypted = await encryptString(plaintext, passphrase);
		const decrypted = await decryptString(encrypted, passphrase);
		expect(decrypted).toBe(plaintext);
	});

	it("round-trips empty string", async () => {
		const passphrase = "empty-test";
		const encrypted = await encryptString("", passphrase);
		const decrypted = await decryptString(encrypted, passphrase);
		expect(decrypted).toBe("");
	});

	it("produces different ciphertext each time (random salt/IV)", async () => {
		const passphrase = "same-pass";
		const plaintext = "same content";
		const a = await encryptString(plaintext, passphrase);
		const b = await encryptString(plaintext, passphrase);
		expect(a).not.toBe(b);
	});
});

describe("decryption failures", () => {
	it("wrong passphrase throws", async () => {
		const encrypted = await encryptString("secret", "correct-pass");
		await expect(decryptString(encrypted, "wrong-pass")).rejects.toThrow();
	});

	it("empty passphrase throws on encrypt", async () => {
		await expect(encryptString("text", "")).rejects.toThrow("passphrase is empty");
	});

	it("empty passphrase throws on decrypt", async () => {
		await expect(decryptString("v1:a:b:c", "")).rejects.toThrow("passphrase is empty");
	});

	it("malformed payload throws", async () => {
		await expect(decryptString("garbage", "pass")).rejects.toThrow("Invalid encrypted payload");
	});
});

describe("selfTest", () => {
	it("returns true for a valid passphrase", async () => {
		expect(await selfTest("my-secure-pass")).toBe(true);
	});
});

describe("encryptBytes / decryptBytes (chunk payloads)", () => {
	it("round-trips arbitrary bytes", async () => {
		const plain = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 0, 7]);
		const blob = await encryptBytes(plain, "pw");
		const back = await decryptBytes(blob, "pw");
		expect(Array.from(back)).toEqual(Array.from(plain));
	});

	it("round-trips an empty payload", async () => {
		const back = await decryptBytes(await encryptBytes(new Uint8Array(), "pw"), "pw");
		expect(back.length).toBe(0);
	});

	it("produces a different ciphertext each time (random salt/iv)", async () => {
		const plain = new Uint8Array([1, 2, 3]);
		const a = await encryptBytes(plain, "pw");
		const b = await encryptBytes(plain, "pw");
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});

	it("fails to decrypt with the wrong passphrase", async () => {
		const blob = await encryptBytes(new Uint8Array([5, 5, 5]), "right");
		await expect(decryptBytes(blob, "wrong")).rejects.toThrow(/Decryption failed/);
	});

	it("rejects a truncated/corrupt blob", async () => {
		await expect(decryptBytes(new Uint8Array([1, 2, 3]), "pw")).rejects.toThrow();
	});

	it("throws on an empty passphrase", async () => {
		await expect(encryptBytes(new Uint8Array([1]), "")).rejects.toThrow(/passphrase is empty/);
	});
});

describe("clearKeyCache", () => {
	it("does not throw", () => {
		expect(() => clearKeyCache()).not.toThrow();
	});
});
