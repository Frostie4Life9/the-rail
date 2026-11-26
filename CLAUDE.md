# The Rail (v2)

Phone-first PWA for Skyler's daily outfits. Static site on GitHub Pages; no build step.

- `index.html` — the whole app (HTML/CSS/JS inline). Bump `VERSION` here AND in `sw.js` on every change.
  Versions are date-based: `YYYY.MM.DD-a` (then `-b`, `-c`… for more releases the same day). The new-version
  bar at the bottom of index.html reads `VERSION` from the live page and only shows when it's newer; test it
  with `node test/update-bar.mjs`.
- `engine.js` — the free in-app fit engine ("Suggest fits"; no AI). A linear model over named features: `PRIOR` (hand)
  + `TUNED` (learned). Retrain after a few weeks of new fits: `node test/engine-train.mjs <the-rail-data> --write`
  (5-fold by-day cross-validation, then writes TUNED). `FIXED` weights (rotation, safety, church formality) are policy
  and never learned. `personalize()` retunes on the device from the person's own worn log once ~12 fits exist.
  Backtest: `node test/engine-eval.mjs <the-rail-data>`; UI: `test/suggest.mjs`.
- `sw.js` — offline shell + tile cache. `tiles/` — the original item photos, named by tag code (kept as
  sources). `cut/` — the same photos with the background removed (transparent WebP); the app shows `cut/`
  for any `tiles/` path and so does `rail.py sheet`. A new tile needs a matching `cut/<name>.webp`.
  The SW caches `cut/` forever by URL, so bump `CUT_V` in index.html whenever cut photos are re-made.
