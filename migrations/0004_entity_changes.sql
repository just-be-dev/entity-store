-- Change feed and type deletion. Append new numbered migrations; never edit this file once applied.

-- One row per entity write, inserted in the same batch as the write's
-- revision, so a change is recorded if and only if the write commits. D1 runs
-- one write transaction at a time, so `seq` order is commit order: a change
-- can't commit with a lower seq than one already committed.
CREATE TABLE entity_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  rev INTEGER NOT NULL,
  op TEXT NOT NULL, -- create | replace | patch | delete
  meta TEXT, -- the writer's JSON object, or NULL
  created_at INTEGER NOT NULL
);

-- getChange(id, rev), and deleting a type's changes with its entities.
CREATE UNIQUE INDEX entity_changes_by_entity ON entity_changes (entity_id, rev);

-- Delivery cursors: every change with seq <= after_seq has been sent. The
-- flusher sends what's after the cursor, then advances it with a conditional
-- update, so a failed send is retried rather than skipped.
CREATE TABLE change_delivery (
  name TEXT PRIMARY KEY,
  after_seq INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO change_delivery (name, after_seq) VALUES ('queue', 0);

-- A type can be deleted and created again under the same name. `incarnation`
-- is random per creation, so isolates that cached the old type's schema
-- versions (which are immutable for as long as the type exists) can tell the
-- new type apart. Types created before this migration share ''.
ALTER TABLE entity_types ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';
