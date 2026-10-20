-- Secondary indexes. Append new numbered migrations; never edit this file once applied.

-- Bumped whenever the set of indexes a writer must maintain changes (an index
-- is created, fails, or is dropped). Every entity write checks it through
-- `index_guard`, so a writer can't commit using index definitions that changed
-- after it read them.
ALTER TABLE entity_types ADD COLUMN indexes_rev INTEGER NOT NULL DEFAULT 0;

-- Index definitions. An index is pinned to one schema version: keys are
-- computed from each entity's data lensed to `version`, which never changes
-- because versions and lenses are immutable. `generation` is the type's
-- indexes_rev when the index was created, so work for a dropped index can't
-- touch a later index with the same name.
CREATE TABLE entity_indexes (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  is_unique INTEGER NOT NULL,
  state TEXT NOT NULL, -- building | ready | failed
  cursor TEXT NOT NULL DEFAULT '', -- backfill progress: last entity id indexed
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (type, name)
) WITHOUT ROWID;

-- One row per (index, key, entity). Lookups are a range scan on the primary
-- key. Maintained in the same batch as the entity write, only for keys that
-- changed. Unique indexes are enforced by the partial index below, so two
-- racing writers can't both claim a key.
CREATE TABLE index_entries (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  uniq INTEGER NOT NULL,
  PRIMARY KEY (type, name, value, entity_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX index_entries_unique ON index_entries (type, name, value) WHERE uniq = 1;

-- Never holds rows. Inserting (type, indexes_rev) into it is a no-op when the
-- type's indexes_rev still matches and aborts the whole batch otherwise.
CREATE TABLE index_guard (
  type TEXT NOT NULL,
  indexes_rev INTEGER NOT NULL
);

CREATE TRIGGER index_guard_check
BEFORE INSERT ON index_guard
BEGIN
  SELECT CASE
    WHEN NEW.indexes_rev IS (SELECT indexes_rev FROM entity_types WHERE name = NEW.type)
      THEN RAISE(IGNORE)
    ELSE RAISE(ABORT, 'INDEXES_CHANGED')
  END;
END;
