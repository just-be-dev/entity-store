import * as Option from "effect/Option";
import type { Entity, IndexInfo, LensReport, Revision, TypeInfo } from "./entityStore.ts";
import { ApiFailure } from "./entityStore.ts";

export const personV1Schema = {
  fields: {
    firstName: { type: "string", minLength: 1 },
    lastName: { type: "string", minLength: 1 },
    nickname: { type: "string", optional: true },
  },
};

export const personV2Schema = {
  fields: {
    fullName: { type: "string" },
    age: { type: "number", integer: true, optional: true },
  },
};

export const personLens = {
  ops: [
    {
      op: "derive",
      forward: { fullName: "firstName + ' ' + lastName" },
      backward: { firstName: "split(fullName, ' ')[0]", lastName: "split(fullName, ' ')[1]" },
    },
  ],
};

export const personType: TypeInfo = {
  name: "person",
  description: "People we know",
  latestVersion: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  versions: [
    {
      type: "person",
      version: 1,
      schema: personV1Schema,
      lens: Option.none(),
      note: "",
      createdAt: 1_700_000_000_000,
    },
    {
      type: "person",
      version: 2,
      schema: personV2Schema,
      lens: Option.some(personLens),
      note: "Merge names",
      createdAt: 1_700_000_100_000,
    },
  ],
};

export const ada = (overrides: Partial<Entity> = {}): Entity => ({
  id: "ada",
  type: "person",
  version: 2,
  storedVersion: 1,
  rev: 3,
  data: { fullName: "Ada Lovelace" },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_200_000,
  ...overrides,
});

export const revision = (rev: number, op: Revision["op"]): Revision => ({
  rev,
  op,
  version: 2,
  storedVersion: 1,
  writerVersion: 1,
  data: { fullName: `Ada rev ${rev}` },
  createdAt: 1_700_000_000_000 + rev,
});

export const apiFailure = (
  status: number,
  code: string,
  error: string,
  extra: Partial<ApiFailure> = {},
): ApiFailure =>
  ApiFailure.make({
    status,
    error,
    code: Option.some(code),
    issues: [],
    report: Option.none(),
    currentRev: Option.none(),
    problems: [],
    linkedFrom: [],
    conflicts: [],
    ...extra,
  });

export const failingReport: LensReport = {
  ok: false,
  forward: {
    checked: 100,
    failures: [
      {
        input: { firstName: "A", lastName: "B" },
        output: Option.some({ fullName: "A B" }),
        error: 'Missing key at ["tags"]',
      },
    ],
  },
  backward: { checked: 100, failures: [] },
  existing: { checked: 1, failures: [] },
  roundTrip: {
    checked: 100,
    lossy: 2,
    example: Option.some({
      input: { firstName: "A", lastName: "B C" },
      forward: { fullName: "A B C" },
      back: { firstName: "A", lastName: "B" },
    }),
  },
  examples: [{ input: { firstName: "Ada", lastName: "L" }, output: { fullName: "Ada L" } }],
  warnings: ["2 of 100 sampled documents don't round-trip"],
};

export const passingReport: LensReport = {
  ...failingReport,
  ok: true,
  forward: { checked: 100, failures: [] },
};

export const postSchema = {
  fields: {
    title: { type: "string" },
    author: { type: "link", to: "person" },
    reviewers: { type: "array", items: { type: "link", to: "person" } },
  },
};

export const postType: TypeInfo = {
  name: "post",
  description: "",
  latestVersion: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  versions: [
    {
      type: "post",
      version: 1,
      schema: postSchema,
      lens: Option.none(),
      note: "",
      createdAt: 1_700_000_000_000,
    },
  ],
};

export const post = (overrides: Partial<Entity> = {}): Entity => ({
  id: "p1",
  type: "post",
  version: 1,
  storedVersion: 1,
  rev: 1,
  data: { title: "Notes", author: "ada", reviewers: ["alan"] },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

export const emailIndex = (overrides: Partial<IndexInfo> = {}): IndexInfo => ({
  type: "person",
  name: "email",
  version: 2,
  key: "lower(email)",
  unique: true,
  state: "ready",
  error: Option.none(),
  createdAt: 1_700_000_300_000,
  updatedAt: 1_700_000_300_000,
  ...overrides,
});
