# Pretpark — notes for future sessions

Live at https://pretpark.pieterverlinden.be (unlisted, noindex). A family day planner for Walibi Belgium, built for
one family's visit (2 adults, one pregnant; a child ≥140 cm; a toddler ~95 cm), but people are editable in the app.

## Spec (short)
- "Doe nu dit" ticket: the best next step, either everyone together or a split (adult + big kid on a thrill ride,
  pregnant adult + toddler on a nearby kids ride or resting), meeting at the first ride's exit.
- Walking guide: big arrow (compass-relative when the compass is on, else north-up), distance, heading-up mini-map
  with the route over OSM footpaths. Arrival < 25 m.
- Food (nearest with seating first), toilets (OSM), pause button; list of all rides with per-person rules; park map.
- Shared family state between phones via a secret family link (`?g=<id>`), plus Web Push notifications
  (favourite got short, better suggestion, meal/rest time, target ride down), sent by a cron every minute.

## Stack and layout
- Plain HTML/CSS/JS in `public/` (no build) + one Cloudflare Worker (`worker/`) with D1 and a `* * * * *` cron.
- `public/data.js` attractions (ThemeParks.wiki ids + coords, walibi.be height rules, my pregnancy guesses: `preg`)
  and restaurants (seat/meal flags are guesses). Regenerate from the scratch script if Walibi changes rides.
- `public/park.json` OSM extract (park outline, footpath graph, water, buildings, toilets) in metres around `origin`.
- `public/logic.js` planner + notification decisions (pure; imported by both browser and Worker).
- `public/family.js` the shared state and validated actions (applied server-side with optimistic concurrency).
- `public/route.js` Dijkstra over the footpath graph, lookahead point for the arrow.
- `public/app.js` UI; `public/sw.js` push display only (no offline cache).
- `worker/index.js` `/api/live` (ThemeParks.wiki, cached 60 s), `/api/family`, `/api/push`, `/api/vapid`, cron.
- `worker/push.js` Web Push (VAPID ES256 + aes128gcm) with WebCrypto, no library.

## Run, test, deploy
- `npm run dev` (needs `.dev.vars` with `VAPID_PRIVATE_JWK='<jwk json>'`; generate a P-256 ECDSA key if missing).
- `npm test` (node:test on logic + family actions).
- `npm run deploy` — first time, or when the key changes: `npx cf deploy --secrets-file .dev.vars`.
  Changing the VAPID key invalidates all existing push subscriptions.

## Data
D1 tables `families` (id, JSON state incl. last positions of each phone, done list, favourites) and `subs`
(push subscription per device + prefs + notification memo). Everything older than 7 days is deleted by the cron.
No accounts; knowing the family id is the access.

## Non-obvious decisions
- Wait times only exist for rides ThemeParks.wiki reports; a ride missing from live data is treated as closed.
- Score = family enjoyment (per person/category, watchers cost, wet rides penalised Oct–Mar, favourites ×2, done ×0.35ⁿ)
  divided by minutes (walk × 1.25 with a pregnant adult + wait + ride).
- The Worker has no path graph: it uses straight-line × 1.35 for walking times in notifications.
- `localTime` in /api/live is Brussels wall-clock written as UTC so `getHours()` works inside the Worker.
