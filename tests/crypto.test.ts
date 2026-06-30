import { describe, it, expect } from "vitest";
import { encryptString, decryptString, isEncrypted, selfTest, clearKeyCache } from "../src/crypto";

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

describe("clearKeyCache", () => {
	it("does not throw", () => {
		expect(() => clearKeyCache()).not.toThrow();
	});
});
