# Contributing to velvet-rope

Thanks for helping. Velvet-rope is a small library that other apps rely on for sign-in, so we
aim for changes that are small, tested, and careful about security.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Include your
  Node version and SQLite driver (`better-sqlite3` or `node:sqlite`).
- **Features and larger changes:** open an issue to discuss them first. Changes to the public
  API, the routes, the session shape or the database schema affect every app that uses
  velvet-rope, so it's worth agreeing on the approach before you write the code.
- **Security problems:** please don't open a public issue. Report them privately through
  GitHub's **Report a vulnerability** button on the repository's Security tab.

## Setting up

You need Node 22 or newer.

```
git clone https://github.com/EyeOfMidas/velvet-rope.git
cd velvet-rope
npm install
npm run check
```

To try the example app, run `npm run example` and `npm run example:web` in two terminals. Then
open http://localhost:5174 in two browser profiles, to join one from the other.

[docs/architecture.md](docs/architecture.md) explains how the code is laid out.
[AGENTS.md](AGENTS.md) lists the project's rules: what must never change and how the code is
written. It's written for AI coding agents but applies to everyone.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Write a test first. Tests live in `test/`, mirroring `src/`:
   - pure rules go in `test/domain/`;
   - routes go in `test/server/`, through `fastify.inject` and the soft authenticator;
   - browser code goes in `test/client/`, using happy-dom.
3. Make the change. Keep it focused, and match the style of the code around it.
4. Run both test suites and the linter:

   ```
   npm run check              # lint and tests
   npm run test:node-sqlite   # the tests again on node:sqlite
   ```

   `npm run format` fixes formatting.
5. Add a line to [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`, under Added, Changed,
   Deprecated, Removed or Fixed, if the change is something a user of the library would notice.
   Start it with **Breaking:** if apps need to change their code.
6. Open a pull request. Say what it changes and why, and link the issue.

## What we look for

- **Security rules hold:**
  - secrets are stored only as hashes and never logged;
  - every query is scoped to the session's group;
  - refusals stay `{ error, message }`.
- **Both SQLite drivers work.**
- **The schema changes only through migrations:** add a new numbered file in
  `src/server/migrations/` and never edit one that has been released. Existing data must
  survive the upgrade.
- **No new dependencies** unless the issue discussion agreed on them.
- **Docs:** the README is updated when the way apps use the library changes.

## Licence

Velvet-rope is licensed under the [Mozilla Public License 2.0](LICENSE). By contributing, you
agree that your contributions are licensed under the same terms.
