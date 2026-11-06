import { defineConfig, bindings, triggers } from "cf/config";

// Pretpark: https://pretpark.pieterverlinden.be (unlisted: anyone with the link, not indexed).
// Static files come from public/ (wrangler.config.ts). Only /api/* runs the Worker in worker/index.js.
// A cron runs every minute to send push notifications (worker/index.js → notifyAll).
const NAME = "pretpark";

export default defineConfig({
  worker: {
    "name": NAME,
    "compatibilityDate": "2026-11-06",
    "domains": ["pretpark.pieterverlinden.be"],
    // One address only: no *.workers.dev copy and no preview URLs.
    "workersDev": false,
    "previewUrls": false,
    "observability": { "enabled": true },
    "entrypoint": "./worker/index.js",
    "assets": { "runWorkerFirst": ["/api/*"] },
    "triggers": [triggers.scheduled({ schedule: "* * * * *" })],
    "env": {
      "DB": bindings.d1({ name: "pretpark-eu" }), // EU jurisdiction
      // VAPID private key (JWK) for Web Push: locally in .dev.vars, online via `cf deploy --secrets-file .dev.vars`
      "VAPID_PRIVATE_JWK": bindings.secret(),
    },
  },
});
