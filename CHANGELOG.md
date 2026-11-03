# Changelog

Every notable change to velvet-rope, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version (0.x.0)
may break things. Breaking changes are marked **Breaking:**, and the release notes say how to
upgrade.

## [Unreleased]

## [0.2.0] - 2026-11-01

### Added

- Support for Node's built-in `node:sqlite` (Node 22.5+) alongside `better-sqlite3`. Pass a
  handle from either driver wherever velvet-rope takes a `db`.
- `openDatabase(path, { driver })` opens a database with whichever driver is installed,
  `better-sqlite3` first. `wrapDatabase(db)` adapts a handle the app already opened.
- npm package metadata: repository, homepage and issue tracker.

### Changed

- `better-sqlite3` is now an optional peer dependency.
- The licence is now MPL-2.0.

## [0.1.0] - 2026-10-28

The first version.

### Added

- **Passkey sign-in:** discoverable sign-in, where the passkey picked decides the group.
  Sessions use a hashed 256-bit cookie (`HttpOnly`, `SameSite=Strict`, `__Host-` on HTTPS) with
  a 30-day sliding expiry.
- **Joining by QR:**
  - a new device shows a QR code;
  - a signed-in member who can `link` scans it, and the scan is the approval;
  - the new device then registers its own passkey with the linked role.
- **Groups:** creation, controlled by `groupCreation` (`open`, `invite` or `closed`). Invites
  are single-use, and an admin can delete the group.
- **Roles:** defined by the app with `defineRoles`. Members can be listed, renamed, given a new
  role, revoked, or can leave, and the last admin can't be removed.
- **Server-Sent Events:** a stream per group (`members-changed`, `role-changed`,
  `session-revoked`, `group-deleted`) that the app can share for its own events.
- **Protections:**
  - a CSRF guard (JSON and a custom header);
  - rate limits through `@fastify/rate-limit`;
  - `{ error, message }` refusals that apps can reword;
  - `startSweeper` for expired rows.
- **Entry points:**
  - `velvet-rope/domain`, `/server`, `/client` and `/ui` (with `ui/style.css`);
  - `/testing`, with a soft authenticator and member helpers;
  - `/testing/playwright`.
- An example notes app.

[Unreleased]: https://github.com/EyeOfMidas/velvet-rope/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/EyeOfMidas/velvet-rope/compare/caf6bbb...v0.2.0
[0.1.0]: https://github.com/EyeOfMidas/velvet-rope/commit/caf6bbb
