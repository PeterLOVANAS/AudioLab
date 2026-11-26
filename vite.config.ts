import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

export default defineConfig({
  plugins: [
    vinext({
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      // Optional isolated local demo/test state. Normal development retains the
      // precious default .cloudflare/state; this never enables remote bindings.
      ...(process.env.AUDIOLAB_LOCAL_STATE ? {persistState:{path:process.env.AUDIOLAB_LOCAL_STATE},inspectorPort:false as const} : {}),
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
