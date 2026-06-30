import { describe, it, expect } from "vitest";
import {
	cyrb53,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	uint8ToBase64,
	base64ToUint8,
	textToBytes,
	bytesToText,
	splitBytes,
	concatBytes,
	isBinaryPath,
	looksLikeText,
	isHidden,
	matchesIgnore,
	diffLines,
} from "../src/util";

describe("cyrb53", () => {
	it("returns a hex string", () => {
		const h = cyrb53("hello");
		expect(h).toMatch(/^[0-9a-f]+$/);
	});

	it("is deterministic", () => {
		expect(cyrb53("test")).toBe(cyrb53("test"));
	});

	it("different inputs produce different hashes", () => {
		expect(cyrb53("a")).not.toBe(cyrb53("b"));
	});

	it("respects the seed parameter", () => {
		expect(cyrb53("hello", 1)).not.toBe(cyrb53("hello", 2));
	});

	it("handles empty string", () => {
		const h = cyrb53("");
		expect(h).toMatch(/^[0-9a-f]+$/);
	});
});

describe("base64 round-trip", () => {
	it("ArrayBuffer round-trips through base64", () => {
		const original = new Uint8Array([0, 1, 127, 128, 255]);
		const b64 = arrayBufferToBase64(original.buffer);
		const restored = new Uint8Array(base64ToArrayBuffer(b64));
		expect(restored).toEqual(original);
	});

	it("Uint8Array round-trips through base64", () => {
		const original = new Uint8Array([10, 20, 30, 40, 50]);
		const b64 = uint8ToBase64(original);
		const restored = base64ToUint8(b64);
		expect(restored).toEqual(original);
	});

	it("handles empty arrays", () => {
		const empty = new Uint8Array(0);
		expect(base64ToUint8(uint8ToBase64(empty))).toEqual(empty);
	});

	it("handles large arrays (> 32KB chunk boundary)", () => {
		const large = new Uint8Array(40000);
		for (let i = 0; i < large.length; i++) large[i] = i % 256;
		const restored = base64ToUint8(uint8ToBase64(large));
		expect(restored).toEqual(large);
	});
});

describe("textToBytes / bytesToText", () => {
	it("round-trips ASCII", () => {
		expect(bytesToText(textToBytes("hello"))).toBe("hello");
	});

	it("round-trips Unicode", () => {
		const s = "Ünïcödé 🎉";
		expect(bytesToText(textToBytes(s))).toBe(s);
	});

	it("handles empty string", () => {
		expect(bytesToText(textToBytes(""))).toBe("");
	});
});

describe("splitBytes", () => {
	it("splits into correct chunks", () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const parts = splitBytes(data, 2);
		expect(parts).toHaveLength(3);
		expect(parts[0]).toEqual(new Uint8Array([1, 2]));
		expect(parts[1]).toEqual(new Uint8Array([3, 4]));
		expect(parts[2]).toEqual(new Uint8Array([5]));
	});

	it("returns empty array for empty input", () => {
		expect(splitBytes(new Uint8Array(0), 10)).toHaveLength(0);
	});

	it("single chunk when data fits", () => {
		const data = new Uint8Array([1, 2, 3]);
		expect(splitBytes(data, 10)).toHaveLength(1);
	});
});

describe("concatBytes", () => {
	it("concatenates multiple arrays", () => {
		const a = new Uint8Array([1, 2]);
		const b = new Uint8Array([3, 4, 5]);
		const result = concatBytes([a, b]);
		expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
	});

	it("handles empty parts", () => {
		const result = concatBytes([new Uint8Array(0), new Uint8Array([1])]);
		expect(result).toEqual(new Uint8Array([1]));
	});

	it("splitBytes + concatBytes round-trips", () => {
		const data = new Uint8Array(100);
		for (let i = 0; i < data.length; i++) data[i] = i;
		const parts = splitBytes(data, 17);
		expect(concatBytes(parts)).toEqual(data);
	});
});

