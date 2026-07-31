// Semantic-version decision for the auto-release workflow.
//
// Given the commit subjects merged since the last release tag, decide the next
// version according to Conventional Commits + SemVer:
//
//   • a breaking change  (`type!:` or a "BREAKING CHANGE" footer) -> MAJOR
//   • a `feat:` commit                                            -> MINOR
//   • any other commit   (fix, perf, refactor, chore, docs, …)    -> PATCH
//   • no releasable commits at all                                -> none
//
// The "any other commit -> patch" rule is deliberate: the project cuts a release
// on every merge to main (squash-merge = one commit per PR), so a docs- or
// chore-only PR still yields a fresh patch version. Only a truly empty range
// (nothing new since the last tag) produces no release.
//
// The pure functions are unit-tested (tests/release-version.test.ts); the CLI at
// the bottom only runs when the file is executed directly, so importing it in a
// test never touches the filesystem or stdin.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Bump levels, most to least significant. */
export const LEVELS = /** @type {const} */ (["major", "minor", "patch"]);

/**
 * Classify a single commit message into the bump level it demands, or null when
 * it is our own release commit (which must never trigger another release).
 *
 * @param {string} message full commit message (subject and optional body)
 * @returns {"major"|"minor"|"patch"|null}
 */
export function classifyCommit(message) {
	const text = String(message ?? "");
	const subject = text.split("\n", 1)[0].trim();

	// Never let an auto-release commit trigger a follow-up release.
	if (/^chore\(release\):/i.test(subject)) return null;

	// Conventional header: type, optional (scope), optional "!" for breaking.
	const header = subject.match(/^([a-zA-Z]+)(\([^)]*\))?(!)?:/);
	const type = header?.[1]?.toLowerCase();
	const bang = header?.[3] === "!";

	// A "BREAKING CHANGE:" / "BREAKING-CHANGE:" footer anywhere is also major.
	const breakingFooter = /(^|\n)\s*BREAKING[ -]CHANGE\s*:/i.test(text);

	if (bang || breakingFooter) return "major";
	if (type === "feat") return "minor";
	// Everything else that is still a real commit is a patch (see file header).
	return "patch";
}

/**
 * The highest bump level demanded by a set of commit messages, or null when the
 * set is empty / contains only ignorable commits.
 *
 * @param {string[]} messages
 * @returns {"major"|"minor"|"patch"|null}
 */
export function classifyBump(messages) {
	let best = null;
	for (const m of messages ?? []) {
		const level = classifyCommit(m);
		if (level === null) continue;
		if (best === null || LEVELS.indexOf(level) < LEVELS.indexOf(best)) {
			best = level;
		}
		if (best === "major") break; // cannot go higher
	}
	return best;
}

/**
 * Apply a bump level to a `MAJOR.MINOR.PATCH` version string.
 *
 * @param {string} version current version, e.g. "0.33.0"
 * @param {"major"|"minor"|"patch"} level
 * @returns {string} the next version
 */
export function nextVersion(version, level) {
	const m = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) throw new Error(`not a MAJOR.MINOR.PATCH version: "${version}"`);
	let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	switch (level) {
		case "major":
			major += 1; minor = 0; patch = 0; break;
		case "minor":
			minor += 1; patch = 0; break;
		case "patch":
			patch += 1; break;
		default:
			throw new Error(`unknown bump level: "${level}"`);
	}
	return `${major}.${minor}.${patch}`;
}

/**
 * End-to-end: from the current version + the commits since the last tag, compute
 * the next version, or null when there is nothing to release.
 *
 * @param {string} current
 * @param {string[]} messages
 * @returns {string|null}
 */
export function computeNextVersion(current, messages) {
	const level = classifyBump(messages);
	return level === null ? null : nextVersion(current, level);
}

// --- CLI -------------------------------------------------------------------
// Reads commit subjects from stdin (one per line — the workflow pipes
// `git log --format=%B%x00`-style records split on NUL, joined per commit) and
// prints the next version to stdout, or the literal "none" when nothing is
// releasable. Exit code is always 0; the workflow branches on the printed value.

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const raw = readStdin();
	// Commits are separated by a NUL byte so multi-line bodies stay intact.
	const messages = raw.split("\0").map((s) => s.trim()).filter((s) => s.length > 0);
	const next = computeNextVersion(pkg.version, messages);
	const outFile = process.env.GITHUB_OUTPUT;
	const level = classifyBump(messages);
	if (outFile) {
		const lines = [`version=${next ?? ""}`, `level=${level ?? ""}`, `release=${next ? "true" : "false"}`];
		writeFileSync(outFile, lines.join("\n") + "\n", { flag: "a" });
	}
	process.stdout.write(next ?? "none");
}
