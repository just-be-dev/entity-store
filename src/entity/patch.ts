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

const MAX_ALIGN_CELLS = 250_000;

/**
 * Carry an old writer's edit onto the stored document.
 *
 * `base` and `mine` are the writer's before and after documents, both lensed
 * up to the stored version; `stored` is what's actually stored. The writer
 * only changed what differs between `base` and `mine`, so everything else,
 * including fields its version can't see, comes from `stored`.
 *
 * Objects merge key by key. Arrays are aligned element by element (longest
 * common subsequence on `base` vs `mine`), so unchanged elements keep their
 * stored form, edited elements merge recursively, and inserted elements come
 * from `mine`. `base` must be `stored` lensed down and back up, so an array
 * in `base` lines up index for index with the one in `stored`; if it doesn't,
 * the writer's array wins outright.
 */
export const merge3 = (base: Json, mine: Json, stored: Json): Json => {
  if (jsonEquals(base, mine)) {
    return stored;
  }
  if (isObject(base) && isObject(mine) && isObject(stored)) {
    const out: Record<string, Json> = { ...stored };
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(mine, key)) {
        delete out[key];
      }
    }
    for (const [key, value] of Object.entries(mine)) {
      const merged = Object.hasOwn(base, key)
        ? merge3(
            base[key] ?? null,
            value,
            Object.hasOwn(stored, key) ? (stored[key] ?? null) : value,
          )
        : value;
      setOwn(out, key, merged);
    }
    return out;
  }
  if (
    Array.isArray(base) &&
    Array.isArray(mine) &&
    Array.isArray(stored) &&
    base.length === stored.length
  ) {
    return mergeArrays(base, mine, stored);
  }
  return mine;
};

const mergeArrays = (
  base: ReadonlyArray<Json>,
  mine: ReadonlyArray<Json>,
  stored: ReadonlyArray<Json>,
): Json => {
  if (base.length * mine.length > MAX_ALIGN_CELLS) {
    return base.length === mine.length
      ? mine.map((item, i) => merge3(base[i] ?? null, item, stored[i] ?? null))
      : [...mine];
  }
  // Longest common subsequence of equal elements.
  const rows = base.length + 1;
  const cols = mine.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = mine.length - 1; j >= 0; j--) {
      table[i * cols + j] = jsonEquals(base[i], mine[j])
        ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const out: Array<Json> = [];
  let i = 0;
  let j = 0;
  // Elements between matches: pair them up as edits, then extras are inserts.
  const flushGap = (baseEnd: number, mineEnd: number) => {
    const paired = Math.min(baseEnd - i, mineEnd - j);
    for (let n = 0; n < paired; n++) {
      out.push(merge3(base[i + n] ?? null, mine[j + n] ?? null, stored[i + n] ?? null));
    }
    for (let n = j + paired; n < mineEnd; n++) {
      out.push(mine[n] ?? null);
    }
    i = baseEnd;
    j = mineEnd;
  };
  let bi = 0;
  let mj = 0;
  while (bi < base.length && mj < mine.length) {
    if (jsonEquals(base[bi], mine[mj])) {
      flushGap(bi, mj);
      out.push(stored[bi] ?? null);
      bi++;
      mj++;
      i = bi;
      j = mj;
    } else if ((table[(bi + 1) * cols + mj] ?? 0) >= (table[bi * cols + mj + 1] ?? 0)) {
      bi++;
    } else {
      mj++;
    }
  }
  flushGap(base.length, mine.length);
  return out;
};
