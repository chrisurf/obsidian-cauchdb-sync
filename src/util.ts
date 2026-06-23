/** Fast, non-cryptographic 53-bit string hash (cyrb53) for echo detection. */
export function cyrb53(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buf);
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunk) as unknown as number[]
		);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunk) as unknown as number[]
		);
	}
	return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
	return new Uint8Array(base64ToArrayBuffer(b64));
}

/** Generate a short, stable, random device id. */
export function generateDeviceId(): string {
	const rnd = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function textToBytes(s: string): Uint8Array {
	return textEncoder.encode(s);
}

export function bytesToText(b: Uint8Array): string {
	return textDecoder.decode(b);
}

/** SHA-256 of the given bytes as a lowercase hex string. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	const arr = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
	return hex;
}

/** Split a byte array into fixed-size pieces. An empty input yields no pieces. */
export function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += size) {
		out.push(bytes.subarray(i, i + size));
	}
	return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** Treat these extensions as binary. Everything else is read as UTF-8 text. */
const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico",
	"pdf", "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "webm", "avi",
	"zip", "gz", "7z", "rar", "tar",
	"ttf", "otf", "woff", "woff2", "eot",
	"xlsx", "docx", "pptx", "odt",
	"bin", "dat",
]);

export function isBinaryPath(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

export function matchesIgnore(path: string, patterns: string[]): boolean {
	return patterns.some((p) => {
		if (!p) return false;
		// prefix match for folder-ish patterns, otherwise substring
		if (p.endsWith("/")) return path.startsWith(p) || path.includes("/" + p);
		return path === p || path.startsWith(p);
	});
}
