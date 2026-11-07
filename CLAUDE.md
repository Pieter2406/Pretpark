# Pretpark — notes for future sessions

Live at https://pretpark.pieterverlinden.be, behind Cloudflare Access (e-mail one-time code) for
pieter.verlinden@outlook.com, marjan.vandenabeele@gmail.com and vincent-verlinden@live.com only; noindex. A family day planner for Walibi Belgium, built for
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
- Extras: car parking spot (shared, guide back), "Kind kwijt?" sheet with today's photo (local only, never uploaded)
  and one-tap call/SMS buttons for every person with a phone number (people[].phone, cleaned by phoneOf in family.js),
  MET Norway weather (rain → indoor rides favoured), closing-time banner + notification.

- Album tab + 📸 button on Nu/Kaart: photos in original quality to R2 bucket `pretpark-photos` (EU jurisdiction),
  thumbnail (640 px JPEG) made on the phone; metadata (time, who = Access e-mail, place/nearest ride, ⭐) in D1 `photos`.
  Upload queue in IndexedDB `uploads` (survives no signal and reloads). "Ons dagverslag" = timeline of rides done
  (family log) and photos, starred photos large. Photos are never deleted automatically; families with photos are
  kept too (their ride log belongs to the story).

## Access (security)
- Access app "Pretpark" (id 314d5541-…, AUD in worker/access.js) on the whole host, policy "Gezin" = the family e-mails (keep in sync with ALLOWED),
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
D1 tables `tickets` (code crop + page image per ticket), `photos` (metadata; files in R2), `families` (id, JSON state incl. last positions of each phone, done list, favourites) and `subs`
(push subscription per device + prefs + notification memo). Retention (cron): families and their tickets after
30 days without a change (families with photos are kept), subscriptions after 7 days, photos never.
No accounts; knowing the family id is the access.

## Planner tuning and simulation
- `node sim/simulate.mjs [days]` plays whole park days (synthetic crowd curve, breakdowns, rain, meals, rest) for the
  app and three baselines (nearest, shortest queue, random) and prints rides/fun/wait/km per person.
- `tests/planner.fuzz.test.js` checks the rules on 600 random situations; `tests/simulation.test.js` runs 3 days.
- `WALK_WEIGHT` in logic.js came from a sweep in the simulator; `fam.walk = 'low'` is the "Liever weinig stappen" setting.
- "Short now, long later" (`TUNE.urgency = 4`, `urgencyFactor`, `crowdCurve` in logic.js): a ride's value is scaled by how
  much shorter its queue is now than its likely queue later today (ctx.clock = park minutes; app.js and the cron via
  `parkClock`). Sim (20 days × 4 scenarios incl. curves that differ from crowdCurve): +10–13% rides per person, ~40 min
  less queueing; a plain heavier wait weight (control) gave only +3–6%. Cost: ~0.7 km more walking, pregnant adult
  −0.6 rides. Tried and rejected: one-step lookahead, "queue until closing time" (no gain).
- `sim/simulate.mjs` scenario options: crowd, rain, breakdowns, closed rides, `curve: 'default'|'early'|'flat'`.
- Meal reminders fire a little before the rush (11:30–13:30, 17:00–19:00) with "eat now, ride while others eat".
- The simulator's "plezier" uses the same enjoyment weights as the planner, so compare on rides per person, km and
  waits, not on "plezier" alone.

## v4 (review fixes)
- Family state is versioned: every /api/family response has `updated`; app.js ignores older copies (`takeFam`).
- Actions carry `aid` (server de-dupes the last 80) and `at` (client time, clamped); late offline replays can't
  overwrite a newer target/car (family.js). `fav` takes explicit `on`. New actions: `queue`, `ready` (pushes
  "✅ Wij zijn klaar" to the other phones immediately), `walk`.
