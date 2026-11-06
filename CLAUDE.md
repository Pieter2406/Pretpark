# Pretpark — notes for future sessions

Live at https://pretpark.pieterverlinden.be, behind Cloudflare Access (e-mail one-time code) for
pieter.verlinden@outlook.com and marjan.vandenabeele@gmail.com only; noindex. A family day planner for Walibi Belgium, built for
one family's visit (2 adults, one pregnant; a child ≥140 cm; a toddler ~95 cm), but people are editable in the app.

## Spec (short)
- "Doe nu dit" ticket: the best next step, either everyone together or a split (adult + big kid on a thrill ride,
  pregnant adult + toddler on a nearby kids ride or resting), meeting at the first ride's exit.
- Walking guide: big arrow (compass-relative when the compass is on, else north-up), distance, heading-up mini-map
  with the route over OSM footpaths. Arrival < 25 m.
- Food (nearest with seating first), toilets (OSM), pause button; list of all rides with per-person rules; park map.
- Shared family state between phones via a secret family link (`?g=<id>`), plus Web Push notifications
  (favourite got short, better suggestion, meal/rest time, target ride down), sent by a cron every minute.

- Tickets tab: import e-ticket PDFs/screenshots; every QR/barcode becomes a ticket with a sharp crop of the code and
  a page image; full-screen white viewer for the gate. Stored in IndexedDB (works offline) and shared via D1.
- Offline: service worker pre-caches the app + park map; app.js keeps the last live data and family state in
  localStorage and queues family actions in an outbox (applied locally with family.js, replayed when online).
- Extras: car parking spot (shared, guide back), "Kind kwijt?" sheet with today's photo (local only, never uploaded),
  MET Norway weather (rain → indoor rides favoured), closing-time banner + notification.

- Album tab + 📸 button on Nu/Kaart: photos in original quality to R2 bucket `pretpark-photos` (EU jurisdiction),
  thumbnail (640 px JPEG) made on the phone; metadata (time, who = Access e-mail, place/nearest ride, ⭐) in D1 `photos`.
  Upload queue in IndexedDB `uploads` (survives no signal and reloads). "Ons dagverslag" = timeline of rides done
  (family log) and photos, starred photos large. Photos are never deleted automatically; families with photos are
  kept too (their ride log belongs to the story).

## Access (security)
- Access app "Pretpark" (id 314d5541-…, AUD in worker/access.js) on the whole host, policy "Gezin" = the two e-mails,
  IdP = one-time PIN, session 720 h. A second Access app bypasses only /manifest.webmanifest, /icon.svg and
  /apple-touch-icon.png (home-screen install fetches these without cookies).
- worker/access.js verifies the Access JWT again for every /api call (team pieterverlinden.cloudflareaccess.com).
  To add a person: add the e-mail to the Access policy (cf zero-trust access applications update) AND to ALLOWED.
- Local dev skips the check only for plain-http loopback requests without cf-ray.
- An expired session makes /api return a redirect; app.js shows "Opnieuw inloggen".

## Stack and layout
- Plain HTML/CSS/JS in `public/` (no build) + one Cloudflare Worker (`worker/`) with D1 and a `* * * * *` cron.
- `public/data.js` attractions (ThemeParks.wiki ids + coords, walibi.be height rules, my pregnancy guesses: `preg`)
  and restaurants (seat/meal flags are guesses). Regenerate from the scratch script if Walibi changes rides.
- `public/park.json` OSM extract (park outline, footpath graph, water, buildings, toilets) in metres around `origin`.
- `public/logic.js` planner + notification decisions (pure; imported by both browser and Worker).
- `public/family.js` the shared state and validated actions (applied server-side with optimistic concurrency).
- `public/route.js` Dijkstra over the footpath graph, lookahead point for the arrow.
- `public/app.js` UI; `public/sw.js` offline cache + push. **Bump `VERSION` in sw.js on every deploy** that changes
  files in public/, so phones switch to the new set of files together.
- `public/tickets.js` import (lazy-loads `public/vendor/`: pdf.js 4.10.38, zxing-wasm 1.3.4 reader); `public/idb.js`.
- `worker/index.js` `/api/live` (ThemeParks.wiki, cached 60 s), `/api/family`, `/api/push`, `/api/vapid`, cron.
- `worker/push.js` Web Push (VAPID ES256 + aes128gcm) with WebCrypto, no library.
- `worker/access.js` Access JWT check. `/api/photos/<family>[/<id>[/thumb|full]]` GET list/file (?dl=1 download),
  POST multipart (full, thumb, meta), PATCH {star, caption}, DELETE. `/api/tickets/<family>[/<id>]` GET/POST/PATCH/DELETE (max 20, ≤1.9 MB each).

## Run, test, deploy
- `npm run dev` (needs `.dev.vars` with `VAPID_PRIVATE_JWK='<jwk json>'`; generate a P-256 ECDSA key if missing).
- `npm test` (node:test on logic + family actions).
- D1 database `pretpark-eu` (EU jurisdiction), bound by name in cloudflare.config.ts.
- `npm run deploy`. Secrets persist; to (re)upload the VAPID key: `npx cf deploy --secrets-file .secrets`
  (`.secrets` and `.dev.vars` are git-ignored and hold the same key).
  Changing the VAPID key invalidates all existing push subscriptions.

## Data
D1 tables `tickets` (code crop + page image per ticket), `families` (id, JSON state incl. last positions of each phone, done list, favourites) and `subs`
(push subscription per device + prefs + notification memo). Everything older than 7 days is deleted by the cron.
No accounts; knowing the family id is the access.

## Non-obvious decisions
- Wait times only exist for rides ThemeParks.wiki reports; a ride missing from live data is treated as closed.
- Score = family enjoyment (per person/category, watchers cost, wet rides penalised Oct–Mar, favourites ×2, done ×0.35ⁿ)
  divided by minutes (walk × 1.25 with a pregnant adult + wait + ride).
- The Worker has no path graph: it uses straight-line × 1.35 for walking times in notifications.
- `localTime` in /api/live is Brussels wall-clock written as UTC so `getHours()` works inside the Worker.
