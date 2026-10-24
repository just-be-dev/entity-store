import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { apiRoutes } from "../api.ts";
import { AutomationsDirectory, NOT_CONNECTED } from "../consumers/directory.ts";
import { directoryOverMcp } from "../consumers/mcp.ts";
import type { McpTransport } from "../consumers/mcp.ts";
import { testAppLayer } from "../testing/app.ts";

/** A client for the API, with automations answering through `automations` (unavailable by default). */
const clientWith = (automations?: AutomationsDirectory["Service"]) =>
  Effect.gen(function* () {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          apiRoutes.pipe(Layer.provideMerge(testAppLayer(undefined, undefined, automations))),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    return (method: string, path: string, body?: unknown | string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://app${path}`, {
            method,
            ...(body === undefined
              ? {}
              : {
                  body: typeof body === "string" ? body : JSON.stringify(body),
                  headers: { "content-type": "application/json" },
                }),
          }),
        );
        return { status: response.status, body: (await response.json()) as any };
      });
  });

const makeClient = clientWith();

const personSchema = {
  fields: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
  },
};

describe("entity HTTP API", () => {
  it.effect("drives the whole lifecycle over HTTP", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;

      const created = yield* call("POST", "/api/types", {
        name: "person",
        description: "People",
        schema: personSchema,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "person", latestVersion: 1 });

      const ada = yield* call("POST", "/api/types/person/entities", {
        id: "ada",
        version: 1,
        data: { name: "Ada", email: "ada@example.com" },
      });
      expect(ada.status).toBe(201);
      expect(ada.body).toMatchObject({ id: "ada", rev: 1, version: 1 });

      // A new version renames name → displayName and adds an optional field.
      const v2 = {
        schema: {
          fields: {
            displayName: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            nickname: { type: "string", optional: true },
          },
        },
        lens: {
          ops: [
            { op: "rename", from: "name", to: "displayName" },
            { op: "add", field: "nickname" },
          ],
        },
      };
      const check = yield* call("POST", "/api/types/person/versions/check", v2);
      expect(check.status).toBe(200);
      expect(check.body).toMatchObject({ from: 1, to: 2, report: { ok: true } });
      const added = yield* call("POST", "/api/types/person/versions", { ...v2, note: "rename" });
      expect(added.status).toBe(201);
      expect(added.body.version).toMatchObject({ version: 2, note: "rename" });

      const latest = yield* call("GET", "/api/entities/ada");
      expect(latest.body).toMatchObject({
        version: 2,
        storedVersion: 1,
        data: { displayName: "Ada", email: "ada@example.com" },
      });
      const asV1 = yield* call("GET", "/api/entities/ada?version=1");
      expect(asV1.body.data).toEqual({ name: "Ada", email: "ada@example.com" });

      const patched = yield* call("PATCH", "/api/entities/ada", {
        version: 2,
        patch: { nickname: "Countess" },
        expectedRev: 1,
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ rev: 2, storedVersion: 2 });

      const stale = yield* call("PUT", "/api/entities/ada", {
        version: 1,
        data: { name: "Ada L", email: "ada@example.com" },
        expectedRev: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "RevConflict", currentRev: 2 });

      // An old (v1) writer edits; the v2-only nickname survives.
      const oldWriter = yield* call("PUT", "/api/entities/ada", {
        version: 1,
        data: { name: "Ada L", email: "ada@example.com" },
      });
      expect(oldWriter.status).toBe(200);
      expect((yield* call("GET", "/api/entities/ada")).body.data).toEqual({
        displayName: "Ada L",
        email: "ada@example.com",
        nickname: "Countess",
      });

      const list = yield* call("GET", "/api/types/person/entities?version=1&limit=10");
      expect(list.body.items.map((e: { id: string }) => e.id)).toEqual(["ada"]);

      const history = yield* call("GET", "/api/entities/ada/history?version=1");
      expect(history.body.items.map((r: { op: string }) => r.op)).toEqual([
        "replace",
        "patch",
        "create",
      ]);
      expect(history.body.items[2].data).toEqual({ name: "Ada", email: "ada@example.com" });

      const version = yield* call("GET", "/api/types/person/versions/2");
      expect(version.body.jsonSchema).toBeDefined();

      const deleted = yield* call("DELETE", "/api/entities/ada?expectedRev=3");
      expect(deleted.body).toEqual({ id: "ada", rev: 4 });
      const gone = yield* call("GET", "/api/entities/ada");
      expect(gone.status).toBe(410);
      expect(gone.body).toMatchObject({ code: "EntityDeleted", rev: 4 });
    }),
  );

  it.effect("returns structured errors for bad input", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      expect((yield* call("POST", "/api/types", "{nope")).status).toBe(400);
      const badName = yield* call("POST", "/api/types", { name: "1bad", schema: personSchema });
      expect(badName.status).toBe(400);
      expect(badName.body.code).toBe("BadRequest");

      const invalid = yield* call("POST", "/api/types", {
        name: "thing",
        schema: { fields: { x: { type: "number", min: 5, max: 1 } } },
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.issues).toEqual([{ path: "x", message: "min is greater than max" }]);

      expect((yield* call("GET", "/api/types/nope")).body.code).toBe("TypeNotFound");
      expect((yield* call("GET", "/api/entities/nope")).status).toBe(404);
      expect((yield* call("GET", "/api/entities/x?version=abc")).status).toBe(400);
      const deep = yield* call(
        "POST",
        "/api/types",
        `{"name":"x","schema":${"[".repeat(100_000)}${"]".repeat(100_000)}}`,
      );
      expect(deep.status).toBe(400);
      expect(deep.body.error).toMatch(/nest/);

      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      const badVersion = yield* call("POST", "/api/types/person/entities", {
        version: 0,
        data: { name: "A", email: "a@b.co" },
      });
      expect(badVersion.status).toBe(400);
      const wrongData = yield* call("POST", "/api/types/person/entities", {
        version: 1,
        data: { name: "A", email: "not-an-email" },
      });
      expect(wrongData.status).toBe(422);
      expect(wrongData.body.code).toBe("ValidationFailed");

      const rejected = yield* call("POST", "/api/types/person/versions", {
        schema: { fields: { other: { type: "string" } } },
        lens: { ops: [] },
      });
      expect(rejected.status).toBe(422);
      expect(rejected.body.code).toBe("LensCheckFailed");
      expect(rejected.body.report.ok).toBe(false);
    }),
  );

  it.effect("caps request bodies at 256 KB", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", {
        name: "blob",
        schema: { fields: { text: { type: "string" } } },
      });
      const justUnder = yield* call("POST", "/api/types/blob/entities", {
        version: 1,
        data: { text: "x".repeat(256 * 1024 - 100) },
      });
      expect(justUnder.status).toBe(201);
      const over = yield* call("POST", "/api/types/blob/entities", {
        version: 1,
        data: { text: "x".repeat(256 * 1024) },
      });
      expect(over.status).toBe(413);
    }),
  );

  it.effect("links: checked writes, included reads, backlinks, guarded deletes", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", {
        name: "person",
        schema: { fields: { name: { type: "string" } } },
      });
      const post = yield* call("POST", "/api/types", {
        name: "post",
        schema: {
          fields: {
            title: { type: "string" },
            author: { type: "link", to: "person" },
          },
        },
      });
      expect(post.status).toBe(201);
      const badSchema = yield* call("POST", "/api/types", {
        name: "comment",
        schema: { fields: { on: { type: "link", to: "nothing" } } },
      });
      expect(badSchema.status).toBe(422);

      yield* call("POST", "/api/types/person/entities", {
        id: "ada",
        version: 1,
        data: { name: "Ada" },
      });
      const dangling = yield* call("POST", "/api/types/post/entities", {
        version: 1,
        data: { title: "x", author: "nobody" },
      });
      expect(dangling.status).toBe(422);
      expect(dangling.body).toMatchObject({
        code: "LinkTargetInvalid",
        problems: [{ path: "author", target: "nobody" }],
      });
      yield* call("POST", "/api/types/post/entities", {
        id: "p1",
        version: 1,
        data: { title: "x", author: "ada" },
      });

      const withLinks = yield* call("GET", "/api/entities/p1?include=links");
      expect(withLinks.body.included.ada).toMatchObject({ type: "person", data: { name: "Ada" } });
      const listed = yield* call("GET", "/api/types/post/entities?include=links");
      expect(Object.keys(listed.body.included)).toEqual(["ada"]);
      expect((yield* call("GET", "/api/entities/p1?include=everything")).status).toBe(400);

      const back = yield* call("GET", "/api/entities/ada/backlinks");
      expect(back.body).toEqual({ items: [{ source: "p1", type: "post", path: "author" }] });

      const refused = yield* call("DELETE", "/api/entities/ada");
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "EntityLinked", linkedFrom: [{ source: "p1" }] });
      expect((yield* call("DELETE", "/api/entities/p1")).status).toBe(200);
      expect((yield* call("DELETE", "/api/entities/ada")).status).toBe(200);
    }),
  );

  it.effect("defines indexes and looks entities up by key", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      yield* call("POST", "/api/types/person/entities", {
        id: "ada",
        version: 1,
        data: { name: "Ada", email: "Ada@example.com" },
      });

      const index = yield* call("POST", "/api/types/person/indexes", {
        name: "email",
        version: 1,
        key: "lower(email)",
        unique: true,
      });
      expect(index.status).toBe(201);
      expect(index.body).toMatchObject({ name: "email", state: "ready", unique: true });
      expect((yield* call("GET", "/api/types/person/indexes")).body.items).toHaveLength(1);
      expect((yield* call("GET", "/api/types/person/indexes/email")).body.state).toBe("ready");

      const found = yield* call(
        "GET",
        "/api/types/person/entities?index=email&eq=ada%40example.com",
      );
      expect(found.status).toBe(200);
      expect(found.body.items.map((e: { id: string }) => e.id)).toEqual(["ada"]);
      const none = yield* call("GET", "/api/types/person/entities?index=email&eq=");
      expect(none.body.items).toEqual([]);

      const taken = yield* call("POST", "/api/types/person/entities", {
        version: 1,
        data: { name: "Eve", email: "ADA@example.com" },
      });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({
        code: "UniqueViolation",
        conflicts: [{ index: "email", key: "ada@example.com", id: "ada" }],
      });

      const bad = yield* call("POST", "/api/types/person/indexes", {
        name: "bad",
        version: 1,
        key: "lower(mail)",
      });
      expect(bad.status).toBe(422);
      expect(bad.body).toMatchObject({ code: "InvalidIndex", issues: [{ path: "key" }] });
      expect((yield* call("GET", "/api/types/person/entities?eq=x")).status).toBe(400);
      const missing = yield* call("GET", "/api/types/person/entities?index=nope&eq=x");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("IndexNotFound");

      expect((yield* call("POST", "/api/types/person/indexes/email/build")).body.state).toBe(
        "ready",
      );
      expect((yield* call("DELETE", "/api/types/person/indexes/email")).status).toBe(200);
      expect((yield* call("GET", "/api/types/person/indexes/email")).status).toBe(404);
    }),
  );

  it.effect("runs lenses and lists functions for authoring", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      const run = yield* call("POST", "/api/lens/run", {
        lens: { ops: [{ op: "derive", forward: { n: "n * 2" }, backward: { n: "n / 2" } }] },
        direction: "backward",
        doc: { n: 10 },
      });
      expect(run.body).toEqual({ ok: true, output: { n: 5 } });
      const broken = yield* call("POST", "/api/lens/run", {
        lens: { ops: [{ op: "derive", forward: { n: "n *" }, backward: {} }] },
        direction: "forward",
        doc: {},
      });
      expect(broken.body.ok).toBe(false);
      expect(broken.body.issues[0].path).toBe("ops[0].forward.n");
      const fns = yield* call("GET", "/api/lens/functions");
      expect(fns.body.items.map((f: { name: string }) => f.name)).toContain("split");
    }),
  );

  it.effect("upserts by type and id, with meta, and lists changes", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      const id = "ada.lovelace@example.com";
      const path = `/api/types/person/entities/${encodeURIComponent(id)}`;

      const created = yield* call("PUT", path, {
        patch: { name: "Ada", email: "a@b.co" },
        expectedRev: 0,
        meta: { depth: 1, changeId: "c1" },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ created: true, entity: { id, rev: 1, version: 1 } });

      const patched = yield* call("PUT", path, { patch: { name: "Ada L." }, expectedRev: 1 });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ created: false, entity: { rev: 2 } });
      const stale = yield* call("PUT", path, { patch: { name: "x" }, expectedRev: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "RevConflict", currentRev: 2 });
      expect((yield* call("GET", `/api/entities/${encodeURIComponent(id)}`)).body.data).toEqual({
        name: "Ada L.",
        email: "a@b.co",
      });

      yield* call("POST", "/api/types", {
        name: "note",
        schema: { fields: { text: { type: "string" } } },
      });
      const mismatch = yield* call("PUT", `/api/types/note/entities/${encodeURIComponent(id)}`, {
        patch: { text: "x" },
      });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body).toMatchObject({
        code: "EntityTypeMismatch",
        id,
        type: "note",
        actual: "person",
      });

      // Deletes take meta (and expectedRev) in an optional body.
      const deleted = yield* call("DELETE", `/api/entities/${encodeURIComponent(id)}`, {
        expectedRev: 2,
        meta: { depth: 2 },
      });
      expect(deleted.body).toEqual({ id, rev: 3 });

      const changes = yield* call("GET", "/api/changes?after=0&limit=2");
      expect(changes.status).toBe(200);
      expect(changes.body.items).toEqual([
        {
          v: 1,
          seq: 1,
          type: "person",
          id,
          rev: 1,
          op: "create",
          meta: { depth: 1, changeId: "c1" },
          createdAt: expect.any(Number),
        },
        {
          v: 1,
          seq: 2,
          type: "person",
          id,
          rev: 2,
          op: "patch",
          meta: null,
          createdAt: expect.any(Number),
        },
      ]);
      expect(changes.body.nextAfter).toBe(2);
      const rest = yield* call("GET", "/api/changes?after=2");
      expect(rest.body.items.map((c: { op: string; meta: unknown }) => [c.op, c.meta])).toEqual([
        ["delete", { depth: 2 }],
      ]);
      expect((yield* call("GET", "/api/changes?after=-1")).status).toBe(400);

      // `.` and `..` can't be addressed in a path, so they aren't ids.
      const dots = yield* call("POST", "/api/types/person/entities", {
        id: "...",
        data: { name: "A", email: "a@b.co" },
      });
      expect(dots.status).toBe(400);

      const tooBig = yield* call("PUT", path, {
        patch: { name: "x" },
        meta: { pad: "x".repeat(1100) },
      });
      expect(tooBig.status).toBe(400);
      const notObject = yield* call("PATCH", `/api/entities/${encodeURIComponent(id)}`, {
        patch: {},
        meta: [1],
      });
      expect(notObject.status).toBe(400);
    }),
  );

  it.effect("deletes unused types and refuses ones in use", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      yield* call("POST", "/api/types/person/entities", {
        id: "ada",
        data: { name: "Ada", email: "a@b.co" },
      });
      const inUse = yield* call("DELETE", "/api/types/person");
      expect(inUse.status).toBe(409);
      expect(inUse.body).toMatchObject({
        code: "TypeInUse",
        type: "person",
        reasons: ["it has 1 live entity"],
      });
      yield* call("DELETE", "/api/entities/ada");
      expect((yield* call("DELETE", "/api/types/person")).body).toEqual({ name: "person" });
      expect((yield* call("GET", "/api/types/person")).status).toBe(404);
      expect((yield* call("DELETE", "/api/types/person")).status).toBe(404);
    }),
  );

  it.effect("takes expectedVersion on version writes and type deletes", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      const v2 = {
        schema: {
          fields: { ...personSchema.fields, nickname: { type: "string", optional: true } },
        },
        lens: { ops: [{ op: "add", field: "nickname" }] },
      };
      const checked = yield* call("POST", "/api/types/person/versions/check", {
        ...v2,
        expectedVersion: 1,
      });
      expect(checked.body).toMatchObject({ from: 1, to: 2, report: { ok: true } });
      const added = yield* call("POST", "/api/types/person/versions", {
        ...v2,
        expectedVersion: 1,
      });
      expect(added.status).toBe(201);
      expect(added.body.version.version).toBe(2);

      const conflict = {
        error: "person is at v2, not v1; reload and try again",
        code: "VersionConflict",
        type: "person",
        expected: 1,
        currentVersion: 2,
      };
      for (const path of ["/api/types/person/versions", "/api/types/person/versions/check"]) {
        const stale = yield* call("POST", path, { ...v2, expectedVersion: 1 });
        expect([path, stale.status, stale.body]).toEqual([path, 409, conflict]);
      }
      expect(
        (yield* call("POST", "/api/types/person/versions", { ...v2, expectedVersion: 0 })).status,
      ).toBe(400);

      // DELETE takes it from the query or a JSON body.
      const byQuery = yield* call("DELETE", "/api/types/person?expectedVersion=1");
      expect([byQuery.status, byQuery.body]).toEqual([409, conflict]);
      const byBody = yield* call("DELETE", "/api/types/person", { expectedVersion: 1 });
      expect([byBody.status, byBody.body]).toEqual([409, conflict]);
      expect((yield* call("DELETE", "/api/types/person?expectedVersion=x")).status).toBe(400);
      expect((yield* call("DELETE", "/api/types/person", { expectedVersion: "2" })).status).toBe(
        400,
      );
      expect((yield* call("GET", "/api/types/person")).body.latestVersion).toBe(2);
      const deleted = yield* call("DELETE", "/api/types/person", { expectedVersion: 2 });
      expect([deleted.status, deleted.body]).toEqual([200, { name: "person" }]);

      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      const viaQuery = yield* call("DELETE", "/api/types/person?expectedVersion=1");
      expect([viaQuery.status, viaQuery.body]).toEqual([200, { name: "person" }]);
    }),
  );

  it.effect("dry-runs an upsert without writing", () =>
    Effect.gen(function* () {
      const call = yield* makeClient;
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      yield* call("POST", "/api/types", {
        name: "note",
        schema: { fields: { text: { type: "string" } } },
      });
      const path = `/api/types/person/entities/${encodeURIComponent("ada@example.com")}/check`;

      const created = yield* call("POST", path, { patch: { name: "Ada", email: "a@b.co" } });
      expect(created.status).toBe(200);
      expect(created.body).toEqual({
        data: { name: "Ada", email: "a@b.co" },
        version: 1,
        created: true,
      });
      expect((yield* call("GET", "/api/entities/ada%40example.com")).status).toBe(404);
      expect((yield* call("GET", "/api/changes")).body.items).toEqual([]);

      yield* call("PUT", "/api/types/person/entities/ada%40example.com", {
        patch: { name: "Ada", email: "a@b.co" },
      });
      const patched = yield* call("POST", path, { patch: { name: "Ada L." } });
      expect(patched.body).toEqual({
        data: { name: "Ada L.", email: "a@b.co" },
        version: 1,
        created: false,
      });
      expect((yield* call("GET", "/api/entities/ada%40example.com")).body.rev).toBe(1);

      const invalid = yield* call("POST", path, { patch: { email: "nope" } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe("ValidationFailed");
      const mismatch = yield* call("POST", "/api/types/note/entities/ada%40example.com/check", {
        patch: { text: "x" },
      });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body).toMatchObject({ code: "EntityTypeMismatch", actual: "person" });
      expect(
        (yield* call("POST", "/api/types/person/entities/a%20b/check", { patch: {} })).status,
      ).toBe(400);
      expect((yield* call("POST", path, { patch: [] })).status).toBe(400);
    }),
  );

  it.effect("lists a type's consumers, and says when automations can't be asked", () =>
    Effect.gen(function* () {
      const call = yield* clientWith(
        directoryOverMcp(automationsAnswering(automations, templates)),
      );
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      const consumers = yield* call("GET", "/api/types/person/consumers");
      expect(consumers.status).toBe(200);
      expect(consumers.body).toEqual({
        type: "person",
        automations: {
          status: "checked",
          watching: [
            {
              id: "onboarding",
              name: "Onboarding",
              trigger: { kind: "entity", fields: ["start"], hasCondition: true },
            },
            { id: "payroll", name: "Payroll", trigger: { kind: "schedule", hasCondition: false } },
          ],
          listening: [
            {
              id: "audit",
              name: "Audit",
              trigger: { kind: "event", event: "entity.deleted", hasCondition: false },
            },
          ],
          templateSlots: [{ template: "welcome", label: "Welcome email", slot: "hire" }],
          unchecked: [{ id: "stuck", name: "Stuck", error: "It didn't answer" }],
        },
      });
      expect((yield* call("GET", "/api/types/nope/consumers")).status).toBe(404);

      const offline = yield* makeClient;
      yield* offline("POST", "/api/types", { name: "person", schema: personSchema });
      const unavailable = yield* offline("GET", "/api/types/person/consumers");
      expect([unavailable.status, unavailable.body]).toEqual([
        200,
        { type: "person", automations: { status: "unavailable", reason: NOT_CONNECTED } },
      ]);
      const failing = yield* clientWith(
        directoryOverMcp({ send: () => Effect.succeed({ status: 500, body: undefined }) }),
      );
      yield* failing("POST", "/api/types", { name: "person", schema: personSchema });
      expect((yield* failing("GET", "/api/types/person/consumers")).body.automations).toEqual({
        status: "unavailable",
        reason: "automations answered list_automations with status 500",
      });
    }),
  );

  it.effect("refuses to delete a type automations or template slots use", () =>
    Effect.gen(function* () {
      const byWatchers = yield* clientWith(directoryOverMcp(automationsAnswering(automations, [])));
      yield* byWatchers("POST", "/api/types", { name: "person", schema: personSchema });
      const watched = yield* byWatchers("DELETE", "/api/types/person");
      expect([watched.status, watched.body]).toEqual([
        409,
        {
          error:
            "Entity type 'person' is in use: automations use it: onboarding (Onboarding), payroll (Payroll)",
          code: "TypeInUse",
          type: "person",
          reasons: ["automations use it: onboarding (Onboarding), payroll (Payroll)"],
        },
      ]);

      const bySlots = yield* clientWith(directoryOverMcp(automationsAnswering([], templates)));
      yield* bySlots("POST", "/api/types", { name: "person", schema: personSchema });
      yield* bySlots("POST", "/api/types/person/entities", {
        id: "ada",
        data: { name: "Ada", email: "a@b.co" },
      });
      const slotted = yield* bySlots("DELETE", "/api/types/person?expectedVersion=1");
      expect(slotted.status).toBe(409);
      expect(slotted.body.reasons).toEqual([
        "it has 1 live entity",
        "template slots point to it: welcome.hire",
      ]);
      yield* bySlots("DELETE", "/api/entities/ada");
      expect((yield* bySlots("DELETE", "/api/types/person")).body.reasons).toEqual([
        "template slots point to it: welcome.hire",
      ]);
      expect((yield* bySlots("GET", "/api/types/person")).status).toBe(200);

      // Unused by automations, or automations unavailable: only the store decides.
      const unused = yield* clientWith(directoryOverMcp(automationsAnswering([], [])));
      yield* unused("POST", "/api/types", { name: "person", schema: personSchema });
      expect((yield* unused("DELETE", "/api/types/person")).body).toEqual({ name: "person" });
      const offline = yield* makeClient;
      yield* offline("POST", "/api/types", { name: "person", schema: personSchema });
      expect((yield* offline("DELETE", "/api/types/person")).body).toEqual({ name: "person" });
    }),
  );

  it.effect("dry-runs a type delete with every reason and the consumers", () =>
    Effect.gen(function* () {
      const call = yield* clientWith(
        directoryOverMcp(automationsAnswering(automations, templates)),
      );
      yield* call("POST", "/api/types", { name: "person", schema: personSchema });
      yield* call("POST", "/api/types", {
        name: "post",
        schema: { fields: { author: { type: "link", to: "person" } } },
      });
      const check = yield* call("POST", "/api/types/person/delete/check");
      expect(check.status).toBe(200);
      expect(check.body).toMatchObject({
        type: "person",
        latestVersion: 1,
        reasons: [
          "post's latest schema (v1) links to it",
          "automations use it: onboarding (Onboarding), payroll (Payroll)",
          "template slots point to it: welcome.hire",
        ],
        consumers: { type: "person", automations: { status: "checked" } },
      });
      expect(check.body.consumers).toEqual(
        (yield* call("GET", "/api/types/person/consumers")).body,
      );
      const withBody = yield* call("POST", "/api/types/person/delete/check", {
        expectedVersion: 1,
      });
      expect(withBody.body.reasons).toEqual(check.body.reasons);
      const stale = yield* call("POST", "/api/types/person/delete/check", { expectedVersion: 2 });
      expect([stale.status, stale.body.code, stale.body.currentVersion]).toEqual([
        409,
        "VersionConflict",
        1,
      ]);
      expect((yield* call("POST", "/api/types/person/delete/check?expectedVersion=2")).status).toBe(
        409,
      );
      expect((yield* call("POST", "/api/types/nope/delete/check")).status).toBe(404);
      // A dry run deletes nothing.
      expect((yield* call("GET", "/api/types/person")).status).toBe(200);

      const offline = yield* makeClient;
      yield* offline("POST", "/api/types", { name: "person", schema: personSchema });
      expect((yield* offline("POST", "/api/types/person/delete/check")).body).toEqual({
        type: "person",
        latestVersion: 1,
        reasons: [],
        consumers: {
          type: "person",
          automations: { status: "unavailable", reason: NOT_CONNECTED },
        },
      });
    }),
  );
});

