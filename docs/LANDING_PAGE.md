# Landing page: inside the colony

Written 2026-10-30; since 2026-10-31 this page is again `web/index.html`, the front door, and `web/app.html` is the nest, the app's home (`docs/NEST_PAGE.md`; the brand links there). The landing page also shows the nest in its own section after the result card. A redesign of the landing page around one idea: the first screen is the colony. The hero is a full-bleed stage replaying the latest finalized market from its seed, with a HUD of real numbers over it. The page's existing components stay as they are (`ColonyView`, `.sim-frame__hud`, `.forecaster`, `.vs-table`, `.hash`, `.pill`, `.verify`, `.how`, `.pot`, `.anto`, `.proof`, `.banner`). This doc changes layout, motion and copy, and adds one interaction (scroll scrubs time).

## Decisions

| Question | Decision | Why |
|---|---|---|
| What the hero replays | The market `pickMarket` already chooses: the first finished market of `round.shown` (the current round once its colonies have run, else the previous one). It opens on the first cranked colony, Momentum first | Already built and verified; no new chain reads |
| Tick count in the HUD | **`tick 0187/0300`**, read from `col.ticks`, not 800 | Forecast colonies are 60 ants × 300 ticks (`FORECAST_TICKS`). 800 is the generic `burn_run` colony, which no round uses. A HUD that says 800 would be the one fake number on the page |
| "About 8 seconds" | **The player's 1× speed, 12 ticks/s: 300 ticks in 25 s** (changed from 4×, which was too fast) | 4× is a design-system speed (§Motion). An exact 8 s would need 37.5 ticks/s, a speed found nowhere else. Home's `LIVE_TPS` (12, 25 s) stays for Live and Market |
| Pheromone as UI language | **Only on the stage, and the hero is the stage.** Dividers stay hairlines. "Scent glow on interaction" is the pile's score ring brightening on the map when you hover or focus its outcome anywhere on the page | DS rules 1 and 9: amber is brand, pheromone and the one primary action, and pheromone is a field on the map, never a mark. "No glows except focus" outside the stage. Making the stage the whole first screen gives the "standing inside" feeling without amber leaking into the ledger |
| Primary action | **Verify this colony** (amber, `.btn--primary`). Secondary: **Watch the round live** (plain `.btn`). "Get free $ANTO" leaves the hero; the top-bar $ANTO chip and `#anto` still offer it | One primary per view. Checking is the claim that sets this apart |
| What Verify does | Opens the `.verify` block under the stage, in place: the shown colony's hash from the chain beside the one your browser computed, then the other two colonies and the market hash, then "Open in Replay". It reuses `makeVerifier`'s result if it has finished, and says how long it took. It never plays a progress animation for work that is already done | The replay is the check: the colony that just played is the same `Colony` whose `result().hash` is compared |
| $ANTO today and A round in numbers | Move out of the hero to the first block after the scene | The hero has to answer three questions in two lines. The token's state stays on the first screen through the top-bar chip |
| Scroll-as-time | **On by default in How the ants forecast**, with a toggle in the HUD. Off by default under reduced motion | The four steps already are the lifecycle; scrolling through them while the map follows is the explanation |
| What counts as demo | Anything not computed by `antosim` from the chain's (or the recorded) inputs carries a `DEMO` mark: the idle scouts before a seed, any illustration. The recorded round 4 is **not** demo: it is real data, labelled "Recorded · round 4" | The rule is about provenance, not freshness |

**Success test:** a first-time visitor who reads only the first screen can say (1) it's ant colonies forecasting a Polymarket market on NEAR, (2) the trail near each outcome's food decides the swarm belief, and the seed comes from drand, and (3) they can check it here with one button.

## Built (2026-10-30)

Built in `web/index.html`, `web/app.css` (the `.scene` block), `web/landing.mjs` (with `web/test_landing.mjs`) and `ColonyView.focusSource`. Checked in headless Chrome at 1440×900 and 390×844, with reduced motion, without JS and with an unreachable contract. Where the build differs from the plan below, the text has been updated. In short:

