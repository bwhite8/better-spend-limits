/**
 * Bind the mock to a port (plan §G6: `PORT`, default 8787).
 *
 * This is the ONLY module that opens a socket — tests and the web app's sync
 * suite import {@link createApp} from `./app.js` instead.
 */

import { serve } from "@hono/node-server";

import { createApp, DEFAULT_PORT } from "./app.js";

const port = Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0) {
  throw new Error(`PORT must be an integer, got "${String(process.env.PORT)}"`);
}

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`[mock-api] emulating api.anthropic.com on http://localhost:${info.port}`);
});
