-- Links between entities. Append new numbered migrations; never edit this file once applied.

-- One row per (source entity, field path, target) for data stored with `link` fields.
-- Maintained in the same batch as the entity write, and only rewritten when links change.
CREATE TABLE entity_links (
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  target TEXT NOT NULL,
  target_type TEXT NOT NULL,
  PRIMARY KEY (source, path, target)
) WITHOUT ROWID;

-- Backlinks and delete checks look links up by target.
CREATE INDEX entity_links_by_target ON entity_links (target, source, path);

-- The application checks targets before writing, with readable errors. These
-- triggers close the race between that check and the batch: a link can only
-- be recorded to a live entity of the right type, and an entity can't be
-- deleted while anything links to it.
CREATE TRIGGER entity_links_target_live
BEFORE INSERT ON entity_links
WHEN NOT EXISTS (
  SELECT 1 FROM entities WHERE id = NEW.target AND type = NEW.target_type AND deleted = 0
)
BEGIN
  SELECT RAISE(ABORT, 'LINK_TARGET_INVALID');
END;

CREATE TRIGGER entities_delete_restrict
BEFORE UPDATE OF deleted ON entities
WHEN NEW.deleted = 1 AND OLD.deleted = 0
  AND EXISTS (SELECT 1 FROM entity_links WHERE target = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_LINKED');
END;
