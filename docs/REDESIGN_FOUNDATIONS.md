# UI redesign: foundations and core components

Written 2026-10-29. Proposes v1 of the design system in `web/ds/`. It builds on `docs/REDESIGN_SCOPE.md`. **Implemented 2026-10-29 with direction A** (Nest and ledger): `docs/DESIGN_SYSTEM.md` is now the v1 reference and `/web/ds/showcase.html` shows every component below.

## 1. Rationale

- **Every colour does one job.** In v0 the option colours collide with status and brand. Measured as OKLab distance under Machado 2009 full-severity colour-blindness simulation:
  - ▲ moss vs mismatch red: 0.002, practically identical
  - ★ sand vs bone text and ants: 0.022
  - ▲ moss vs amber: 0.030
  - ◆ heather vs info blue: 0.034
- **v1 splits the hue wheel by job:**
  - amber is pheromone and brand;
  - green and red are status only;
  - the five options take the hues left over;
  - every other status is neutral grey with a glyph.
- **Options avoid green and red on purpose.** A green "Yes" and a red "No" read as a verdict, and a forecast must not look like advice.
- **Shape follows job, so colour is never the only signal:**
  - options: glyph ▲■◆●★
  - status: pill with glyph and word
  - wallets: ant swatch and account id
  - forecasters: their name in words
  - pheromone: a field, never a mark
- **Tone:** the stage (map, ants, scenery) is the one place with organic shapes, gait and charm. Outside it everything is a ledger: hairlines, small radii, tabular mono numbers, no animated numbers, no emoji.

## 2. Colour

### Jobs and their non-colour backup

| Job | Colour | Non-colour backup |
|---|---|---|
| Option 0 to 4 | Five hues (below), never green, red or amber | Glyph ▲ ■ ◆ ● ★ and the option's name, always. On the map, a glyph label on each food pile |
| Wallet-tinted staker ants | Any hue at low chroma, `oklch(0.74 0.045 h)` | Ant silhouette swatch beside the account id. Never fills a bar or an area. Spotlight halo only on request |
| Pheromone intensity | One amber ramp, lighter and more opaque = stronger | Cells view shows the value per cell on hover. The scent table gives numbers |
| Match | Green | ✓ and the word "Match", solid outline |
| Mismatch, error | Red | ✗ and the word, diagonal hatch fill, and the differing hash groups underlined |
| Paused | Neutral, inverted (bone fill) | ‖ and "Paused" |
| Stalled | Neutral | ! and "Stalled", dashed outline with hatch |
| Default action | Neutral | ↷ and "Default", dotted outline |
| Running, pending | Neutral | ◌ "Running" with the tick count; ○ "Pending" |
| Primary action | Amber | The only filled amber control in a view, with a verb label |

### Measured (OKLab ΔE, worst of normal, deutan, protan, tritan)

- **Options pairwise:**
  - worst pair ▲ aqua vs ★ lilac 0.090 (deutan);
  - next ◆ blue vs ★ lilac 0.095 (protan);
  - so every pair passes the v0 rule of 0.08.
- **Two-outcome markets** (▲ aqua vs ■ magenta, the most common case): 0.173.
- **Options vs status, amber and bone:**
  - every pair is at least 0.12 apart in normal vision.
  - Three pairs fall under 0.08 for one colour-blindness type, so their form carries them:

    | Pair | ΔE | Vision | What carries it |
    |---|---|---|---|
    | ● olive vs mismatch red | 0.039 | deutan | Pill vs glyph |
    | ● olive vs amber | 0.035 | protan | Pile vs trail field |
    | ▲ aqua vs bone ants | 0.035 | protan | Labelled pile vs moving dots |

