# AGENTS.md

Velvet-rope is a published npm library (MPL-2.0): passkey sign-in and in-person QR device
linking for small private web apps. Other apps depend on it, so the public API, the database
schema and the security rules are a contract.

- How the code is laid out and why: [docs/architecture.md](docs/architecture.md)
- Using the library: [README.md](README.md)

## Stack

- Node 22+, plain ES modules, with no build step and no TypeScript.
- Server: Fastify 5, `@simplewebauthn/server`, and SQLite through either `better-sqlite3` or
  `node:sqlite`. Both drivers must keep working.
- Browser: plain DOM with `@simplewebauthn/browser`, `qrcode` and `jsqr`. There's no framework.
- Tests: Vitest, with happy-dom for `test/client/`.
- Prettier (single quotes, 120 columns) and ESLint.

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm test` | Vitest on the default driver |
| `npm run test:node-sqlite` | The whole suite on `node:sqlite` |
| `npm run lint` | ESLint and `prettier --check` |
| `npm run format` | Prettier, writing changes |
| `npm run check` | lint and test (what CI runs, on Node 22 and 24) |
| `npm run example` and `npm run example:web` | The example notes app: API on :3001, page on http://localhost:5174 |

**Still-works check:** `npm run check && npm run test:node-sqlite`.

## Non-negotiables

- **Secrets:**
  - Session cookies, link tokens, challenges and invite codes are 256-bit random values, stored
    only as SHA-256 hashes.
  - Never log them, and never return WebAuthn error text, which can echo challenges.
- **Group scoping:** every query takes the group id from the resolved session, never from the
  request.
- **CSRF:** `SameSite=Strict` cookies, plus the guard in `src/server/csrf.js` for the whole app.
- **Errors:** every refusal is `{ error: code, message }`, and every code has a default message in
  `src/server/messages.js`.
- **`src/domain/` is pure:**
  - no I/O, no clock and no randomness;
  - callers pass `now` and the roles;
  - the server and client both import it.
- **Migrations:**
  - New schema goes in a new numbered file in `src/server/migrations/`.
  - Never edit a migration that has shipped in a release.
  - Migrations must keep existing data and ids.
- **The public API is the package `exports`.** A breaking change to it, to a route, to the
  session shape or to the schema needs a **Breaking:** changelog line, plus a deprecation alias
  where that's cheap.
- **No new runtime dependencies** without asking. Peer dependencies stay optional, per entry
  point.

## Code style

- Each file starts with a comment saying what it is and why. Comments explain intent and
  security reasoning, not mechanics.
- Small modules, named exports, and plain functions over classes (the database adapters are the
  exception).
- Route modules take the shared context object from `src/server/options.js`. Defaults live
  there, not in routes.
- User-facing text in the UI lives in `*_TEXT` objects, and class names in `*_CLASSES`, so apps
  can override them.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every change
anyone using the library would notice gets a line under `## [Unreleased]`. Start a breaking
change with **Breaking:**. Releases move `[Unreleased]` under a version number and bump
`package.json` and `package-lock.json` together.

## Git

- Work on a branch; `main` must always pass the still-works check.
- A commit message should summarize what was changed. Something like "Added new method to ClassName; reformatted file example.js; removed dead code from ClassName"
- Never push, publish to npm, or add remotes. The maintainer does that.
