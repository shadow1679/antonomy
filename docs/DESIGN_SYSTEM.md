# Antonomy design system (v0)

Code lives in `web/ds/`. Link `antonomy.css` and you get tokens, base styles and components. To see every component with working states, run `python3 -I -m http.server -d .` from the repo root and open `/web/ds/showcase.html`. The repo root has to be served because the showcase imports the real sim from `sim/js/antosim.mjs`.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Theme | Underground nest: dark soil, bone text, pheromone amber | Ties the UI to the sim and keeps the canvas as the main element |
| Colour mode | Dark only | One mode to build and contrast-check within the 14-day window |
| Format | Plain CSS custom properties and classes, no build step | The replay page is static and hosted for free |
| Type | Fraunces for headings and prose, IBM Plex Mono for UI, data, seeds and hashes | Display serif for character, mono for anything you compare or verify |
| Option colours | Earth palette (moss, clay, slate, heather, sand), each paired with a glyph | On-theme. Tuned to stay distinguishable under colour-blindness simulation |
| Shape | Organic-soft: radii 6 / 10 / 16, chambers as cards | Reads as nest chambers |
| Motion | Subtle: 120 / 200 / 360 ms, a pulse on live, a short reveal on verify | All motion stops under `prefers-reduced-motion` |

## Files

- `tokens.css` holds raw scales (`--soil-*`, `--bone-*`, `--amber-*`, status, `--opt-0..4`) and semantic aliases (`--bg`, `--surface`, `--text`, `--accent` and so on). **Components use only the aliases.**
- `base.css` has the reset, body, headings, `.prose`, text utilities and layout helpers (`.container`, `.stack`, `.cluster`, `.grid-auto`).
- `components.css` has every component listed below.
- `colony-view.mjs` is the sim canvas renderer (scenery, ants, effects). It imports the sim constants from `sim/js/antosim.mjs`.
- `colony-thumb.mjs` is a small, cheap colony view for overview cards (trail, glyph piles, ant dots).
- `antonomy.css` is the entry point. It loads Google Fonts and then the three files above. Without network, the font stacks fall back to system serif and mono.

## Rules

1. **Amber is reserved.** It means pheromone, the brand and the one primary action in a view. Never use it for an option or a status.
2. **Every option shows its glyph next to its colour** (▲ ■ ◆ ● ★ for options 0 to 4). Use `data-opt="n"` together with `.opt`. Never show an option by colour alone.
3. **Status needs a glyph and a word.** Examples: ✓ Hash match, ✗ Hash mismatch, ▲/▼ for deltas. Colour only reinforces the message.
4. **Hashes and seeds are always mono, copyable, and show their full value on hover** (`.hash` with a `title` and a `.hash__copy` button carrying `data-copy`). When truncating, keep the start and the end, as in `0x9f3a5c07…a3d9e21c`.
5. **Every forecast output carries `.tag-forecast`** ("Forecast · not advice"). Label the averaged number "Swarm belief" until calibration exists. Never link to trading venues.
6. **The colony picks an index, never an amount.** Menus render as `.option-card` radios with fixed values and show the cap.
7. **Wallet tints** use `oklch(0.72 0.07 h)`, where h is the first 2 bytes of sha256(account id) mod 360. Lightness and chroma are fixed so staker ants never outshine trails or food. Use `.wallet` with an inline `--wallet-hue`. Canvas code uses the same numbers. A **spotlight** is the one way to make a wallet's ants stand out, and only on request: hovering or pinning a roster row sets `ColonyView.spotlight`, which puts a halo in the wallet's tint under its ants and (with `dimOthers`) fades the rest to 28%. The tint itself never changes.
8. **Sim canvas colours:** soil scenery in `--soil-*` only, so it never competes with data. Pheromone is amber, running from `--amber-600` (weak) to `--amber-300` (strong), with alpha scaled to intensity. Food piles use `--opt-n`, and a label with the glyph sits on each pile. Ants are bone (or their wallet tint later) with a dark halo for contrast. A returning ant carries a crumb in the colour of the pile it visited.
9. **Scenery is decoration.** `colony-view.mjs` draws soil, roots, pebbles and the anthill from its own PRNG keyed by the seed. It only reads `Colony` state and never calls the sim RNG. The **Cells** view drops the scenery and shows the grid one pixel per cell, for anyone checking the raw trail.
10. **Canvas motion:** ants move smoothly between ticks with a six-leg gait, the scoring rings' dashes march while playing, crumbs pop at pickup and sink into the nest, and the winning pile ripples at tick 800. Under `prefers-reduced-motion`, ants snap to cells and none of these effects run.

## Contrast (WCAG, checked on `--surface-raised`, the lightest surface)

