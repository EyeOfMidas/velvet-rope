-- velvet-rope: foreign-keys-off
-- Makes owners.name NOT NULL by rebuilding the table the notes reference.
CREATE TABLE owners_new (id TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO owners_new (id, name) SELECT id, COALESCE(name, '') FROM owners;
DROP TABLE owners;
ALTER TABLE owners_new RENAME TO owners;
