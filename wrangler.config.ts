import { defineWranglerConfig } from "wrangler/experimental-config";

// Everything in public/ goes online as it is; nothing else in the repo does.
export default defineWranglerConfig({
  "assetsDirectory": "public"
});