- **Phone order:** the actions and the market title come before the map, so Verify is on the first screen. On phones the HUD drops its status pill and the colony name; the round label and the selected tab carry them.
- **Idle and demo:** the idle "no finished market" stage and its `DEMO` chip are not built. Round 4's recording is always available, so the stage replays it with a line on what the current round is doing. Nothing on the page is drawn from outside the sim, so nothing carries the mark.
- **Cuts:** the scenery continuing left of the map, the crossfade and the static no-JS frame (§7 items 1, 4 and 5).
- **Pinned map height:** on a 390×844 phone the pinned stage (map, HUD lines, tabs) is about 416px, not the 272px planned.
- **The zoom (revised the same day):** the step panels (70% of a viewport each) were too big for what they say. On wide screens the stage is now pinned for the whole scene, full bleed: the map starts beside the pitch at its whole-pixel size, and as the pitch scrolls away it grows to fill the screen's height, from part way under the left column to the right edge. Its left edge fades into the dark under the steps, which are plain text (no cards) that hold above the middle while their stretch of scroll goes by. The result card moved out of the scene to just after it, where step 4's Verify link lands. On narrow screens nothing zooms: the map pins at the top as before and the steps are the same plain text.

## 1. Hard rules and how the page meets them

| Rule | On the page |
|---|---|
| Swarm belief, never probability | The HUD's per-option row is headed "trail share". The ledger under the stage keeps the `.vs-table` head "Swarm belief" and the line "Swarm belief is a trail share, not a probability." |
| Every forecast carries `.tag-forecast` | Once on the hero (in the HUD's bottom strip) and once on the ledger, as now |
| No betting language or venue links | Copy below avoids win, bet, odds to win, edge. The Polymarket source is plain text |
| Drawing never calls the sim RNG | Scrubbing seeks with `Colony.clone()` snapshots and `step()`; `ColonyView` only reads |
| Numbers never animate | HUD numbers change per tick as text; no count-ups, no tweened percentages |
| One amber control | Verify this colony. The scroll toggle, tabs and Replay link are neutral |

## 2. Layout and scroll storyboard

The page is two zones. **The scene** (hero plus How the ants forecast) shares one sticky canvas, followed by the result card. **The ledger** (everything after) is the current page from `#pot` down, unchanged.

### Desktop (≥ 1200px)

Map size (`heroCell`): the largest whole number of pixels per cell such that the map is at most 70% of the viewport width, leaves the copy column 400px, and fits under the top bar with 96px to spare. At 1440×900 that is 13px per cell (936×624); at 1280×800, 10px (720×480); at 1920×1080, 18px. The map sits in the right column; the whole scene sits on a full-width band in the map's soil colour, so the copy never covers a pile.

```
Frame A · first screen (scroll 0)
┌ top bar · $ANTO chip ─────────────────────────────────────────────────────────┐
├ demo strip ───────────────────────────────────────────────────────────────────┤
│ soil + scenery         ┌ map 1008×672 ──────────────────────────────────────┐ │
│                        │ Round 41 · Momentum · tick 0187/0300  [◌ Result final]│
│ $ANTO · ANT COLONY     │                                                      │ │
│ ORACLE · NEAR TESTNET  │        ▲ Yes                                         │ │
│                        │     ░░▒▒▓▓ trail                    ■ No              │ │
│ Ants vs.               │            ⌂ nest                                    │ │
│ the market.            │                                                      │ │
│                        │                                                      │ │
│ One line (§5)          │ trail share ▲ Yes 47.0%  ■ No 53.0%                  │ │
│                        │ seed 046e…b237 · ✓ hash matches the chain            │ │
│ [Verify this colony]   │ ◇ Forecast · not advice     Scroll drives time [on] │ │
│ [Watch the round live] └──────────────────────────────────────────────────────┘ │
│                        [Momentum ▲ 53.0%] [Community ■ 61.6%] [Agents ■ 77.3%]  │
│ Will bitcoin hit … in October 2026 · Polymarket · 2 outcomes                   │
└──────────────────────────────────────────────────────── ▾ How the ants forecast ┘
```

```
Frame B · the zoom (scroll 0 to about half a viewport). The stage is pinned under the top
bar for the whole scene. The pitch scrolls up and fades; the map's box grows from its
column to the stage's full height, from 45% of the way under the left column to the right
edge (cover, so the top and bottom rows crop). The tabs fade out; the HUD slides right to
stay clear of the steps; the map's left edge fades into the soil under the steps' column.
Done before step C reaches the reading line. Reduced motion: it switches at half way.
```

```
Frames C to F · How the ants forecast (the map fills the screen; each step is plain text on the left)
scroll →  C  A seed nobody picks       tick 0000   piles, nest, no trail, ants at the nest
          D  Three colonies forage     0000→0200   the map plays as you scroll; the forecaster
                                                   tabs swap colony at each third of the step
          E  Trails become the forecast 0100, 0200, 0300   each checkpoint pauses ~40% of a
                                                   viewport; the score rings pulse once
          F  You check it              0300        final frame, the HUD's hash line expands to
                                                   chain hash = your hash
```

```
Frame G · the scene ends: the map scrolls away with the How section's bottom edge
The result card (Verify panel, opens here on click, then .vs-table, market hash, foot)
$ANTO today (three .hero__stats) · A round in numbers · then #pot, #anto, #check, limits (as now)
```

Scroll mapping (Frames C to F, `storyTick`): each step gets 85% of a viewport of scroll (60% for the last; 55% on narrow screens), its text sticky about a quarter of the way down, and the stage is `position: sticky`. Where the reading line (55% down the viewport; on narrow screens, halfway down the space under the pinned map) crosses the steps sets the tick: step C is tick 0, step D runs 0 to 100, step E holds at 100, runs to 200, holds, runs to 300 and holds, step F is 300. The step under the line is full strength with an amber rule; the others are dimmed. The HUD tick is always the real `col.t`. The forecaster tabs don't change on their own: the colony you picked stays.

Before Frame C, if the autoplay has already reached 300, the map steps back to 0 as you enter step C. Going back re-runs the colony from tick 0, which takes a few milliseconds (the three round-4 colonies run 300 ticks in about 16 ms together). Leaving the steps shows the run's end again.

### Tablet (600 to 1199px)

One column. The headline and line come first, then the map (whole pixels per cell, up to the container width), the HUD overlaid, the tabs under it, then the CTAs. Scroll-as-time runs in How with the map sticky at the top. The steps scroll under it as plain text; nothing zooms below 1000px.

### Phone (390px)

As planned (built order in §Built: actions before the map):

```
┌ top bar (nav is its own row, not sticky) ┐
│ $ANTO · ANT COLONY ORACLE · NEAR TESTNET │
│ Ants vs. the market.          (2 lines)  │
│ One line (§5)                 (3 lines)  │
│ ┌ map 360×240 (5px/cell) ──────────────┐ │
│ │ R41 · Momentum            ◌ Final    │ │  HUD top: one row, abbreviated
│ │                                      │ │
│ └──────────────────────────────────────┘ │
│ tick 0187/0300 · ▲ 47.0% · ■ 53.0%       │  HUD bottom moves under the map as a strip
│ ✓ hash matches the chain                 │
│ [ Verify this colony         ] full width│
│ [ Watch the round live       ] full width│
│ [Momentum][Community][Agents] scrolls →  │
└──────────────────────────────────────────┘
```

At 390px, 72 cells × 5px = 360px, so the map is centred with 15px of soil each side. That fits the whole-pixel rule. The bottom HUD comes off the map because at 240px tall an overlay would cover piles. In How, the map is sticky at the top (240px plus the 32px strip), and the steps scroll under it as plain text. Built: the actions and the market title come before the map, so both buttons are on the first screen; the map starts below them.

## 3. Components

Everything exists except the four rows marked **new**.

| Part | Component | Change |
|---|---|---|
| Stage | `ColonyView` on one canvas | Sized at runtime to the whole-pixel rule; one instance for the scene |
| HUD top | `.sim-frame__hud` with `.sim-frame__tick` and `.pill` | Adds the round number and the status pill (`pillHTML`) |
| HUD bottom | `.sim-frame__hud--bottom` | Holds the trail-share row (`.opt` glyph + share from `liveShares`), the seed line, `.tag-forecast`, the scroll toggle |
| Colony tabs | `.forecaster` buttons | Unchanged; they sit under the map |
| CTAs | `.btn--primary .btn--lg`, `.btn .btn--lg` | Copy only |
| Verify | `.verify[data-state]` with `.hash-compare` (`hashCompareHTML`) | Placed under the stage, closed until the click |
| Ledger card | `.result` contents: `.vs-table--compact`, `.hash`, `.result__foot` | Loses the map (now in the stage) and moves to just after the scene (`.scene-result`) |
| How steps | `.how--story` items, plain text in `.how__step` | No cards; their copy is in §5 |
| **new** Scene wrapper | `.scene`, `.scene__hero`, `.scene__stage` (sticky), `.scene__under` | Layout in `web/app.css`; the page script sets the map's box and `--z` (0 to 1) as you scroll |
| **new** Seek | `seek(k, t)` in the page script | Steps forward, or re-makes the colony and steps from tick 0 when time goes back. No snapshots needed at 60 ants × 300 ticks |
| **new** Pile spotlight | `view.focusSource = s` in `ColonyView` | Draws that pile's existing score ring (`drawRings`) at full opacity with a little more fill and fades the others' rings. Set from hover or focus on a `.vs-row` or a HUD share. Reads state only |
| **new** Scroll toggle | `.seg` with one `aria-pressed` button, "Scroll drives time" | Neutral; remembered in `localStorage` |

## 4. Motion

All stage motion follows the design system's §Motion. These rules add to it.

1. **Autoplay once.** The hero plays the shown colony from tick 0 at 1× (12 ticks/s, 25 s) when the page loads, only while the stage is on screen, then holds the final frame with the celebrate effect (`celebrate()` already fires at the last tick). It never loops. The other two colonies step silently alongside so their tab shares are live, as now.
2. **The hash lands with the last tick.** At tick 300 the HUD's line turns from `checking…` to `✓ hash matches the chain` (`--ok`) or `≠ hash differs` (`--fault`), from `result().hash` against `chainHash`. No other green or red is on the stage.
3. **Scroll owns time in How.** While the toggle is on and the How section is in view, ticks come only from scroll position; autoplay stops. Scrolling up runs time backward by seeking, not by reversing. With the toggle off, How shows each step's checkpoint frame as a still (0, 200, 300, 300 with hash).
4. **Ants move with the sim.** The gait, crumbs and ripple run while ticks advance. During a scroll hold they stand still, since the sim isn't stepping.
5. **Spotlight is instant.** The ring brightens on the next frame. Nothing outside the canvas glows.
6. **The UI follows the design system.** Panels and the Verify block open over 200ms. The copy scrolls at page speed. The one scroll-linked change is the zoom (Frame B): the map's box follows scroll position with a smoothstep, nothing runs on a timer, and under reduced motion it switches instead of growing.
7. **Swapping in the chain's data.** The recorded round 4 replays at once (§6). If the chain answers before tick 30, swap and restart at 0. After that, finish the replay and then swap. Never swap while the steps drive the map.
8. **Reduced motion.** No autoplay. The stage opens on the final frame with the hash line already resolved, and the scroll toggle defaults off (steps are stills). Ants snap to cells, the rings don't march (`still`), there is no celebrate effect, and the pill doesn't pulse. A text summary sits beside the map (§6).

## 5. Copy

**Eyebrow** (as now): `$ANTO · Ant Colony Oracle · NEAR testnet`

**Headline** (kept): **Ants vs. the market.**

**Line** (answers what, what decides, can I check):

> Ant colonies forecast Polymarket's trending markets inside a NEAR contract. Whichever outcome draws the most trail sets the swarm belief, a public drand seed drives every ant, and your browser re-runs them to check the hash.

Shorter alternative, if the line must fit two lines at 1200px:

> Ant colonies forecast Polymarket on NEAR. The trail decides, a public seed drives every ant, and you can re-run them here.

**CTAs:** `Verify this colony` · `Watch the round live`

**HUD**

| Slot | Copy |
|---|---|
| Top left | `Round 41 · Momentum · tick 0187/0300` (`Recorded · round 4 · …` for the fallback) |
| Top right pill | `Result final` · `Running · 2 of 3 cranked` · `Recorded result` |
| Shares | `trail share  ▲ Yes 47.0%  ■ No 53.0%` (the shown colony; the swarm belief is in the ledger) |
| Proof line | `seed 046e…b237 · checking…` → `✓ hash matches the chain` / `≠ hash differs · see which` |
| Tag | `Forecast · not advice` |
| Toggle | `Scroll drives time` |

**Under the stage:** `Will bitcoin hit … in October 2026 · Polymarket · 2 outcomes` (plain text, not a link), then the ledger card's existing copy.

**How the ants forecast, as the scroll story** (title and `.how__at` as now, body shortened to one or two lines each):

1. **A seed nobody picks** · `tick 0000` · Inputs close, then the next drand beacon is the seed. The contract checks its signature, so nobody on the team picks it.
2. **Three colonies forage** · `60 ants · 300 ticks` · Each colony has its own map with one food pile per outcome. Momentum reads odds and their 6-hour move, Community reads $ANTO stakes, Agents reads the agents' odds.
3. **Trails become the forecast** · `scored at 100, 200, 300` · The trail within 6 cells of each pile is summed at every checkpoint. The three colonies' shares, averaged, are the swarm belief.
4. **You check it** · `Rust = JS = Python` · Your browser just re-ran every ant from the chain's inputs. Same hash, same forecast. → `Verify this colony`

**Verify block**

- Title: `Checked in your browser`
- Line: `Momentum re-ran here in 41 ms from the chain's seed and inputs.` Then `.hash-compare` (chain, yours), the other two colonies' rows, the market hash, and `Open in Replay →` (`replay.html` for this round and market).
- Mismatch: `Your browser got a different hash for Agents. The differing groups are marked ≠. Re-run it in Replay or report it.`

**Demo mark:** a `.chip` reading `DEMO · illustration, not the sim`. It goes only on idle scouts and illustrations.

## 6. States

| State | First screen |
|---|---|
| **No JS** | The current static HTML: headline, line, CTAs (Verify links to `replay.html`), and round 4's recorded ledger card. No canvas. An optional static frame of round 4's final tick (cut list) |
| **Loading** (JS, chain not answered) | The stage replays **round 4's recorded inputs** at once. They are in the repo (`docs/example_market.mjs`: seed, odds, stakes, agent odds, hashes), so this is the real sim and needs no network. The HUD says `Recorded · round 4` and the pill `Recorded result`. The hash line compares with the recorded `cb34…9c3e`. `$ANTO today` shows `…` with `aria-busy`, as now |
| **Chain answered** | Swap per Motion rule 7 |
| **Chain unreachable** | Keep the recorded replay. Add the existing fault banner under the stage ("Couldn't read the contract … This card shows the recorded result from round 4." with Retry). Watch the round live stays a link |
| **No finished market yet** (first round, or the current one has no run and there's no previous one) | Stage shows the colony idling (`ColonyThumb.drawIdle(MOMENTUM, t)` at stage size) with the `DEMO` chip, and the HUD reads `Round 41 · waiting for its seed` with `waitNote(r)` as the proof line. Verify is disabled with `.why`: "Nothing to verify until a colony has run." If round 4's recording is available, prefer replaying it to idling |
| **Skipped round** | As now: `Skipped` pill and the skipped note. The stage replays the previous finished market if any, else idles (as above) |
| **Running market** | A market that is running but not finished is not chosen while a finished one exists. If it's the only one, replay each cranked colony; uncranked tabs are disabled ("queued"). The pill reads `Running · 2 of 3 cranked` |
| **Mismatch** | The proof line reads `≠ hash differs` in `--fault`, the verify pill reads Mismatch, and Verify opens straight to the diff |
| **Reduced motion** | Final frame, plus a text summary in `.visually-hidden` and visible beside the map on desktop, under it on phone: "Round 41, Momentum colony, final tick 300 of 300. Trail share: ▲ Yes 47.0%, ■ No 53.0%. Swarm belief across the three colonies: Yes 43.8%, No 56.2%. The hash your browser computed matches the chain." The canvas's `aria-label` carries the same text |

## 7. If time is short, cut in this order

1. **Static no-JS frame** of round 4 (an SVG from `docs/make_demo.mjs`'s approach). The no-JS card already works without it.
2. **Pile spotlight** across the page. Keep it only on the map itself, or drop it.
3. **Scroll-as-time.** Fallback: How steps show still checkpoint frames (the reduced-motion path), which needs only `seekTo`, already needed for swaps.
4. **Desktop full-bleed scenery** to the left of the map. Fallback: the map in the current two-column hero, at a larger size.
5. **The crossfade swap** (rule 7). Fallback: swap only after the recorded replay ends.

Never cut: real numbers in the HUD, the hash line landing at the last tick, Verify as the one primary, the recorded round 4 fallback, the reduced-motion final frame with its text summary, the 390px layout.

## 8. Open points to check while building

- `ColonyView` currently draws into a fixed 3:2 canvas (1080×720 here, 1440×960 in `Player`). Confirm it scales its cell size from the canvas size before relying on runtime sizing.
- `roundchain.mjs` notes the seed as "the block's random seed at the first crank, a stand-in for the drand commit" and reads `drand_round` from `round_status`. The HUD should name drand only when the round carries a `drandRound`; otherwise it shows just `seed …`.
- Community stakes and agent posts on testnet come mostly from the demo crew (`keeper/demo.py` personas). They are real on-chain inputs, so they don't get the `DEMO` mark. Docs already explains the demo crew; the hero needs no extra line.
