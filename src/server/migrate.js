// velvet-rope's schema migrations: numbered SQL files (001-name.sql) in ./migrations. The last one
// applied is recorded in its own table, velvet_rope_schema, so the app's migrations (and
// PRAGMA user_version, if it uses that) stay its own.
//
// A new app runs migrate(db) before its own migrations, so its tables can reference groups(id).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS velvet_rope_schema (version INTEGER NOT NULL)');
  const current = db.prepare('SELECT MAX(version) FROM velvet_rope_schema').pluck().get() ?? 0;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('DELETE FROM velvet_rope_schema').run();
      db.prepare('INSERT INTO velvet_rope_schema (version) VALUES (?)').run(version);
    })();
  }
}
