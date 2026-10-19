import * as Cloudflare from "alchemy/Cloudflare";

/** The single D1 database holding entity types, schema versions, entities, and history. */
export const EntityDatabase = Cloudflare.D1.Database("EntityDb", { migrations: "./migrations" });