- Plans are rebuilt server-side by `sanitizePlan` (family.js) before they are stored.
- Service worker = versioned app shell (cache-first, also for pages); `npm run deploy` stamps VERSION with a content
  hash (scripts/stamp-sw.mjs). `?fresh=…` bypasses it to log in again. Don't deploy during a park day.
- First start shows onboarding: new family or paste a family link (the iPhone home-screen app has its own storage).
- Guide map is built once and only transformed; compass permission is requested from the tap that opens the guide.
- GPS errors other than "denied" keep the last fix. api() times out after 7 s and counts as offline.
- Photos are only dropped from the upload queue on 'bad photo'/'photo too big'.
- Extras: stickers (done rides), photo moment after "Gedaan", partner dot on the map, morning tip, wait trends
  (last 45 min in localStorage), auto dark mode after sunset, spoken directions (speechSynthesis nl-BE), undo toasts.
- Tabs: Nu · Kaart (with Kaart/Lijst toggle) · Album · Tickets · Gezin; chat + camera buttons in the header.
- Family chat: `/api/chat/<family>` GET (?after=ms) / POST {id, kind text|loc, text, lat, lon, near, person, device};
  D1 `messages` (PK family+id, so retries are idempotent), validated in worker/rules.js `chatMessage`, pushed at once
  to the family's other phones (pref `chat`). App: header 💬 with unread badge, quick replies, "📍 Deel mijn plek"
  (the other phone gets "Breng me erheen"), send queue in localStorage `pp:chatq`, polls every 4 s while open.
  Messages are deleted after 30 days.

## v5 visuals
- Map pins: icon (or ride photo when zoomed in) in a ring coloured by wait, with a "15′" pill; closed / not-for-us
  rides are small grey dots; the current target pulses. Labels avoid pins and each other (below, else above).
  Landmarks: entrance, the big lake, the playground, the car. Food icons only when zoomed in; pins shrink when the
  whole park is shown. Map controls and legend float on the map.
- Ride photos: `public/photos.js` + `public/img/rides/*.jpg` (500 px, Wikimedia Commons, CC BY-SA/CC0/PD; author +
  licence shown on every photo and listed under Gezin). Chosen by hand: only photos that show the ride as you see
  it walking up. Missing: Tiki-Waka (rate-limited fetch), Mecalodon/Popcorn Revenge (unusable photos), Grand
  Carrousel/Tapis Volant (none found). Commons rate-limits hard: fetch with long pauses (api.wikimedia.org search,
  thumbnails only in standard sizes like 500px). Photos are cached by the service worker after first use and
  prefetched once at start.
- Photos appear on the plan card, alternatives, list, ride sheet and in the guide ("Zo ziet het eruit" within 250 m).

## v6 phone polish
- All dialogs (sheet, guide, ticket/photo viewers, story, chat, onboarding) go through openDialog/closeDialog in app.js:
  the page behind is locked (body.locked, position: fixed, scroll position restored), each dialog gets a history entry
  so the phone's back button closes it (popstate → `closers`), and focus is only moved on fine pointers (no iOS jump).
  A dialog that is already open is never registered twice.
- Bottom sheet: swipe down to close (follows the finger; closes on >30% / 140 px or a flick > 0.5 px/ms measured over
  the last 100 ms; only when scrolled to the top), ✕ button, grip, slide-in animation; the backdrop swallows touches.
- Ticket and photo viewers close with a swipe down; left/right still flips.
- Chat sizes itself to `visualViewport` (iOS keyboard); inputs are ≥16 px (no iOS zoom); `touch-action: manipulation`,
  no tap highlight, :active feedback; tap targets ≥ 44 px.

