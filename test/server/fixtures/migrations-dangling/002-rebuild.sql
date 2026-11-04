-- velvet-rope: foreign-keys-off
-- A broken rebuild: it forgets to copy one owner, so a note is left pointing at nothing.
CREATE TABLE owners_new (id TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO owners_new (id, name) SELECT id, name FROM owners WHERE id = 'o1';
DROP TABLE owners;
ALTER TABLE owners_new RENAME TO owners;