- **Wallet tints vs options:** at least 0.085 in normal vision at every hue.
- **Contrast on `--surface-raised` (#28211a):** options 5.1 to 10.9, match 9.0, mismatch 4.7.

### Token table

| Token | Value | Job |
|---|---|---|
| `--soil-950` | `#0d0a07` | Map background |
| `--soil-900` | `#14100c` | Page |
| `--soil-800` | `#1d1812` | Panel |
| `--soil-700` | `#28211a` | Raised, hover |
| `--soil-600` | `#3a3026` | Hairline |
| `--soil-500` | `#7a6852` | Input border, 3.3:1 |
| `--bone-100` | `#efe6d8` | Text, ants, focus ring |
| `--bone-300` | `#b8aa95` | Muted text, neutral status |
| `--bone-500` | `#9a8b76` | Faint text, 4.8:1 |
| `--amber-400` | `#f2a541` · `oklch(0.78 0.144 69)` | Brand, the one primary action |
| `--amber-300` | `#ffc070` | Primary hover |
| `--amber-ink` | `#1a1006` | Text on amber |
| `--pher-1` | `oklch(0.62 0.126 66 / 0.35)` | Faint trail (map only) |
| `--pher-2` | `oklch(0.62 0.126 66 / 0.7)` | Weak trail |
| `--pher-3` | `oklch(0.78 0.144 69 / 0.85)` | Trail |
| `--pher-4` | `oklch(0.85 0.121 72)` | Strong trail, at the cap of 20 |
| `--opt-0` ▲ | `oklch(0.86 0.12 192)` · `#5eeae5` aqua | Option 0 (Yes in binaries) |
| `--opt-1` ■ | `oklch(0.68 0.17 340)` · `#da69b9` magenta | Option 1 (No in binaries) |
| `--opt-2` ◆ | `oklch(0.68 0.16 252)` · `#439bf7` blue | Option 2 |
| `--opt-3` ● | `oklch(0.70 0.16 120)` · `#92ac18` olive | Option 3 |
| `--opt-4` ★ | `oklch(0.80 0.105 290)` · `#bcb2fd` lilac | Option 4 |
| `--ok` | `oklch(0.80 0.15 150)` · `#6ed889` | Match. Status only |
| `--fault` | `oklch(0.66 0.20 28)` · `#f45246` | Mismatch, error. Status only |
| `--hold` | `var(--bone-300)` | Paused, stalled, default, running, pending |
| `--ok-tint`, `--fault-tint` | the colour at 12% alpha | Pill and row backgrounds |
| `--pattern-hatch` | `repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 6px)` at 25% | Mismatch, stalled, locked stake |
| `--wallet-l`, `--wallet-c` | `0.74`, `0.045` (was 0.72, 0.07) | Wallet tint `oklch(L C h)`, h from sha256(account) |
| `--focus` | 2px `--bone-100` ring, 2px `--soil-900` gap | Focus on any control. Not amber, so amber keeps its meaning |

Retired: `--lichen-400`, `--ember-400`, `--pollen-400` and `--water-400`. `info` and `warning` become neutral with a glyph.

## 3. Type

| Role | Face | Use |
|---|---|---|
| `--font-display` | Fraunces | Page title and market title only. The one place type is allowed character |
| `--font-ui` | IBM Plex Sans | UI, labels, prose (Live and Market already use it) |
| `--font-mono` | IBM Plex Mono | Hashes, seeds, account ids, every number, ticks, clocks, status glyphs |

Mono settings: `font-variant-numeric: tabular-nums slashed-zero` and `font-variant-ligatures: none`. Hashes are lowercase hex, shown in 4-character groups. Check that ✓ ✗ ‖ ↷ ◌ ○ render; fall back to a system symbol font where they don't.

| Token | Size / line | Use |
|---|---|---|
| `--text-2xs` | 11 / 16, mono caps, +0.08em | Eyebrows, column heads |
| `--text-xs` | 12 / 16 | Hints, pill text |
| `--text-sm` | 13 / 20 | Secondary text, hashes in tables |
| `--text-base` | 15 / 24 | UI and body |
| `--text-md` | 17 / 26 | Lede |
| `--text-lg` | 20 / 28 | Section titles (h3) |
| `--text-xl` | 26 / 32 | Section titles (h2) |
| `--text-2xl` | 34 / 40 | Page and market title (Fraunces) |
| `--text-3xl` | 46 / 52 | Landing headline (Fraunces) |
| `--num-lg` | 32 / 36 mono | The big number: swarm belief, the round clock |

## 4. Spacing and grid

- **Space** on a 4px base: `--space-1..9` = 4, 8, 12, 16, 24, 32, 48, 64, 96.
- **Grid:**
  - 12 columns, content max 1240px;
  - gutter 24px (16 under 600px), outer margin 24 / 16;
  - breakpoints 600, 900 and 1200.
- **Map sizes:** the 72×48 grid stays 3:2. The full stage is 720×480 at 10px per cell. Thumbnails are 216×144 at 3px per cell. Scale only by whole pixels per cell, so cells stay square.
- **Radii by job:** 4px for data (rows, inputs, option cards), 8px for panels and cards, 16px for the stage frame only, and 999px for status pills only.
- **Rows:** 32px compact, 40px default, 48px on touch.

## 5. Motion

- **Tick speed:** 1×, 4×, 16× and 128× are 12, 48, 192 and 1,536 ticks a second.
  - The default is 4×, so a forecast run of 300 ticks takes about 6 s.
  - A Burn day (43,200 ticks) takes 28 s at 128×.
  - A live run never plays past the tick the chain has reached.
- **Autoplay:** once, only while on screen, only for runs under 1,000 ticks. Burn days never autoplay.
- **UI motion:** 120, 200 and 360ms with ease-out. Nothing outside the stage takes longer than 360ms.
- **Numbers never move.** No count-up, no scrambling or typewriter hashes, no bounce on a match. A bar may ease to a new value over 200ms.
- **Charm lives in the stage:** six-leg gait, marching score rings, crumbs, and the ripple on the winning pile.
- **Live signal:** one 2s opacity pulse on the running pill's ◌, nothing else.
- **`prefers-reduced-motion`:**
  - no autoplay;
  - the stage opens on the final frame, or on the chain's current tick, with the scrub bar ready;
  - Play still works, but steps one scoring checkpoint (100 ticks) a second, with no in-between frames;
  - ants snap to cells, with no gait, rings, crumbs or ripple;
  - toasts appear without sliding, and the live pulse stops.

## 6. Voice

The ants can be charming. Numbers, hashes and money are stated plainly.

| | Do | Don't |
|---|---|---|
| Hash match | ✓ Match. Your browser computed the same hash as the contract. | 🎉 The ants agree! Verified! |
| Mismatch | ✗ Mismatch on Community. Chain `5861…4375`, your browser `9f3a…e21c`. Re-run, or report it. | Uh-oh, the ants got lost 🐜 |
| Belief | Swarm belief: ■ No 56.2%. Market odds 81.5%. Forecast, not advice. | The ants think No is 56% likely. |
| Stake | Stake 25 $ANTO on ■ No. Weight +5.0 (√25). Counts for round 41, refunded when round 42 opens. | Feed the ants some sugar 🍬 and help No win! |
| Stall | Stalled: no crank since 14:02 UTC. Anyone can crank; it pays 3.33 $ANTO. | The colony is taking a nap 😴 |

Charm is allowed only in the ant's own story, with the numbers still plain: "Ant 42 found ◆ C at tick 118 and carried 3 crumbs home."

"Drop sugar" is the brand verb and may appear in headings. Buttons and amounts always say "Stake".

## 7. Naming

| Word | Means | Don't say |
|---|---|---|
| **Round** | The scheduled cycle, about 25 minutes, of up to 12 trending markets that share one seed | epoch, batch, cycle, session |
| **Request** | A forecast someone paid for on one market they chose, with its own seed and clock | commission, job, order, bet |
| **Run** | One colony from seed to final tick, ending in one hash. A round has up to 36, a request 3, a Burn day 1 | simulation, sim, game, match |
| **Colony** | One map: a nest, food sources and ants | hive, sim. Not "swarm", which only ever means the combined belief |
| **Forecaster** | One of the three ways a market is read: Momentum, Community, Agents. Each has its own colony on every market | lens, model, oracle |
| **Ant** | One simulated ant | agent, bot, worker, scout |

Supporting words, fixed with these:

- **Day:** the Burn's round, one UTC day and one run.
- **Crank:** a call that advances a run.
- **Agent:** an account that posts its own odds into the Agents forecaster. This replaces "forecaster agent", so "forecaster" never means a person or a bot.
- **Swarm belief:** the mean of the colonies that have input.

Code identifiers (`round_run`, `forecasters`) stay as they are. This applies to UI copy, Docs and the README.

## 8. Component catalog

### Shared state rules (every component)

- **Default** uses only semantic tokens.
- **Hover** raises the surface one step and moves the border to `--bone-300`. Data never moves on hover.
- **Focus** uses the `--focus` ring, and every interactive part is reachable by Tab.
- **Disabled** is faint text and border with a `not-allowed` cursor, and always a visible reason, for example "Staking closed at 12:00 UTC. Opens again 00:00."
- **Loading:**
  - values show as `…` in mono with `aria-busy`, and there is no shimmer;
  - an action shows ◌ and a verb ("Waiting for wallet…", "Confirming…").
- **Error** has a `--fault` border, ✗, what happened and what to do, and a Retry action where retrying makes sense.

The class column names what each component becomes in `web/ds/`. Some of these replace page-local classes.

### 8.1 Option card, with its cap (`.option-card`, replaces the Burn menu cards and the outcome select)

- **Anatomy:**
  1. Glyph chip (option colour and glyph).
  2. Label: the outcome, or the pot size such as "0.50% of treasury".
  3. Facts line: market odds, or burned and reward parts plus the handicap.
  4. Your stake on it, if any.
  5. Selection mark.
  6. The menu's cap, once per menu: "The contract caps the pot at 2.00% of the treasury."
- **Variants:** list (one row each, narrow panels), tile (a grid), legend (read-only), picked (the run's result, labelled "Picked", with a bone border).
- **States:**
  - Default: hairline border.
  - Hover: raised surface.
  - Focus: ring on the card, and the radio inside takes the arrow keys.
  - Selected: a raised fill and bone border, a ✓ and the text "Selected". No coloured edge.
  - Disabled: "Closed" or "Over your cap" with the reason.
  - Loading: facts show `…`.
  - Error: facts show "—", with "Couldn't read the menu" and Retry.

### 8.2 Colony stage with playback bar (`.stage`, `.playback`; wraps `ColonyView`)

- **Anatomy:**
  1. Header: the forecaster's name, the market or day, the run, and a short seed (hash display).
  2. Map at 3:2.
  3. Overlay: tick `0180 / 0300` and the leader (glyph, name, share).
  4. Score rings and pile labels.
  5. Playback bar:
     - play or pause;
     - step ← →;
     - jump to end;
     - speed `1× 4× 16× 128×`;
     - a scrub slider with a mark every 100 ticks (the scoring checkpoints) and, on live runs, a "chain is here" marker;
     - Nest | Cells view switch.
- **Variants:**
  - full (Market, Replay);
  - live (scrubbing stops at the chain's tick);
  - day (43,200 ticks, the axis in UTC time);
  - thumbnail (no playback bar; plays while on screen; for cards).
- **States:**
  - Default: paused on the final frame, or autoplaying under the rules in §5.
  - Hover: the ant under the pointer gets a bone ring, and the slider shows the tick.
  - Focus: the frame is focusable. Space plays, ← → steps, Home and End jump.
  - Disabled (before the seed): the idle nest, the bar greyed, and "The map appears when the seed is drawn, about 14:20 UTC".
  - Loading: "Replaying 12,000 / 43,200 ticks" with a bar, and a cancel.
  - Error: "Couldn't load this run's inputs" with Retry. If the hashes mismatch, the map still plays and a fault banner sits above it.

### 8.3 Round timeline stepper (`.stepper`, replaces `.lv-steps`, the day strip steps and `.rq-track`)

- **Anatomy:** one segment per step, each with a label, its UTC time and a state glyph; the one clock that matters beside it.
- **Variants:**
  - round: Staking → Agents post → Seed (drand #R) → Colonies run (n/36) → Result;
  - request: Request → Odds → Agents' window → Seed → Run → Result;
  - day: Staking 00–12 → Run 12–24 → Payout;
  - full (labels and times) or compact (segments only, for cards).
- **Step states:**
  - Past: ✓ with a muted segment.
  - Now: a bone segment, thicker, with ◌. Amber appears only on a button, when the user can act.
  - Next: a hairline.
  - Skipped: ✗ "Skipped", with the following steps greyed.
- **Component states:**
  - Hover on a step shows a tooltip with the exact time and the contract call behind it.
  - Focus goes to the stepper's help link. Steps are not buttons.
  - Disabled: none; a step that will not happen is shown as skipped.
  - Loading: hairline segments and "Reading the round…".
  - Error: the current segment gets the hatch, a Stalled pill appears, and a Crank action shows when anyone may crank.

### 8.4 Stake input with per-wallet cap and influence preview (`.stake`)

- **Anatomy:**
  1. Target: the option card it stakes on.
  2. Amount: a field with a $ANTO suffix, a slider, and quick picks 10 · 25 · Max.
  3. Budget meter: one bar of the 100 $ANTO wallet cap, split into stakes elsewhere (Burn, markets, requests; hatched where locked), this stake, and what's free. The text under it reads, for example, "35 locked on Burn until day 20756 pays. 65 free."
  4. Weight readout: "25 $ANTO → weight 5.0 (√25)". On top of an existing stake: "+25 adds +2.1, because weight is the square root of your total on this option."
  5. Influence preview: the option's food weight now vs with this stake, as a bar with a ghost tick, plus "Your share of what Community follows: 12% → 19%". On Burn, the with/without colony preview.
  6. When it counts: "Counts for round 41. Refunded when round 42 opens." or "Counts from day 20756 (after 12:00 UTC)."
  7. Primary button: "Stake 25 $ANTO on ■ No".
- **Variants:** market (refunded next round), Burn (locked until paid; preview colony), request.
- **States:**
  - Default.
  - Hover and focus on the slider and field.
  - Disabled, each with its reason:
    - no wallet (the button becomes Connect);
    - staking closed (with the next opening);
    - faucet already used and nothing left: "Your faucet claim is used and your balance is 0."
  - Loading: "Waiting for wallet…", then "Confirming…", with the inputs locked.
  - Error:
    - over the cap, inline: "20 over your 100 $ANTO cap. 35 is locked on Burn."
    - transaction failed: the message from the chain, and Retry.
  - Success goes to a toast.

### 8.5 Swarm vs market table row (`.vs-row` in `.vs-table`)

- **Anatomy:**
  1. Option (glyph and name).
  2. Market odds %.
  3. Swarm belief %.
  4. Gap: ▲ or ▼ and points, for example "▼ 25.3 pp", always neutral in colour.
  5. Trail share per forecaster (Momentum, Community, Agents), with "out" when one sits out.
  6. A dual bar: belief fill with the market as a bone tick.
  7. A "Leads" word on the leading row.
- **Variants:** full (Market page), compact (cards: option, belief, market), before the run (market odds only).
- **States:**
  - Default.
  - Hover highlights the row and that option's ring on the stage.
  - Focus applies when the row links.
  - Disabled: belief cells show "after the run".
  - Loading: `…`.
  - Error: "—" with the reason in the caption.
- **Rules:** the gap is never green or red, and the column head says "Swarm belief", never "probability" or "chance".

### 8.6 Forecaster chip (`.forecaster`)

- **Anatomy:** the name (Momentum, Community, Agents) in words, then optionally what it reads ("12 stakers", "3 agents", "odds +6h move"), and optionally its leader (glyph and share). It has no colour and no glyph of its own, so it can't be mistaken for an option.
- **Variants:** label; input count; tab (picks the colony on the stage, `aria-pressed`); sits out.
- **States:**
  - Default: outline.
  - Hover: raised.
  - Focus: ring.
  - Selected: bone fill with dark text.
  - Disabled, meaning sits out: dashed outline and "sits out · no stakes".
  - Loading: count shows `…`.
  - Error: "—".

### 8.7 Hash display with copy and badge (`.hash`)

- **Anatomy:**
  1. Label ("Market hash", "Seed").
  2. Value in mono, in 4-character groups, shortened to the first 8 and last 8 by default.
  3. Expand, to show the full 64 characters on two lines.
  4. Copy, which always copies the full value.
  5. Badge.
- **Variants:**
  - single;
  - compare: Chain and Your browser stacked and aligned, with every differing group underlined and marked ≠, so a mismatch is visible without colour.
- **Badges:** ✓ Match (`--ok`); ✗ Mismatch (`--fault` with hatch); ○ Not on chain yet; ◌ Computing.
- **States:**
  - Default.
  - Hover shows the full value as a title.
  - Focus: rings on Expand and Copy.
  - Disabled: "not on chain yet", faint.
  - Loading: groups show `····`.
  - Error: "Couldn't read". If the clipboard is denied, the value is selected and the hint says "Press ⌘C".
  - Copied: the button reads "Copied" for 1.5s, announced through `aria-live`.

### 8.8 Verify button with progress (`.verify`)

- **Anatomy:**
  1. Button: "Verify in your browser". It is primary only on Replay.
  2. Progress: a determinate bar and "Run 2 of 3 · tick 180 / 300", or "tick 12,000 / 43,200".
  3. Stop.
  4. Result line, for example "3 of 3 hashes match", linking to the compare table.
- **States:**
  - Default (idle).
  - Hover, focus.
  - Disabled: "Nothing to verify until the first crank".
  - Loading: progress shows and the button becomes Stop.
  - Error: inputs failed to load, with Retry.
  - Results: match; mismatch ("1 of 3 hashes differ", in fault, with "Which input differs" opening the compare view); partial ("2 of 3 · 1 not cranked yet", neutral).

### 8.9 Market card (`.market-card`, replaces `.lv-card` and Recruit's `.market-card`)

- **Anatomy:**
  1. Number, and a status pill.
  2. Title, the card's one link.
  3. Leader: glyph, name, belief %, and the gap to the market.
  4. Stacked belief bar with market ticks.
  5. Three thumbnail stages, each under its forecaster chip with its leader.
  6. Verify line in text: "✓ Verified in your browser · 3/3".
  7. "Forecast · not advice".
  8. Your stake, if any.
- **Variants:** current round; previous round; request (adds the requester and fee); before the seed (idle maps and when they come).
- **States:**
  - Default.
  - Hover: border to `--bone-300`, title underlined.
  - Focus: ring on the whole card.
  - Disabled, meaning skipped (no keeper quorum): pill only, maps hidden, with the reason.
  - Loading: title if known, soil plates, and `…`.
  - Error: mismatch shows ✗ in the verify line, the Mismatch pill and a fault-tinted border; a read error shows "—" with Retry.

### 8.10 Leaderboard row (`.board-row`)

- **Anatomy:**
  1. Rank (mono).
  2. Ant swatch and account id (shortened in the middle).
  3. Main figure ($ANTO earned).
  4. Second figure (days paid, on-time posts, cranks).
  5. A "you" label on your own row.
- **Variants:** Burn earners; agents (paid from request fees for on-time posts); crankers. There is no accuracy board, because nobody is paid for being right.
- **States:**
  - Default.
  - Hover: spotlights that wallet's ants if a map is on screen.
  - Focus: same as hover, from the keyboard.
  - Disabled: none.
  - Loading: `…`.
  - Empty: "No payouts yet. The first Burn pays after 24:00 UTC."
  - Error: Retry.

### 8.11 Bot row (`.bot-row`)

- **Anatomy:**
  1. Role (Keeper, Cranker, Agent, Staker).
  2. Account id.
  3. Last action and its age, for example `crank_round` · 40 s ago, linking to the transaction.
  4. Health pill.
  5. Earned $ANTO.
  6. Run by the team's daemon, or by the community.
- **Variants:** team daemon; community; demo crew (labelled "demo").
- **States:**
  - Default.
  - Hover, focus.
  - Disabled, for a retired bot: faint, with "last seen".
  - Loading: `…`.
  - Stalled: no action past its expected interval, so a Stalled pill appears.
  - Error: RPC error, with Retry.

### 8.12 Banner and toast (`.banner`, `.toast`, replace `.notice`)

- **Banner:** system state that persists until it's resolved. It sits at the top of the page or the section.
  - Anatomy: glyph, title, one line, one action (Retry, Crank, Why).
  - Tones:
    - neutral: testnet notice, drand late, round skipped;
    - fault: chain unreachable, hash mismatch;
    - hold: paused by the guardian.
- **Toast:** the result of the user's own action, bottom right.
  - Anatomy: glyph, line, and an optional transaction link.
  - Kinds: transaction sent, confirmed, failed; copied.
  - Toasts never carry system faults.
- **States:**
  - Default.
  - Hover pauses the toast's 5s timer.
  - Focus moves to the action.
  - Disabled: none.
  - Loading: a pending-transaction toast with ◌ that updates in place.
  - Error: a fault toast stays until dismissed.
  - Reduced motion: fade only.

### 8.13 Status pill (`.pill`, replaces `.chip--live`, `.verify-badge` and the drand chip states)

| Variant | Glyph and word | Colour | Pattern or border |
|---|---|---|---|
| Running | ◌ Running · tick 180 | hold | Solid hairline, one pulse |
| Pending | ○ Pending | hold | Hairline |
| Match | ✓ Match | ok | Solid |
| Mismatch | ✗ Mismatch | fault | Hatch fill |
| Paused | ‖ Paused | bone fill, dark text | Solid, inverted |
| Stalled | ! Stalled · 6 min | hold | Dashed, hatch |
| Default action | ↷ Default: skipped, refunded | hold | Dotted |
| Skipped | ✗ Skipped | hold | Hairline |

States: default; hover shows the detail as a title (since when, and why); focus applies only when the pill links; loading shows ◌ and `…`.

## 9. Two directions

**A. Nest and ledger (recommended).**
- Keep the warm soil darks and bone text.
- The stage is the only organic, textured, rounded area: scenery, gait, a 16px frame.
- Everything outside it is a ledger: Plex Sans, tabular Plex Mono, hairlines, 4 to 8px radii, no glows except focus.
- Fraunces only on page and market titles.
- Live and Market already work this way (`web/live.css`), so this extends them to every page and retires the v0 chamber look.

**B. Field station.**
- Cool graphite neutrals (`oklch(0.18 0.01 250)`) and white text.
- The stage becomes a lit specimen tray: warm soil appears only inside the map frame, so the ants and amber pop against a cool, instrument-like page.
- A grotesk replaces Fraunces.
- It reads as more credible as an oracle, and its screenshots are clearer.
- Costs:
  - every neutral, the scenery and the contrast table are redone, and the palette must be re-measured against new surfaces;
  - it loses the memecoin warmth the track rewards;
  - every page changes, not just the shared CSS.

**Recommendation: A.** About 16 days are left before the 14 November deadline. Two P0 pages are already halfway there. Most of B's seriousness comes from the rules (mono numbers, no animated numbers, neutral status, colour by job), and A adopts all of them.