## Theme (light by day, dark after sunset)
- `sunTimes` / `isDaylight` in logic.js (standard sunrise equation for the park, ±2–5 min; tested against known times).
- `S.theme`: 'sun' (default: light between sunrise and sunset at Walibi, whatever the phone's own setting), 'light',
  'dark', 'system'. `applyTheme` sets `html[data-theme]`, color-scheme and the status-bar `theme-color`, and sets a
  timer for the exact next sunrise/sunset. All dark CSS must be written for both `@media (prefers-color-scheme: dark)
  :root:not([data-theme="light"])` and `:root[data-theme="dark"]`. An inline script in index.html applies the last
  theme before first paint (localStorage `pp:lastTheme`). The Halloween "donker" hints use the same sunset.

## Non-obvious decisions
- Wait times only exist for rides ThemeParks.wiki reports; a ride missing from live data is treated as closed.
- Score = family enjoyment (per person/category, watchers cost, wet rides penalised Oct–Mar, favourites ×2, done ×0.35ⁿ)
  divided by minutes (walk × 1.25 with a pregnant adult × WALK_WEIGHT + wait + ride).
- The Worker has no path graph: it uses straight-line × 1.35 for walking times in notifications.
- `localTime` in /api/live is Brussels wall-clock written as UTC so `getHours()` works inside the Worker.

## Parking ticket
- €13 per car (walibi.be/nl/faq). Walibi's online shop doesn't sell it: on 7 Nov 2026 the FAQ's own link
  (reservation.walibi.be/addons/WBETOCS2025PARKING) redirected to the add-on list, which had no parking product (only
  haunted houses, Speedy, NMBS, Winter). So the app links to no shop; it says "te koop aan de kassa's bij de ingang".
  If Walibi sells it online again, check that the link really opens a parking product before adding a button.
- A ticket with `person: 'car'` is the parking ticket (select "🚗 Parking", or auto-detected on import when the file
  name or code says parking/parkeer/stationnement). It sorts first in the viewer and shows "🚗 Parkeerticket".
- `parkingCard()` shows the price + booths (compact on Nu and in the car sheet, with "＋ Ticket" → Tickets tab) or
  "staat klaar · Toon"; on Nu only until 30 min after opening.

## In the queue (rij-modus)
- "⏳ In de rij" sends `queue` {part, wait}: `target.q[part] = { t, w: posted wait, g: guesses }` (a split has two queues;
  `target.queued` is kept for old clients). Nu then shows `queueCard()` instead of the plan ticket: countdown
  (posted wait × `waitFactor`, minus time in line), progress bar, "🎢 We zijn aan de beurt!" (`board`), game tiles and
  "Hierna waarschijnlijk" (`nextAfter`: the planner run from the ride's exit with the ride counted as done).
- `board` measures the real wait into `fam.waits` ({id, w, m, t, win}, last 40); without it, `done` estimates it as
  queue → done minus ride time and 2 min. `waitFactor(waits)` in logic.js = median measured/posted (≥2 samples, last
  12 h, clamped 0.5–1.3) and scales the wait in the planner's minutes (the shown wait stays the posted one).
- Games: 🔮 `guess` {part, person, min} (debounced in the app; the closest guess wins at `board`), 🎃 photo quests
  (`QUESTS` in fun.js; the photo's caption is the quest, shown in the album and the story), 🧠 facts + quiz (`FACTS` in
  fun.js, sourced; `quiz` {person, q, ok}: a question counts once per person, points all day), 📣 "Seintje" (split
  only): a chat message with the time they'll be at the meeting point, rounded up to 5 min.
- After "Gedaan": `rateSheet` (😍 3 / 🙂 2 / 😬 1 per person who rode on this phone's side → `rate`) + the photo button.
  `RATE_MUL` in logic.js multiplies that person's enjoyment of the ride (😍 ×1.7 partly undoes the done decay).
- "Ons dagverslag" shows toppers (ratings), the quiz champion and the queue minutes / best guesser (`storyFun`).
- The cron sends no "👉 Nu ideaal" while a queue of the current target is younger than 90 min.
- Split + queues: "Gedaan" while the other half is still in its queue (not boarded, not ready) sends `ready` instead
  and keeps the plan ("✓ Iedereen terug: Gedaan" ends it). `done` carries `part`: only the sender's own unboarded queue
  gets an estimated wait, only with a known posted wait and when not > max(2w, w+30). A second `queue` for the same
  part keeps the first start and boarding. Queue/rate in a split needs "wie ben jij" (meId) first.
- Guess drafts are sent through one promise chain (`flushGuesses`), awaited before `board`/`done`; the winner uses the
  real wait rounded to 0.1 min everywhere (`realWait`), like the server.

## Location: cleaning, automatic detection, pocket mode
- Facts (researched Nov 2026, sources in the session notes): a web page gets **no location in the background** on
  iOS or Android (screen off, other app in front, app closed: watchPosition delivers nothing, WebKit even turns GPS off
  when the page is hidden; no web API for background location; a service worker has no geolocation). So detection only
  sees fixes while the app is open and reasons about the gaps when it comes back. `accuracy` is 1σ (≈68%); iOS's first
  fix is often a cached one; "precise location" off gives ≈3–9 km accuracy and can't be detected otherwise; Screen Wake
  Lock works on Android and iOS ≥ 16.4, in iOS home-screen apps only from 18.4, and is dropped whenever the page hides.
- `public/activity.js` (pure, tested in tests/activity.test.js incl. 2 fuzz tests):
  - `addFix` rejects: accuracy ≥ 1 km (sets `tr.approx` → banner "Exacte locatie"), older than 60 s (cached), out of
    order, accuracy > 65 m (but keeps a "still here" point indoors), and jumps faster than 3 m/s (+ 2×accuracy noise;
    up to 45 m/s when the phone itself reports a speed). 3 rejected fixes that agree with each other over ≥ 20 s
    re-anchor (the anchor was wrong). The rest goes through a Kalman filter (q = 1.5 m/s, noise = accuracy) into a
    10-s history (45 min, at least the last 30 points so a long gap still knows where we were).
  - `farState`: "not in Walibi" at once before we were ever near; after that only on 3 good fixes over ≥ 60 s.
  - `detect` only asks "are we at the TARGET ride" (rides are a median 37 m apart): queue after ≥ 3 min within 70/50/35 m
    (thrill/family/kids); board on a phone speed ≥ 6 m/s there; leaving (> radius + 50 m for ≥ 60 s) → done when we
    were there ≥ ride + max(1, 0.4·wait − 1) min, "unqueue" when < ride + 2, otherwise ask ("ask-done"); a gap ≥ 10 min
    in the queue + first fix far away → done at once (time estimated); closed before arriving and back elsewhere much
    later → ask. Only "visits" (≥ 90 s, ≥ 3 points) count, so a lone teleport or a wrong first fix never does anything.
    Sitting still ≥ 15 min at a restaurant (meal time) → ate; ≥ 12 min elsewhere → pause; driving (phone speed ≥ 5 m/s,
    outside the park outline) then walking within 1 km of the entrance → car spot.
- app.js: `onGps` → `addFix` (the fix's own timestamp only when within 1 h of the clock) → `runDetect` → `autoApply`
  (actions with `at`, quiet, toast with "Klopt niet": unqueue / queue again / undo + re-target / clear car). Done goes
  through `finishPlan({auto})`: in a split, recognising our own ride only sends `ready` (never ends the other half's
  plan). "Hoe was X?" and "Hebben jullie X gedaan?" are cards on Nu (`autoCard`), not pop-ups. The watch is restarted on
  every return to the front (maximumAge 0). Setting `S.auto` (Gezin → 🤖). The tracker is kept in localStorage.
- `done` carries `target` (= setAt): a done for a plan that is no longer current counts nothing (two phones detecting).
  New action `unqueue`.
- Pocket mode (🫥 on Nu): black screen + wake lock so fixes keep coming; only a long swipe up (or double click) opens;
  refuses with an explanation when the wake lock is refused. ±10% battery per hour (screen on).
