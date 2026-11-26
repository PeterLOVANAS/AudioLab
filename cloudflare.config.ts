import { bindings, defineConfig, defineWorker } from "cf/config";
import { deploymentEnvironment } from "./lib/config/deployment.ts";

const deployment = deploymentEnvironment(process.env);

export default defineConfig({
  worker: defineWorker({
    name: deployment.deployed ? deployment.worker : "audiolab",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-26",
    compatibilityFlags: ["nodejs_compat"],
    // Only the explicitly gated staging mode exposes the canonical workers.dev
    // route. Preview/version aliases are not added to the API's allowed origin.
    workersDev: deployment.deployed && deployment.workersDev,
    previewUrls: false,
    ...(deployment.deployed && deployment.hostMode === "custom-domain"
      ? { domains: [deployment.hostname] }
      : {}),
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      AUTH_MODE: bindings.text(deployment.auth.AUTH_MODE),
      ACCESS_TEAM_DOMAIN: bindings.text(deployment.auth.ACCESS_TEAM_DOMAIN),
      ACCESS_AUDIENCE: bindings.text(deployment.auth.ACCESS_AUDIENCE),
      APP_ORIGIN: bindings.text(deployment.auth.APP_ORIGIN),
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),

      DB: bindings.d1({
        name: "audiolab-dev",
        id: "11111111-1111-4111-8111-111111111111", // local-dev identifier
      }),

      // Audio file storage.
      // Cloudflare simulates this bucket locally during development.
      AUDIO_BUCKET: bindings.r2({
        name: "audiolab-audio-dev",
      }),
      // Exact per-environment resources override local placeholders only after
      // validation. Keep the literal local DB declaration for init_local.py.
      ...(deployment.deployed
        ? {
            DB: bindings.d1({
              name: deployment.databaseName,
              id: deployment.database,
            }),
            AUDIO_BUCKET: bindings.r2({ name: deployment.bucket }),
          }
        : {}),
    },
  }),
});