describe("isBinaryPath", () => {
	it("treats .md as text", () => {
		expect(isBinaryPath("notes/hello.md")).toBe(false);
	});

	it("treats .json as text", () => {
		expect(isBinaryPath(".obsidian/app.json")).toBe(false);
	});

	it("treats .png as binary", () => {
		expect(isBinaryPath("attachments/image.png")).toBe(true);
	});

	it("treats .pdf as binary", () => {
		expect(isBinaryPath("docs/file.pdf")).toBe(true);
	});

	it("treats unknown extensions as binary", () => {
		expect(isBinaryPath("file.lpf")).toBe(true);
	});

	it("treats extensionless files as binary", () => {
		expect(isBinaryPath("Makefile")).toBe(true);
	});
});

describe("looksLikeText", () => {
	it("detects normal text", () => {
		expect(looksLikeText(textToBytes("Hello, world!\nLine two."))).toBe(true);
	});

	it("detects binary (NUL byte)", () => {
		expect(looksLikeText(new Uint8Array([72, 101, 0, 108]))).toBe(false);
	});

	it("treats empty input as text", () => {
		expect(looksLikeText(new Uint8Array(0))).toBe(true);
	});

	it("detects high control-char ratio as binary", () => {
		const data = new Uint8Array(100);
		for (let i = 0; i < 100; i++) data[i] = i < 50 ? 1 : 65;
		expect(looksLikeText(data)).toBe(false);
	});

	it("allows tabs, newlines, carriage returns", () => {
		const text = "col1\tcol2\nrow\r\n";
		expect(looksLikeText(textToBytes(text))).toBe(true);
	});
});

describe("isHidden", () => {
	it("detects dotfiles", () => {
		expect(isHidden(".gitignore")).toBe(true);
	});

	it("detects dotfolders", () => {
		expect(isHidden(".obsidian/plugins/foo")).toBe(true);
	});

	it("detects nested dotfolders", () => {
		expect(isHidden("path/to/.hidden/file.md")).toBe(true);
	});

	it("normal paths are not hidden", () => {
		expect(isHidden("notes/daily/2024-01-01.md")).toBe(false);
	});
});

describe("matchesIgnore", () => {
	it("matches exact path", () => {
		expect(matchesIgnore(".DS_Store", [".DS_Store"])).toBe(true);
	});

	it("matches folder prefix", () => {
		expect(matchesIgnore(".git/HEAD", [".git/"])).toBe(true);
	});

	it("matches nested folder pattern", () => {
		expect(matchesIgnore("deep/.git/config", [".git/"])).toBe(true);
	});

	it("does not match when no pattern fits", () => {
		expect(matchesIgnore("notes/hello.md", [".git/", ".DS_Store"])).toBe(false);
	});

	it("ignores empty patterns", () => {
		expect(matchesIgnore("anything", ["", ""])).toBe(false);
	});
});

describe("diffLines", () => {
	it("identical texts produce all-equal hunks", () => {
		const hunks = diffLines("a\nb\nc", "a\nb\nc");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe("equal");
	});

	it("detects added lines", () => {
		const hunks = diffLines("a\nc", "a\nb\nc");
		const changes = hunks.filter((h) => h.type === "change");
		expect(changes.length).toBeGreaterThan(0);
	});

	it("detects removed lines", () => {
		const hunks = diffLines("a\nb\nc", "a\nc");
		const changes = hunks.filter((h) => h.type === "change");
		expect(changes.length).toBeGreaterThan(0);
	});

	it("handles empty inputs", () => {
		const hunks = diffLines("", "");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].type).toBe("equal");
	});

	it("completely different texts", () => {
		const hunks = diffLines("a\nb", "x\ny");
		const changes = hunks.filter((h) => h.type === "change");
		expect(changes.length).toBeGreaterThan(0);
	});
});