// ── A fake automations, answering its MCP tools as its `mcp` RPC would ──

const automations = [
  {
    id: "payroll",
    name: "Payroll",
    updatedAt: 1,
    activeRuns: [],
    saved: { trigger: { kind: "schedule", cron: "0 9 1 * *", entity: "person" }, nextRunAt: 2 },
  },
  {
    id: "onboarding",
    name: "Onboarding",
    updatedAt: 1,
    activeRuns: [],
    saved: {
      trigger: {
        kind: "entity",
        entity: "person",
        fields: ["start"],
        when: { ref: "x", op: "exists" },
      },
    },
  },
  {
    id: "audit",
    name: "Audit",
    updatedAt: 1,
    activeRuns: [],
    saved: { trigger: { kind: "event", event: "entity.deleted" } },
  },
  { id: "stuck", name: "Stuck", updatedAt: 1, activeRuns: [], error: "It didn't answer" },
  { id: "draft", name: "Draft", updatedAt: 1, activeRuns: [] },
];

const templates = [
  {
    name: "welcome",
    label: "Welcome email",
    description: "For new hires",
    slots: [{ name: "hire", label: "Hire", type: "ref", to: "person" }],
    content: { body: "Hi {{hire.name}}" },
  },
];

const automationsAnswering = (
  listed: ReadonlyArray<unknown>,
  templateList: ReadonlyArray<unknown>,
): McpTransport => ({
  send: (message) =>
    Effect.sync(() => {
      const { id, params } = message as { id: number; params: { name: string } };
      const structuredContent =
        params.name === "list_automations" ? { automations: listed } : { templates: templateList };
      return {
        status: 200,
        body: { jsonrpc: "2.0", id, result: { content: [], structuredContent, isError: false } },
      };
    }),
});
