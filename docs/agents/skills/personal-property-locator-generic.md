---
name: Personal Property Locator (Generic)
description: >-
  Locate a lost or stolen personal item offered for resale on second-hand
  marketplaces. Runs as a long-running, resumable operation that builds and
  maintains a ranked leaderboard of candidate listings across many sessions.
tags:
  - personal-property-recovery
  - property-locator
  - marketplace-search
requiredTools: []
promptTemplate: |
  Required details:

  - item-type =
  - brand =
  - defining-attributes =
  - last-seen-location =
  - last-seen-date =

  Optional details:

  - starting-marketplace =
  - report-frequency = 6 hours
  - distinguishing-marks =
---

You can help locate a lost or stolen personal item that may have been listed for resale on second-hand marketplaces. This is a long-running, resumable operation spanning many sessions ("ticks"). Across ticks you progressively search the web and relevant marketplaces, and maintain a ranked leaderboard of candidate listings, so a human can check the best matches against the real item.

This work surfaces candidates and evidence. It does not arrange purchases or contact sellers. When a strong candidate is found, the intended next step is reporting to the police and the platform.

**Acquiring the capabilities you need**

This skill describes *what* to do, not which tools to use. It assumes you can find and add whatever capabilities the work needs. If you cannot yet do something below — searching the web, browsing or crawling pages, saving notes, remembering across sessions, scheduling your next session, or messaging the user — look for a skill that provides it and add it, then proceed. Prefer the smallest set of capabilities that gets the job done.

The work needs, roughly:

- Searching and reading the web, including browsing or crawling marketplace pages that resist simple reading.
- Saving and re-reading your own working notes.
- Remembering a small amount of state durably across sessions.
- Scheduling your next session.
- Messaging the user and publishing results.

**Item details**

The following are required. If the user has not provided them, ask.

- item-type =
- brand =
- defining-attributes = (size, colour, model, features)
- last-seen-location =
- last-seen-date =

Optional:

- starting-marketplace = (default: the largest regional second-hand marketplace)
- report-frequency = 6 hours
- distinguishing-marks = (scratches, stickers, serial number — what makes THIS item unique)

**Continuity — single entry point**

On startup, look for an entry-point document `AGENTS.md` among your saved notes. If it is missing, you have not created it yet — create it, then begin. `AGENTS.md` must link to every other state document (to any depth of nesting) so future-you never has to guess the structure. Suggested documents, all reachable from `AGENTS.md`:

- `AGENTS.md` — mission, current status, last-tick summary, next-tick plan, links to everything below.
- `ranking-rubric.md` — scoring criteria and weights.
- `leaderboard.md` — ranked candidates with scores and per-criterion breakdown.
- `seen-ledger.md` — every listing already evaluated, keyed by listing ID.
- `search-log.md` — every search vector attempted, with timestamp and outcome.

Saved notes may not survive between runtimes, so also keep a durable pointer and a compact leaderboard snapshot in long-term memory each tick, and recover from it if the notes are gone.

**Each tick**

1. Load state: read `AGENTS.md` and follow its links; fall back to long-term memory if the notes are missing.
2. Choose new search vectors from `search-log.md` — do not repeat a vector already logged.
3. Run a bounded batch of searches (a handful per tick), searching and crawling the web and marketplaces.
4. For each new hit, capture evidence: listing ID, URL, seller, location, price, post date, image URLs, capture timestamp. De-dupe by listing ID, not URL.
5. Score each hit with the rubric, update the leaderboard and the memory snapshot, extend the seen-ledger and search log.
6. Persist state to your notes and to long-term memory, then schedule the next tick.

**Ranking rubric (pre-committed)**

Keep the rubric in `ranking-rubric.md` and link it from `AGENTS.md` so it is obvious at the start of every tick. Do not re-invent it per tick; if you change it, version it and note why. Score every hit 0–100 as a weighted sum and record the per-criterion breakdown so a human can audit the ranking. A starting rubric (tune to the item and record changes):

- Brand/model match — highest weight, especially for rare or distinctive brands.
- Location proximity to the last-seen location — high weight; stolen items usually resurface nearby.
- Listing recency (posted after the last-seen date) — meaningful weight.
- Each matching physical attribute (size, colour, features) — moderate weight each.
- Price plausibility — small weight; flag suspiciously cheap or "quick cash sale" listings.

Flag any candidate above a threshold you choose as "verify with owner".

**Bot protection**

Marketplaces use aggressive bot protection. Even browsing as a real user would, you may hit CAPTCHAs. Treat blocks as a normal state: log "blocked/unreachable" against that vector in the search log and move on rather than hammering it. Respect each site's terms.

**Reporting**

Every `report-frequency` (or once per N ticks if ticks are sparse), send the user a review that summarises the whole operation, presents the current leaderboard top-N with scores and reasons, and recommends whether to extend, continue, or wind down — and by how long. Continue until the user stops the task.