| Token | Ratio | Use |
|---|---|---|
| `--text` | 12.8 | Body |
| `--text-muted` | 7.0 | Secondary text |
| `--text-faint` | 4.8 | Labels, hints (passes AA) |
| `--accent` | 7.7 | Amber text and icons |
| `--on-accent` on amber | 9.1 | Primary button label |
| `--border-strong` on chamber | 3.3 | Input borders (passes the 3:1 rule for non-text UI) |
| `--opt-0..4` | 4.5 or more | Option glyphs and bars |

Options under colour-blindness simulation (Machado 2009 at full severity, then pairwise OKLab distance): the closest pair is moss and clay under deuteranopia, at ΔE 0.092. Any palette change must keep every pair at 0.08 or more under deutan, protan and tritan, and keep the glyphs regardless.

## Components

| Group | Class | Notes |
|---|---|---|
| Layout | `.chamber` (`--raised`, `--glow`, `--flush`), `__header`, `__title` | The card |
| Actions | `.btn` (`--primary`, `--ghost`, `--danger`, `--sm`, `--lg`, `--icon`, `.is-loading`, `:disabled`) | One primary per view |
| Tags | `.chip` (`--live`, `--drand[data-state=committed\|published\|late]`), `.tag-forecast` | |
| Feedback | `.notice` (`--info`, `--success`, `--warning`, `--danger`, `--forecast`) | |
| Options | `[data-opt=0..4]` with `.opt`, `.legend` | Sets `--opt-color` and `--opt-glyph` |
| Verification | `.hash`, `__value`, `__copy` (`.is-copied`), `.kv`, `.verify-badge[data-state=idle\|pending\|match\|mismatch]`, `.verify-panel` | Put `role="status" aria-live="polite"` on the live badge |
| Sim | `.sim-frame` (72:48), `__hud` (`--bottom`), `__tick`, `.playback`, `.scrubber`, `.seg` | JS sets `--progress` (0 to 100) on range inputs for the WebKit fill |
| Sim thumbnail | `ColonyThumb` in `colony-thumb.mjs` | `attach(colony)`, `afterStep()` after each `step()`, `draw(frac)`. For overview cards; reads Colony state only |
| Sim canvas | `ColonyView` in `colony-view.mjs` | `attach(colony)`, call `afterStep(fx)` after each `step()`, then `draw(frac, now)`. `draw` returns true while effects still need frames. `mode` is `"nest"` or `"cells"` |
| Results | `.share-bars` (`--compact` for small cards) with `.share-bar[data-opt]` (`--share`, `.is-winner`) | |
| Forecast | `.belief` (`--compact`: one line per outcome, for cards) with `.belief__row[data-opt]` (`--share`, `--market`), `__label`, `__value`, `__track`, `__fill`, `__market`, `__meta`; `.belief-key` | Swarm belief as a big number, its bar, and the market odds as a bone tick on the same track. Filled by `beliefBoard()` in `web/ui.mjs`. Always in a block with `.tag-forecast` |
| Decision | `.pick[data-state=pending\|final]`, `__value` | One colony's pick, large. Pending shows the current leader, muted |
| Ant autopsy | `.inspector`, `.compass` (`--heading` 0 to 15, 0 = east, clockwise on screen), `.ant-state[data-state]`, `.trip-log` (`li.is-current`, `li.is-future`, tick buttons), `.ant-picks` with `.ant-pick` (`aria-pressed`), `.ant-timeline` (`--ticks`; `__trip[data-opt]` with `--from`/`--to` and `.is-future`, `__head` with `--t`) | Trip data comes from `web/autopsy.mjs` (`antLives`, or `TripTracker` on a live colony; `notableAnts` for the picks) |
| Follow card | `.follow`, `__head`, `__id`, `__now`, `__stats`, `__crumbs` with `.follow__crumb[data-opt]`, `__go` | One ant on a live map, built by `followHTML()` in `web/ui.mjs`. Pages wire map clicks with `wireMapPick()`; the canvas rings the ant and tags it with its number |
| Staker roster | `.roster` with `.roster__row` buttons (`--wallet-hue`, `--ants` 0 to 1, `aria-pressed` when pinned), `__id`, `__ants`, `__meta`, `__bar` | Built by `stakerLegendHTML()`, made live by `stakerRoster(el, onSpot)` in `web/ui.mjs`: hover or focus spotlights, click pins |
| Forms | `.field`, `__label`, `__hint`, `__error`, `.input` (`aria-invalid`), `.input-group`, `.range` | |
| Staking | `.stake`, `__row`, `__readout` | Shows stake, √ weight and cap used |
| Menus | `.option-cards` (`--list`: one row per option, for a narrow panel) with `.option-card[data-opt]` and a radio | Selection comes from `:has(input:checked)` |
| Data | `.table-wrap`, `.table`, `.num`, `.col-swarm`, `.delta--up\|down\|flat` | Numeric columns are right-aligned |

## Page layout (`web/app.css`)

