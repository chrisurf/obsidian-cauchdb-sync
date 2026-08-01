# Contributing to CouchDB Sync

Thanks for your interest in improving CouchDB Sync! This guide covers how to set
up the project, the quality bar every change is held to, and the conventions the
repository follows.

## Development setup

```bash
npm ci          # install dependencies (clean)
npm run dev     # esbuild watch build (no type-check) while you work
```

The build output is a single `main.js` (git-ignored; produced by esbuild).

## Quality gates

Every pull request must pass the same checks CI runs. Please run them locally
before opening a PR:

```bash
npm run lint        # eslint — eslint-plugin-obsidianmd + typescript-eslint (type-checked)
npm run lint:css    # stylelint — Obsidian browser-feature support for styles.css
npx tsc --noEmit --skipLibCheck   # strict type-check
npm test            # vitest unit tests
npm run build       # production bundle
npm run check:bundle # fails if the bundle contains a Node built-in require() (mobile-safety)
```

`npm run lint:all` runs both linters together.

### Why these gates

- **`lint`** mirrors the **Obsidian community plugin review**: it runs
  `eslint-plugin-obsidianmd` (platform rules) plus `typescript-eslint`'s
  *type-checked* rules. The review type-checks against a browser-only environment
  (no `@types/node`), so keep desktop-only Node access behind the typed helpers in
  `src/node.ts` — never spread untyped `any` from `require`/`fs` through the code.
- **`lint:css`** mirrors the review's CSS scan
  (`stylelint-no-unsupported-browser-features`) against Obsidian's Chromium floor
  (see the `browserslist` field in `package.json`). Prefer widely-supported CSS;
  avoid `text-decoration-*` longhands (use a border or the single-value shorthand).
- **`check:bundle`** guards the "installs but won't enable on mobile" class of bug:
  Obsidian mobile has no Node `require`, so a bundled `require("<builtin>")` throws
  at load. Polyfill such modules in `esbuild.config.mjs` instead of externalizing
  them.

### End-to-end tests

```bash
npm run test:e2e    # builds, then runs the plugin inside a real Obsidian (headless)
```

The sync-roundtrip spec only runs when a CouchDB server is provided via
`COUCHDB_URL` (see `e2e/README.md`); otherwise it is skipped.

## Conventions

- **Branches:** `feature/<short-descriptive-name>` (lowercase, hyphenated).
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `ci:`. The commit type
  drives the automatic version bump on merge to `main` (`feat` → minor,
  `fix`/others → patch, `!`/`BREAKING CHANGE` → major).
- **PRs:** one feature per PR; the title follows the same conventional format and
  is squash-merged into `main`, which auto-cuts a SemVer release.
- **Types & pure logic:** shared interfaces live in `src/types.ts`; pure,
  Obsidian-free helpers live in `src/util.ts` and are the primary unit-test target.

## Reporting issues

Please include your Obsidian version, platform (desktop/mobile), and whether
end-to-end encryption is enabled. For sync problems, the file's state in the
in-app index view (synced / local / remote / differs / conflict) is very helpful.
