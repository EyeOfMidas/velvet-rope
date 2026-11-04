// velvet-rope's schema migrations: numbered SQL files (001-name.sql) in ./migrations. The last one
// applied is recorded in its own table, velvet_rope_schema, so the app's migrations (and
// PRAGMA user_version, if it uses that) stay its own.
//
// A new app runs migrate(db) before its own migrations, so its tables can reference groups(id).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapDatabase } from './db/index.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// A migration that rebuilds a table other tables reference starts with this line.
const FOREIGN_KEYS_OFF = '-- velvet-rope: foreign-keys-off';

export function migrate(database) {
  applyMigrations(database, MIGRATIONS_DIR);
}

// Split out so tests can point the runner at fixture migrations. Not part of the package exports.
export function applyMigrations(database, dir) {
  const db = wrapDatabase(database);
  db.exec('CREATE TABLE IF NOT EXISTS velvet_rope_schema (version INTEGER NOT NULL)');
  const current = db.prepare('SELECT MAX(version) FROM velvet_rope_schema').pluck().get() ?? 0;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= current) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const foreignKeysOff = sql.startsWith(FOREIGN_KEYS_OFF);
    const run = db.transaction(() => {
      db.exec(sql);
      // With enforcement off, the file could have left rows pointing at nothing; refuse to commit them.
      if (foreignKeysOff && db.pragma('foreign_key_check').length > 0) {
        throw new Error(`velvet-rope: migration ${file} left dangling foreign keys`);
      }
      db.prepare('DELETE FROM velvet_rope_schema').run();
      db.prepare('INSERT INTO velvet_rope_schema (version) VALUES (?)').run(version);
    });
    if (!foreignKeysOff) {
      run();
      continue;
    }
    // The pragma does nothing inside a transaction, so it is switched before one starts and put
    // back to whatever it was afterwards, even when the migration throws.
    const wasOn = Object.values(db.pragma('foreign_keys')[0])[0] === 1;
    db.pragma('foreign_keys = OFF');
    try {
      run();
    } finally {
      db.pragma(`foreign_keys = ${wasOn ? 'ON' : 'OFF'}`);
    }
  }
}