- **Shell.** `topbar()` and `footer()` in `web/ui.mjs` build every page's header and footer. The nav groups the doing pages (Live, Burn, Recruit, Sandbox) apart from the checking pages (Replay, Receipts), with Docs on its own at the end. A slim `.demo-strip` says there is no contract yet; Sandbox leaves it out because it never touches the chain. The footer lists the known limits. Under 760px the nav becomes its own scrollable row and the top bar stops being sticky.
- **Answer first.** The Live page opens like the Burn page: a compact head (`.page-head__split`, title beside the lede) and the round strip across the width (`.day-strip`: round and phase, the bar across the round with a marker where the colonies stop, the clocks, then `.day-facts` with the round seed, the round's shape and a link to its receipts). Then the forecast board (`.fc-board`): one `.fc-card` per market with a compact belief board (`beliefBoard(..., { compact: true })`, one line per outcome) and its four colonies drawn small (`.fc-thumbs`, `ColonyThumb` in `ds/colony-thumb.mjs`: trail, glyph piles, nest and ant dots, no scenery). The card's title link stretches over the card and opens `#market-<i>`: a back link and a tab per market with its current leader (`.fc-nav`, `.fc-tabs`), then the market's belief board and Community stakers beside the four full forecaster maps, with the per-forecaster table below. Only the open market has `ColonyView`s; every colony steps on the board either way. A compact "Today's burn" card (`.burn-teaser`: leader, countdown, share bars, links) closes the page. The Burn page opens with a compact head (`.page-head__split`: title beside the lede; the lede hides on phones) and the day strip across the width (`.day-strip`: day and phase, the bar from 00:00 to 24:00 UTC with a marker at 12:00, when stakes close and the seed is drawn, three steps under it in `.day-steps` with the current one lit, and the clocks). Under them, `.day-facts` holds the last burn (pick, amount, verify link), the day seed and a link to the history. While staking is open (00:00 to 12:00) the drop-sugar workbench comes next, because dropping sugar is the thing to do; from 12:00 the live colony comes first and drop sugar follows it. The colony section is `.burn-grid` (stage two thirds, panel one third): from 00:00 to 12:00 the staking view (the nest, `.nest`, with every ant waiting and staker ants tinted, and today's stakers under it, beside the scent so far; no map, since there is no seed yet), or from 12:00 to 24:00 today's colony (the map beside one card with the leader and the trail share, then today's stakes). The drop-sugar workbench shows the menu as `.option-cards--list` and folds the scent comparison away in `.scent-more`. Last comes the burn history (`.stats`, then a table with today's staking or running row first).
- **Ants are clickable everywhere.** Every full colony map takes a click on an ant: Live's market tiles and the Burn map show a follow card (and a `.sim-frame__hint` until the first click), Replay and Recruit follow it in their own panels. Every stakers list is a `.roster` that spotlights its wallet's ants on the map beside it (on Burn before 12:00, in the nest: `.nest[data-spot]`, with `.is-new` ants popping in as a wallet's sugar arrives). Live's board cards say who feeds Community (`.fc-card__fed`) and their thumbnails tint staker ants.
- **Recruit** (`web/recruit.html`) is a controls-first workbench: the agent account (its tint shown live) and the strategy as `.option-cards--list` with `.strategy-card`, then the plan as a `.pick`, a `Player` with the recruit's ants spotlit and followed, and the trail share. Below, "Run it for real" lists the kit's commands as copyable `.cmd` blocks in `.recruit-steps`, beside the play-token notice and the NEAR CLI call the kit signs.
- **Explanations live in Docs.** `web/docs.html` holds the page cards and every explanation, as `.terms` lists under an on-page index (`.docs`, `.toc`). Other pages keep a one-line lede and at most a short hint, and link the rest with a `.what` link (`whatHTML(anchor, label)` in `web/ui.mjs`) to a Docs anchor. When you add an explanation, add it to Docs and link it; don't add a paragraph to a working page.
- **Workbench.** Tool pages use `.workbench`: a wide stage beside a 320 to 400px panel. Replay puts the stage first, like an inspector. Sandbox, drop sugar (on the Burn page) and Receipts put the controls first (`--controls-first`), because you set something up and then watch. `.workbench__col--sticky` pins a panel only where it fits the viewport.
- **Prose** (`.lede`) is set in Fraunces. Mono is kept for UI, data, seeds and hashes.
- **Keyboard.** Every `Player` takes space (play or pause), ← and → (one tick), and Home and End.

## Not done yet

- No light mode (by decision).
- Fonts load from Google Fonts. Self-host them if the replay page must work offline.
- The showcase runs the real sim (`Colony` from `sim/js/antosim.mjs`). Verify compares the browser's hash for seed-1042 with the Python reference, because there is no contract yet. Staker ants (wallet tints) are drawn by `colony-view.mjs` from `staker-ants.mjs`, not by the sim: they are view data, so the showcase colony has none.
