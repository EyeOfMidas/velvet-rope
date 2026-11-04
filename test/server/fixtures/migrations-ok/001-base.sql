CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE notes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), body TEXT);
INSERT INTO owners (id, name) VALUES ('o1', 'Ada'), ('o2', 'Bo');
INSERT INTO notes (id, owner_id, body) VALUES ('n1', 'o1', 'first'), ('n2', 'o2', 'second');
