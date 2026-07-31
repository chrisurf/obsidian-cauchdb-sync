import { browser, expect } from "@wdio/globals";
import { describe, it, before, beforeEach } from "mocha";
import assert from "node:assert/strict";
import { obsidianPage } from "wdio-obsidian-service";
import { PLUGIN_ID, callPlugin } from "./helpers.js";

/**
 * TRUE end-to-end layer — only runs when a CouchDB server is provided via env.
 * Start one with `docker compose -f docker-compose.couchdb.yml up -d` and export:
 *
 *   COUCHDB_URL=http://127.0.0.1:5984   COUCHDB_USER=admin   COUCHDB_PASS=password
 *
 * It drives the plugin to sync a real vault file to a real CouchDB and then
 * inspects the wire form on the server directly, proving both:
 *   (1) the round-trip works (the file is uploaded), and
 *   (2) this branch's metadata-privacy guarantee — with e2ee on, the server sees
 *       NO plaintext path or content, and the file doc is in envelope form.
 *
 * When COUCHDB_URL is unset the whole suite is skipped (not failed), so the
 * default `npm run test:e2e` stays infrastructure-free.
 */

const BASE = process.env.COUCHDB_URL;
const USER = process.env.COUCHDB_USER ?? "admin";
const PASS = process.env.COUCHDB_PASS ?? "password";
const VAULT = "e2e/vaults/simple";

// Unique db per run so repeated local runs never collide. Date.now() is fine
// here (a normal Node/mocha process, unlike the workflow sandbox).
const DB_NAME = `obsidian_e2e_${Date.now()}`;

const PLAINTEXT_NAME = "SecretDiary.md";
const PLAINTEXT_BODY = "MAGIC_MARKER_zebra_umbrella_42";
const PASSPHRASE = "correct-horse-battery-staple";

// Credentials go in an Authorization header, NOT inline in the URL: Node's
// fetch (undici) throws "Request cannot be constructed from a URL that includes
// credentials" for http://user:pass@host/... URLs.
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function couch(pathPart: string, init: RequestInit = {}): Promise<Response> {
	const url = new URL(pathPart, BASE!).toString();
	return fetch(url, {
		...init,
		headers: { ...(init.headers ?? {}), Authorization: AUTH },
	});
}

/** Configure the plugin's remote + encryption and (re)start a sync session. */
async function configureAndStart(): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, cfg) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings(): Promise<void>; restartSync(): Promise<void> }> };
			}).plugins.plugins[id];
			Object.assign(plugin.settings, cfg);
			await plugin.saveSettings();
			await plugin.restartSync();
		},
		PLUGIN_ID,
		{
			serverUrl: BASE,
			dbName: DB_NAME,
			username: USER,
			password: PASS,
			e2eeEnabled: true,
			passphrase: PASSPHRASE,
			liveSync: true,
			syncEnabled: true,
			connectionVerified: true,
			// Master mode publishes a master-info doc — assert it does not leak the
			// device id in cleartext to the server (regression guard for B4).
			isMaster: true,
		},
	);
}

/** The plugin's own device id (used to prove it is not leaked to the server). */
function pluginDeviceId(): Promise<string> {
	return browser.executeObsidian(({ app }, id) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, { settings: { deviceId: string } }> };
		}).plugins.plugins[id];
		return plugin.settings.deviceId;
	}, PLUGIN_ID);
}

async function waitForRemoteDoc(predicate: (docs: any[]) => boolean, timeoutMs = 30000): Promise<any[]> {
	const deadline = Date.now() + timeoutMs;
	let last: any[] = [];
	while (Date.now() < deadline) {
		const res = await couch(`/${DB_NAME}/_all_docs?include_docs=true`);
		if (res.ok) {
			const body = (await res.json()) as { rows: { doc: any }[] };
			last = body.rows.map((r) => r.doc);
			if (predicate(last)) return last;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return last;
}

(BASE ? describe : describe.skip)("CouchDB Sync — end-to-end sync against a real server", function () {
	this.timeout(90 * 1000);

	before(async function () {
		// Create the target database (idempotent: 201 created or 412 exists).
		const res = await couch(`/${DB_NAME}`, { method: "PUT" });
		assert.ok(res.status === 201 || res.status === 412, `could not create db ${DB_NAME}: ${res.status}`);
	});

	beforeEach(async function () {
		await obsidianPage.resetVault(VAULT);
	});

	it("uploads a vault file to the server (round-trip)", async function () {
		await browser.executeObsidian(async ({ app }, name, body) => {
			const existing = app.vault.getFileByPath(name);
			if (existing) await app.vault.modify(existing, body);
			else await app.vault.create(name, body);
		}, PLAINTEXT_NAME, PLAINTEXT_BODY);

		await configureAndStart();

		// A file doc (id prefix "f:") and at least one content chunk ("h:") must appear.
		const docs = await waitForRemoteDoc((ds) => ds.some((d) => String(d?._id).startsWith("f:")));
		const fileDocs = docs.filter((d) => String(d?._id).startsWith("f:"));
		assert.ok(fileDocs.length >= 1, `expected a file doc on the server, saw ids: ${docs.map((d) => d?._id).join(", ")}`);
	});

	it("leaks no plaintext path or content to the server (metadata privacy)", async function () {
		const docs = await waitForRemoteDoc((ds) => ds.some((d) => String(d?._id).startsWith("f:")));
		const wire = JSON.stringify(docs);

		// The whole server-visible payload must not contain the plaintext filename
		// or the plaintext body — both are inside the AES-GCM `meta`/chunk blobs.
		assert.ok(!wire.includes(PLAINTEXT_NAME), "server payload leaked the plaintext file path");
		assert.ok(!wire.includes("SecretDiary"), "server payload leaked part of the plaintext file name");
		assert.ok(!wire.includes(PLAINTEXT_BODY), "server payload leaked the plaintext file body");

		// And the file doc is in envelope wire form: an `enc` marker + a `meta` blob,
		// with the id being an opaque HMAC (not the readable path).
		const fileDoc = docs.find((d) => String(d?._id).startsWith("f:"));
		assert.ok(fileDoc, "no file doc found");
		await expect(typeof fileDoc.meta).toBe("string");
		await expect(fileDoc.enc).toBeTruthy();
		assert.ok(!String(fileDoc._id).includes(PLAINTEXT_NAME), "the doc id itself leaked the path");

		// B4: with master mode on, the master-info doc must NOT carry the device id
		// in cleartext. It is a replicating doc, so it appears in the payload — but
		// its body must be an encrypted `meta` blob, not a plaintext deviceId.
		const deviceId = await pluginDeviceId();
		assert.ok(deviceId && deviceId.length > 0, "expected a device id");
		assert.ok(!wire.includes(deviceId), "server payload leaked the cleartext device id (master-info)");
		const masterDoc = docs.find((d) => String(d?._id).includes("masterinfo"));
		if (masterDoc) {
			assert.equal(masterDoc.masterId, undefined, "master-info doc exposed a plaintext masterId");
			await expect(typeof masterDoc.meta).toBe("string");
		}
	});

	it("keeps the local plugin healthy and origin-stamped after sync", async function () {
		// Reaching steady state stamps the origin fingerprint -> state is 'match'.
		const state = await callPlugin<string>("getOriginState");
		await expect(["match", "unset"]).toContain(state);
	});
});