- Data is NOT in this repo (it's public). Two ways in, both speaking the GitHub-contents shape (`{content b64, sha}`),
  so the sync code is one path (`Store()` picks `API` or `GH` in index.html):
  - **Accounts** (friends, and the owner once set up): Google sign-in → the `rail-api` Worker (`worker/rail-api.js`,
    `wrangler.jsonc`, https://rail-api.skyfro04.workers.dev). Invite-only: OWNER_EMAIL plus emails the owner adds in
    Settings. Friends' files and photos live in D1 (`rail`). The owner's files pass straight through to the private repo
    `Frostie4Life9/the-rail-data` once the Worker has a GitHub token: when the owner signs in on a phone that has the
    token form filled, the app hands that token to the Worker (`POST /owner/github`, sealed in D1 with AES-GCM from
    `SECRET`) and drops it from the phone. A `GH_TOKEN` secret, if set, wins. Until then the owner signs in only to manage
    invites. Google client = Playback's (same origin); `GCID` in index.html
    must match `GOOGLE_CLIENT_ID` in wrangler.jsonc. Workers Builds deploys the Worker when `worker/*` or `wrangler.jsonc`
    change on main. Secrets (`SECRET`, `GH_TOKEN`) live only in Cloudflare.
  - **GitHub token** (the owner's original path, under "Owner: connect with a GitHub token" in Settings): a fine-grained
    token on the device, straight to `the-rail-data` (wardrobe.json, fit-log.json, laundry.json, photos/, tools/rail.py).
- Tests for accounts: `node test/worker.mjs` (Worker on a local D1) and `node test/accounts.mjs <out-dir>` (a friend's
  whole first visit in Playwright against the real Worker). Both need `miniflare@4`.
- Adding a piece: `openCamera()` in index.html is an in-app viewfinder (getUserMedia) with a dashed outline per type
  (`SIL`, 300x400 frame) and a box for a corner of white paper. `photo.js` (pure functions, `RailPhoto`) white-balances
  each shot from that paper (falls back to a gentle ±8% gray-world and says "approximate"), lets you tap anything white
  to re-fix, and the shot is cropped to the outline (`FRAME.garment`). Library photos: no outline/crop, tap-to-fix.
  Items record `colour_ref` (paper / tap / auto); `uncalibrated` is true for auto. Tests: `node test/photo.mjs`,
  `node test/camera.mjs <data> <out> <flatlay.y4m> <library.jpg>` (Chromium fake camera; make the y4m with a warm cast).
- Background cut-out (`cutout.js`, `RailCut`): after a piece's photo is taken/chosen, the add sheet cuts the background off on the
  phone with U²-Net-p (`models/u2netp.onnx`, 4.6 MB) on ONNX Runtime Web (`vendor/ort/`, wasm, single thread since Pages
  can't send COOP/COEP), then refines edges with a guided filter, drops specks, defringes against the floor colour, crops,
  caps at 640px. Free, nothing leaves the phone; the SW caches `models/` + `vendor/` in `rail-cut` forever (new model = new
  file name). Saved as `photos/items/<id>.cut.webp` (PNG on Safari) in `photo`, the original JPEG in `photo_full`; both go
  up with the op (`uploads: [...]`). "Keep background" saves just the JPEG. The piece sheet offers "Remove background" for
  plain photos and "Use the original photo" (keeps the cut in `photo_cut` to swap back). `isCut()` = tiles/ or .png/.webp.
  The Worker accepts .jpg/.png/.webp photos (magic bytes checked). Test: `node test/cutout.mjs <out>`. Licences: vendor/README.md.
- Per-person fit rules (Settings → "Your fit rules"): saved as `rules` in that person's wardrobe.json via the `setRules` op
  (`{cap: "always"|"optional"|"never", labDays, church}`). Nothing saved → owner gets `RULES_OWNER` (his originals),
  friends get `RULES_FRIEND`. `engineRules()` maps them to the engine's `{cap, labShortSleeve}`; `myOccasions()` hides
  the Lab / Church chips. Hidden pieces and pooled pieces (`qty`) stay per item; any socks can become a pool from the
  piece sheet. Test: `node test/rules.mjs <data> <out>`.
- First visit (`setupHtml()` on Today): a 3-step card (add pieces with per-category counts → check rules → first fits) shown
  while `inSetup()` (friends only): no fit logged yet and `setup_done` not set in wardrobe.json (the "hide this" link sets it via the
  `setupDone` op). Suggest fits names missing categories (`missingSlots()`). Test: `node test/onboarding.mjs <data> <out>`.
- Every change in the app is a named op (`OPS` in index.html) that is applied locally, queued, then
  re-applied to a fresh copy of the file and written with its sha — keep ops deterministic and replayable.
- The daily "Morning fit sheet" scheduled task writes today's plan into fit-log.json via tools/rail.py.
- Before shipping: `node --check` the extracted script and run the Playwright smoke test (`test/smoke.mjs`),
  plus `test/studio.mjs` (walks every tab in light and dark and saves screenshots; pass a folder of local .ttf
  files as the 3rd argument to see the real fonts when Google Fonts can't be reached).
- Look: "Studio" (since 2026.11.24-b). Cut-out photos on a photo-studio backdrop. Today's looks are flat lays
  (`layHtml`) in a sideways carousel, each tinted by its own outfit colour (`leadOf` → `--fc`); `colourOf` turns
  a piece's colour words into a swatch. Type: Anybody (condensed display), Hanken Grotesk (body), IBM Plex Mono
  (care-label facts). Tabs: Today, Closet, Hamper, Diary (`tab="worn"`); Settings is the gear in each header.
  Never show item code numbers in the UI.
- Part of Skyler's app suite (Kitchen, Grocery, Lift, DishLog, Protocol, Rail, Game Log, Playback). The top bar and shared motion
  (`window.SX`) between the `suite:css` / `suite:bar` markers are generated by `tools/suite.py` in the
  `Frostie4Life9/kitchen` repo — edit there and re-run, never by hand here. Rail's suite color is violet
  (#3A2A63 light / #B9A6F2 dark); icons are `icons/rail-*.png`, drawn in the suite style (Fraunces R + badge).
- v1 (Gemini/Supabase, single file) is preserved on branch `v1-archive`.
