-- Entity store schema. Append new numbered migrations; never edit this file once applied.

-- One row per entity type. latest_version only moves forward.
CREATE TABLE entity_types (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  latest_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Immutable schema versions. `lens` (JSON) maps version - 1 to this version; NULL for v1.
CREATE TABLE schema_versions (
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema TEXT NOT NULL,
  lens TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (type, version)
) WITHOUT ROWID;

-- Every entity of every type. `data` is JSON stored at schema `version`; `rev` counts writes.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Listing by type. Only (type, id) is indexed, and neither changes after insert,
-- so updates don't rewrite the index.
CREATE INDEX entities_by_type ON entities (type, id);

-- Append-only history: one snapshot per write, clustered by entity so reading
-- an entity's history is a single range scan.
CREATE TABLE entity_revisions (
  entity_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  version INTEGER NOT NULL,
  writer_version INTEGER NOT NULL,
  op TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, rev)
) WITHOUT ROWID;
