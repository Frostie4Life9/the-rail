# The Rail (v2)

Phone-first PWA for Skyler's daily outfits. Static site on GitHub Pages; no build step.

- `index.html` — the whole app (HTML/CSS/JS inline). Bump `VERSION` here AND in `sw.js` on every change.
- `sw.js` — offline shell + tile cache. `tiles/` — the 60 original item photos, named by tag code.
- Data is NOT in this repo (it's public). It lives in the private repo `Frostie4Life9/the-rail-data`
  (wardrobe.json, fit-log.json, laundry.json, photos/, tools/rail.py) and the app reads/writes it
  through the GitHub contents API with a fine-grained token stored on the device.
- Every change in the app is a named op (`OPS` in index.html) that is applied locally, queued, then
  re-applied to a fresh copy of the file and written with its sha — keep ops deterministic and replayable.
- The daily "Morning fit sheet" scheduled task writes today's plan into fit-log.json via tools/rail.py.
- Before shipping: `node --check` the extracted script and run the Playwright smoke test (`test/smoke.mjs`).
- v1 (Gemini/Supabase, single file) is preserved on branch `v1-archive`.
