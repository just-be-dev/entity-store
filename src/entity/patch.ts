import type { Json, JsonObject } from "../lens/expr.ts";
import { jsonEquals } from "../lens/expr.ts";

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const setOwn = (target: Record<string, Json>, key: string, value: Json) => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/** RFC 7386 JSON Merge Patch: objects merge recursively, `null` deletes. */
export const mergePatch = (target: Json, patch: Json): Json => {
  if (!isObject(patch)) {
    return patch;
  }
  const out: Record<string, Json> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else {
      setOwn(out, key, mergePatch(Object.hasOwn(out, key) ? (out[key] ?? null) : null, value));
    }
  }
  return out;
};

/** A change at an object path. A missing `value` removes the key. */
export interface Change {
  readonly path: ReadonlyArray<string>;
  readonly value?: Json;
}

/**
 * Structural diff between two documents. Objects are compared key by key;
 * arrays and scalars are replaced whole, because element positions don't
 * survive lens translation reliably.
 */
export const diff = (before: Json, after: Json, path: ReadonlyArray<string> = []): Array<Change> => {
  if (jsonEquals(before, after)) {
    return [];
  }
  if (!isObject(before) || !isObject(after)) {
    return [{ path, value: after }];
  }
  const changes: Array<Change> = [];
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) {
      changes.push({ path: [...path, key] });
    }
  }
  for (const [key, value] of Object.entries(after)) {
    if (Object.hasOwn(before, key)) {
      changes.push(...diff(before[key] ?? null, value, [...path, key]));
    } else {
      changes.push({ path: [...path, key], value });
    }
  }
  return changes;
};

/**
 * Apply changes leniently: setting a path creates missing parent objects, and
 * removing a missing key is a no-op. The target may differ from the document
 * the diff came from, so strict JSON Patch semantics would reject good edits.
 */
export const applyChanges = (doc: Json, changes: ReadonlyArray<Change>): Json =>
  changes.reduce<Json>((acc, change) => applyChange(acc, change.path, change), doc);

const applyChange = (doc: Json, path: ReadonlyArray<string>, change: Change): Json => {
  const [head, ...rest] = path;
  if (head === undefined) {
    return change.value === undefined ? null : change.value;
  }
  const base: Record<string, Json> = isObject(doc) ? { ...doc } : {};
  if (rest.length === 0 && change.value === undefined) {
    delete base[head];
    return base;
  }
  const child = Object.hasOwn(base, head) ? (base[head] ?? null) : null;
  setOwn(base, head, applyChange(child, rest, change));
  return base;
};
