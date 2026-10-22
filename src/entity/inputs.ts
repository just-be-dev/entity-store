import * as Schema from "effect/Schema";
import { Lens } from "../lens/model.ts";
import { EntitySchema, TypeName, Version } from "../schema/model.ts";
import { ChangeMeta, EntityId, Rev } from "./model.ts";

/** Write and authoring inputs, decoded the same way from HTTP bodies and RPC arguments. */

const Note = Schema.String.check(Schema.isMaxLength(2000));

export const CreateTypeBody = Schema.Struct({
  name: TypeName,
  description: Schema.optionalKey(Note),
  schema: EntitySchema,
});

export const CheckVersionBody = Schema.Struct({
  schema: EntitySchema,
  lens: Lens,
  samples: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
});

export const AddVersionBody = Schema.Struct({
  schema: EntitySchema,
  lens: Lens,
  note: Schema.optionalKey(Note),
  force: Schema.optionalKey(Schema.Boolean),
});

// Writes name the version they speak, or omit it to write at the latest.
export const CreateEntityBody = Schema.Struct({
  id: Schema.optionalKey(EntityId),
  version: Schema.optionalKey(Version),
  data: Schema.Json,
  meta: Schema.optionalKey(ChangeMeta),
});

export const ReplaceBody = Schema.Struct({
  version: Schema.optionalKey(Version),
  data: Schema.Json,
  expectedRev: Schema.optionalKey(Rev),
  meta: Schema.optionalKey(ChangeMeta),
});

export const PatchBody = Schema.Struct({
  version: Schema.optionalKey(Version),
  patch: Schema.Record(Schema.String, Schema.Json),
  expectedRev: Schema.optionalKey(Rev),
  meta: Schema.optionalKey(ChangeMeta),
});

/** `expectedRev: 0` means the entity must not exist (or must be deleted). */
export const UpsertBody = Schema.Struct({
  version: Schema.optionalKey(Version),
  patch: Schema.Record(Schema.String, Schema.Json),
  expectedRev: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  meta: Schema.optionalKey(ChangeMeta),
});

/** A delete's optional body; `?expectedRev` works too. */
export const DeleteBody = Schema.Struct({
  expectedRev: Schema.optionalKey(Rev),
  meta: Schema.optionalKey(ChangeMeta),
});

/** A dry run of an upsert: the same body without `expectedRev` or `meta`. */
export const CheckEntityBody = Schema.Struct({
  version: Schema.optionalKey(Version),
  patch: Schema.Record(Schema.String, Schema.Json),
});
