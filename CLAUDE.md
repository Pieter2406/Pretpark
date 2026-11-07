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
  /apple-touch-icon.png (home-screen install fetches these without cookies). A third Access app "Pretpark (OwnTracks)"
  (id 551e20e1-…) bypasses only pretpark.pieterverlinden.be/api/ot (OwnTracks can't log in; the Worker checks the token).
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
- Review fixes: auto never sends `done` in a split while the other half isn't ready (only `ready`, once); leaving only
  counts with a visit at/after the queue start (a queue tapped far from the map point is never auto-ended); a single
  fix after a gap only decides when ≤ 25 m, and when the app closed at the ride the stay is estimated like a gap;
  `freshTracker` drops a tracker from > 6 h ago and a drive older than 2 h never makes a car spot; the tracker is saved
  at most every 15 s and when the app is hidden; poor fixes (65–200 m) still move the dot/arrow after 30 s without a
  good one, but never feed detection; fix times are clamped to now; a failed auto action may retry after 2 min;
  "Klopt niet" only when our own done counted. In pocket mode there are no toasts (a tap through the fabric must not
  undo); the last automatic action keeps its "Klopt niet" on Nu for 15 min (`S.lastUndo`, `autoCard`).

## iPhone / iOS compatibility (checked 7 Nov 2026, also run in WebKit)
- Minimum for the app: iOS 15.0 with `public/compat.js` (structuredClone, Array/String `.at`, `findLast(Index)`
  fallbacks; imported first by app.js) and CSS fallbacks (vh before dvh, a plain background before `color-mix`,
  `-webkit-backdrop-filter`). `api()` uses `timeoutSignal` (AbortSignal.timeout only from iOS 16).
- `public/vendor/pdf.min.mjs` and `pdf.worker.min.mjs` got a one-line `Promise.withResolvers` polyfill at the top
  (pdf.js 4.10 needs it, iOS < 17.4 lacks it; pdf.js polyfills Promise.try and base64 itself). Keep it when updating pdf.js.
- Feature floors: Web Push and Wake Lock iOS 16.4 (push only in the home-screen app); Wake Lock in the home-screen app
  only from iOS 18.4 (`iosOld` → pocket mode refuses); `navigator.vibrate` doesn't exist on iOS (always `?.`);
  `interactive-widget` is ignored by Safari (the chat uses visualViewport instead).
- iOS gestures: the pocket swipe only counts when it starts above the bottom 20% (the Home gesture lives there);
  double click only with a mouse. The location watch is only restarted when no fix came within 8 s after returning
  (restarting can re-prompt for permission on iOS) and never after a refusal. If the screen went off in pocket mode
  anyway, the app says so on return.
- Running WebKit here: `PLAYWRIGHT_BROWSERS_PATH=<dir> npx playwright@<same version> install webkit` + `install-deps
  webkit`; the service worker intercepts `/api/live` in WebKit, so `route()` mocks don't apply there (real data).
- Live data guard (worker/rules.js `liveRides`): waits > 180 min or the same wait ≥ 60 on ≥ 70% of rides are
  placeholders (Walibi's feed said 222 for every ride before opening on 7 Nov) → `w: null` (unknown).
- Automatic detection: only queues it started itself (`q.auto`) can be auto-"unqueued"; no eating/resting detection
  while a queue of the plan is open; a manually chosen spot only blocks detection for 20 min; `done` carries `target`
  only when automatic (a tapped, offline "Gedaan" is never dropped).

## OwnTracks: background location with Pretpark closed
- Why: a web app gets no location in the background (see above); the free OwnTracks app (iOS/Android, open source)
  does, and POSTs it in HTTP mode to a URL. App view 📡 "Volgen met de app dicht" (Gezin card + a button on Nu) shows
  the steps: store link (by platform), "⚙️ Instellen in OwnTracks" = `owntracks:///config?inline=<base64 JSON>` with
  `mode: 3` (HTTP), `url` = `/api/ot/<token>`, `monitoring: 2` (Move), `locatorInterval 30`, `locatorDisplacement 10`,
  `moveModeLocatorInterval 15`, `ignoreInaccurateLocations 0`, `tid` = initials; manual fallback with the URL; the
  "Always" location + battery steps; live status (polls `/api/otsetup` every 5 s: last fix, accuracy, battery); stop /
  new link. Needs "wie ben jij" (the server acts for `fam.me[device]`).
- Server: `/api/otsetup/<family>?device=` (behind Access) GET status / POST new token (replaces this phone's) / DELETE.
  `/api/ot/<token>` (Access **bypass app "Pretpark (OwnTracks)"** for `pretpark.pieterverlinden.be/api/ot/*`, checked by
  the 24-char token instead) always answers `200 []` (OwnTracks retries anything else; a revoked token is quiet).
  worker/owntracks.js: `otFixes` (locations only, today, sorted, vel km/h → m/s), `step` runs activity.js `addFix` +
  `detect` "as of" each fix's time (OwnTracks sends its offline queue later), `actionsFor` maps events to the same
  family actions as the app (queue auto, board, unqueue, done with target / ready in a split, ate, pause, car) with
  stable aids, and a push to that phone (`notifyDevice`) for queue / done / ready / unqueue / ask / car. `applyAction`
  (worker/index.js) is the shared optimistic-concurrency write used by /api/family too. The latest good fix also
  updates `positions[device]` (partner dot). D1 table `ot` (token, family, device, tracker JSON, info, last, created);
  the cron deletes links after a day without positions. Tests: tests/owntracks.test.js, worker.test.js (OwnTracks).
- Review fixes (OwnTracks): `/api/ot` never answers anything but `200 []` (all work in `otReceive` inside try/catch,
  content-length > 400 kB refused before reading); only the newest 300 fixes per request; the tracker row is versioned
  on `last` (a parallel request that saved first wins, the loser sends no pushes); a failed action clears its
  `emitted` key so it can fire again; pushes only when the action really changed done/target/car (JSON compare), only
  to a subscription of the same family, and not when the push pref `auto` is off (Gezin › Meldingen › 🤖); in a split
  an unknown person on the phone acts for nobody; the partner dot is written at most once a minute or after 25 m; the
  setup view's 5-s poll only replaces the status line.
- OwnTracks ≥ iOS 26.2.2 / Android 2.6.0 block `owntracks:///config` links by default ("URI or file configuration not
  allowed"); the user must first enable `allowConfigurationByURIAndConfigFile` in OwnTracks › ⓘ › Instellingen (a link
  can't change it). So the view shows the manual way first (copy the link; Modus HTTP, URL; choose **Actie** = Move in
  the Dutch app) and the one-tap button second, with that hint.
- OwnTracks (iOS 27) first POSTs a `_type: status` message on connect (no location); the receiver then stores
  `info.contact` + `info.types`, and the view says "verbonden, maar nog geen locatie: kies Actie en tik ↑". A phone left
  on "Significant" (`monitoring=1` in its log) sends locations only after moving a few hundred metres.

## Location check (Gezin › 📍 Locatie-check)
- One row per person (all devices of that person merged: Safari and the iPhone home-screen app are separate devices):
  OwnTracks (last fix, accuracy, battery, "Actie?" hint after 10 min, or "verbonden, nog geen locatie"), for yourself
  the app GPS (last good fix, accuracy, counts of good/ignored fixes per reason, "ongeveer" warning) and the last
  automatic recognition. 🟢 < 10 min · 🟠 10–30 · 🔴 OwnTracks linked but silent · ⚪ only while the app is open.
  Refreshes every 30 s on the tab; `/api/otsetup/<family>?all=1` (behind Access, no tokens) every minute while someone
  uses OwnTracks or the tab is open, else every 10 min.
- Banner "Geen locatie van X sinds …" when another person's OwnTracks is linked and their newest position (any device)
  is > 30 min old during opening hours, not within 45 min of a meal/pause; dismissable per silence (`loc:<pid>:<t>`).
- A status-only OwnTracks post updates `info.contact/types` with one `json_set` (never overwrites a newer location).

## Photos: nothing gets lost (7 Nov)
- Photos taken in Pretpark don't reach the phone's own Photos app, so every album photo taken/added on a phone is kept in
  IndexedDB `keep` ({id, file, thumb, meta, up, saved, refused}; idb.js **version 3** — never roll the version back,
  older code would get VersionError) and stays there after the upload. The `uploads` queue refers to it (`ref: 1`);
  old v2 queue items ({id, file, thumb, meta}) still upload and are then kept too. Deleting on purpose removes it from
  keep, queue and server; the server remembers deleted ids (`photo_gone`, 30 days) and answers 410 to a late upload.
- Upload = two phases per round: all small versions first (`meta.thumbOnly`: thumb + details → in the shared album at
  once, `full: false`; the server's GET `/full` serves the thumb meanwhile with `no-store` + `x-pretpark-small`), then
  the originals (timeout 60 s + size at 30 kB/s, ≤ 15 min). A thumbOnly that arrives after the original never
  downgrades it (conditional upsert). `processUploads` re-runs when called while busy, resumes on `visibilitychange`,
  re-queues kept photos that are neither online nor queued (`requeueKept`), never drops a queue entry unless the photo
  is safely in keep, and treats an IndexedDB read error as "later" (idb.get throws), not as "deleted".
- If the browser refuses to store the photo (private browsing, full disk) it lives in `S.mem`, uploads at once, a
  toast says to keep Pretpark open, and `beforeunload` asks before leaving (doesn't fire on iOS).
- Album: "📱 n staan op deze gsm", status lines ("⏳ origineel volgt (7,7 MB): houd Pretpark even open", "Wacht op
  bereik"), photos only on this phone (refused by the server) are shown too. "💾 Bewaar … ook in je Foto's-app" shares
  unsaved camera photos via the share sheet (≤ 10 photos / 40 MB per tap; from the gallery = already saved). The viewer
  shows the local original (fallback to the thumb if the browser can't show it, e.g. HEIC on Android).

## Review round 1 (7 Nov, park day)
- Rides missing from ThemeParks.wiki (25 of 41, all kids rides: no wait sensor) were treated as closed, so the toddler
  side never got a ride. Now `status()` assumes them open while the park is open (`parkIsOpen`: within open/close of
  the feed, or some ride OPERATING), `s: 'ASSUMED'`, wait unknown (planner uses 5 min kids / 10 min else). The family
  can mark any ride closed for the day (ride sheet "🚫 Is dicht" → action `closed` → `fam.closed` → `ctx.closed`).
- Notifications: `describe` says "wachttijd onbekend" for unknown waits; "👉 Nu ideaal" only with a known wait ≤ 15,
  never for the chosen plan, not within 10 min after a ride was done; a target ride that was OPERATING and turns CLOSED
  mid-day counts as a breakdown (`memo.op`); meal/rest tips stop 45 min before closing; without a schedule the rest
  reminder counts from the first ride done today. /api/live: 5-s timeout on ThemeParks.wiki, 3-s cap on the weather,
  the last good copy (≤ 10 min, `stale: true`) when the feed fails.
- Client state: a new action queues behind waiting outbox actions (order kept), the action in flight is saved
  (`pp:inflight`, re-queued at start; aid de-dupes); `pos` has no aid (doesn't eat the 80-aid window). Chat: one
  sender at a time, removal by id, polling overlaps 60 s. Tickets deleted offline are remembered (`pp:tgone`) and the
  DELETE is retried before syncing. Photo PATCH sends/merges only the changed field. The SW focuses the app and posts
  `{type:'open', url}` on a notification tap (no reload); the lazy cache is `LAZY = pretpark-lazy-<hash of vendor+img>`
  (stamp-sw.mjs), so pdf.js/reader/photo updates reach phones.
- UI: a dialog opened right after another closed reuses its history entry (`pendingBack`, 450 ms) — back no longer
  leaves the app after sheet → guide; toasts above dialogs (z 70) but never in pocket mode; Gezin keeps unsaved people
  edits (`S.famDirty`); the guide scrolls on short screens; the OwnTracks view creates the link once "wie ben jij" is
  known; the boarded split card keeps "✅ Wij zijn klaar"; the iOS "Exacte locatie" path is current.

## Diaper check (luier)
- The toddler = `toddlerOf(people)` (child < 110 cm). `diaperDue`: ≥ 90 min since the last check (`fam.diaper`, action
  `diaper`) or since opening / the first ride today. Nu shows "🚼 Toilet op X m: even de luier van … checken?" when a
  fresh GPS fix is ≤ 45 m from a park toilet (✓ Gedaan → `diaper`; Later = 20 min quiet; 🧭 to the toilet). In a split
  only the phone with the toddler. The cron sends the same as a push (rule 4b, tag `diaper`, at most every 45 min,
  pref `diaper`, shown only with a toddler) using `TOILETS` from worker/owntracks.js and the phone's last position.

## Review round 2 (7 Nov)
- Queue waits: `queue` only stores a wait the park really posts (`T.posted` / `status().known`); family.js `waitOf` keeps
  an unknown wait `null` (Number(null) was 0, which made a long gap read as "left the queue"). Guessed waits never feed
  `waitFactor`.
- Outbox: waiting actions are re-applied on top of every server copy (`takeFam`), pollFamily no longer pauses while
  something waits; a head that keeps failing (not offline/401) is skipped after 6 tries; `pp:inflight` is a map by aid.
- Tickets: code crops ≤ 1000 px (JPEG when the PNG > 800 kB), old oversized crops shrunk before sending, a 413/400
  (not "too many") marks the ticket `refused` (no endless re-POST); pages without a code only when the file had no code;
  re-import de-dupes those by source#page; one unreadable file (HEIC on Android) no longer cancels the batch; the server
  keeps the phone's `created` (import order).
- "Wie ben jij" preselects an adult no other phone has claimed (`freeAdult`). Map pan uses Math.max (slice). "Is dicht"
  also greys the map pin and sorts the list (`famStatus`). Guide: arrive < 25 m, leave > 40 m; turn text bands with 8°
  hysteresis (`turnBand`), buzz ≤ every 3 s; a silent utterance in the opening tap unlocks iOS speech.
- `phoneOf`: "+32 (0)470…", "+320470…" and "0032…" → "+32470…". Chat re-renders only for new message ids. Live data
  older than the copy we have is ignored. Rest/diaper timing starts at `dayStart` (opening, but not before the family
  was made and about 20 min before the first ride today). The pocket "screen went off" note shows after closing pocket.
