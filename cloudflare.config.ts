import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "audiolab",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-26",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),

      DB: bindings.d1({
        name: "audiolab-dev",
        id: "11111111-1111-4111-8111-111111111111" // local-dev identifier
      }), 

      // Audio file storage.
      // Cloudflare simulates this bucket locally during development.
      AUDIO_BUCKET: bindings.r2({
        name: "audiolab-audio-dev",
      }),


    },
  }),
});
