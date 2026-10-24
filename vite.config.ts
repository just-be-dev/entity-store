import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// Alchemy runs Vite for the Website Worker (`Cloudflare.Website.Foldkit` in
// src/platform/cloudflare/stack.ts) and layers its Cloudflare integration on top of this config,
// in both `alchemy dev` and `alchemy deploy`.
// NOTE: One build serves at `/` on the app's own host and under `/entities/` or
// `/entities@<stage>/` on the hub, so asset URLs are relative to the page's `<base>`
// (src/ui/basePath.ts).
export default defineConfig({
  base: "./",
  plugins: [foldkit(), tailwindcss()],
  optimizeDeps: { entries: ["src/ui/entry.ts"], include: ["effect", "effect/http"] },
  resolve: {
    alias: { "@/": fileURLToPath(new URL("./src/ui/", import.meta.url)) },
    dedupe: ["effect", "foldkit"],
  },
  server: { watch: { ignored: ["**/.alchemy/**"] } },
});
