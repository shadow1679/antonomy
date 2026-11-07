# Daily Pot page: design

Written 2026-10-30. This redesigns `web/pot.html` (formerly `burn.html`, the Burn page) for 1440 and 390 px wide. It is written for two people: a holder checking today's pot, and a first-time visitor with no wallet who gives it 30 seconds. It reuses the v1 tokens and components (`docs/DESIGN_SYSTEM.md`, Decisions and Components) and the Burn rules as deployed (`token/src/burn.rs`, `reward.rs`, `day.rs`, `burnrun.rs`; `crank_burn` and `execute_burn` in `contract/src/lib.rs`).

**Success test:** within 10 seconds a first-time visitor can say how much of today's pot burns, how much is shared, and who decides. Three things carry it: the answer sentence at the top of the pot card, the two numbers under it, and the pot meter.

## Decisions

### Where the brief differs from the contract

The brief assumed some mechanics the contract doesn't have. The design follows the contract. None of these needs a contract change.

| Brief | What the contract does | On the page |
|---|---|---|
| "The five options (or the real rule)" | Five pot sizes: 0.10, 0.25, 0.50, 1.00 and 2.00% of the treasury. The shared part is 0.08, 0.10, 0.12, 0.14 and 0.16%, and the rest burns. The cap of 2.00% is checked at compile time | Five option cards, ▲ ■ ◆ ● ★ |
| A claim button; claim pending, failed or already claimed | **There is no claim.** `execute_burn(day)` burns the burn part and pays every staker on the picked size in the same call. Anyone may call it from 24:00 UTC, and the daemon usually does within minutes. If nobody does, the next day's first `crank_burn` does it | The claim button becomes **Run the payout** (permissionless, about 0.02 NEAR of gas). The claim states become: payout due, sending, failed, already paid. A paid share is in your balance, with nothing to claim |
| A burn transaction and a share transaction | One transaction does both. It logs `EVENT burn …` and one `EVENT reward …` per wallet | One "Payout transaction" receipt, listing what it burned and what it shared |
| "Decree hash" | The run's `result_hash` | Labelled **Result hash**, as on every other page |
| The keeper stalls and the default split applies | The Pot has no keeper; crankers advance it. There is **no default split.** A run that starts late catches up (1,500 ticks a call). If a day's run hasn't finished when the next day's run starts (12:00 UTC the next day), that day is **skipped**: nothing burns, nothing is shared, and the pot stays in the treasury. Burn stakes unlock a day after the missed payout was due | Two states: **Stalled** (the cranks are behind, and anyone can crank) and **Skipped** |
| Paused by the multisig | A single `guardian` account (`treasury.antonomy-oracle.testnet`). The override multisig is out of scope. While paused, stake, crank and payout are blocked; withdrawing is allowed and the Burn lock is lifted | "Paused by the guardian" |
| "My stake, my influence, my estimated share" | Influence is by **√ stake**, then the size's handicap (×1.000, ×0.875, ×0.750, ×0.625 or ×0.500). The share is by **raw stake**, pro rata among the stakers on the picked size | Two different numbers, each saying which rule it uses |

### Rollover or skip: **skip** (the [CHOOSE] in the brief)

A skipped day stays skipped, and nothing rolls over.

- This is what the contract already does, so it needs no redeploy and no `Contract` struct change.
- A rollover would let one day's pot go over 2% of the treasury, which breaks the hard cap and the rule that the colony chooses an index, never an amount.
- Nothing is lost. The skipped pot stays in the treasury, and tomorrow's percentages apply to that slightly larger balance.
- Copy: "Day 20,756 was skipped: its run didn't finish before the next day's started. Nothing burned and nothing was shared; the pot stayed in the treasury. No rollover: tomorrow's pot is still at most 2.00%."

### Other choices

| Question | Decision | Why |
|---|---|---|
| What fills the stage before 12:00 | **A preview colony on a sample map** (`SAMPLE_DAY_SEED` in `web/sugar.mjs`). It reads the live `stake_weights` and shows staker ants: you tinted, everyone else as one "other wallets" row. A label on the stage: "Preview · sample map · today's map is drawn at 12:00 UTC from drand #R". The nest-only view (`.nest`) is retired | The brief says the colony is always the main view. The real map can't exist before the seed, so the preview says so on its face |
| Which pot the two numbers show before 24:00 | **The size leading so far,** as an estimate, with the range under it | A first-time visitor needs one pair of numbers, not five. The range keeps it honest |
| Estimated share | **Conditional only:** "If ◆ 0.50% is picked: about 174 $ANTO". It is never multiplied by a pick chance | An expected value reads like odds and a promise. Saying "if picked" is plainly true |
| Who runs the payout | The daemon, with the button shown to everyone once the payout is due | Anyone can run it, and showing that is part of the pitch |
| URL | Renamed from `burn.html` to `pot.html`; the page is retitled (see §8) | The route matches the nav label. Code identifiers stay as they are |

## 1. Rules the page keeps

| Rule | On the page |
|---|---|
| The colony picks a size and never an amount | The menu is five `.option-card`s with the cap stated once (`.option-cards__cap`): "The contract caps the pot at 2.00% of the treasury." |
| Say share, burn and estimate | UI words are **burn**, **share** (the part paid to stakers) and **estimate**. Not reward, payout amount, win or prize. A size is **picked**, never "won". `reward` stays in code |
| An estimate never looks like a promise | See §4 |
| Testnet play token | One line in the page head's meta: "Testnet play token. No mainnet." |
| Amounts say $ANTO | Every amount, every time |
| Leader so far is not the result | Always the words "Leading so far", the tick and "The pick is made at 24:00 UTC" |
| Works without a wallet | Everything except your part reads with no wallet. The rule sentence, the menu percentages and the cap are in the static HTML, so the 10-second answer reads even without JS |

## 2. Layout at 1440 px

12 columns, content 1240 px. Stage 8 columns, side column 4 (about 392 px).

```
┌ top bar · Live  Pot  Recruit │ Replay  Receipts │ Docs      [$ANTO chip] [Connect] ┐
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ DAY 20,756 · FRI 30 OCT                                                                    │
│ Daily Pot (Fraunces)            Every day an ant colony picks how big today's pot is.     │
│                                 Most of it burns. A small part is shared with the stakers │
│                                 on the size it picks. Testnet play token.                 │
├─ day strip (kept) ───────────────────────────────────────────────────────────────────────┤
│ 00:00 ════════════════════════ 12:00 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀────────────────── 24:00   now 18:40 │
│ ✓ Staking       ✓ Seed            ◌ Colony runs        ○ Final tick      ○ Paid           │
│   00:00–12:00     drand #5204411    tick 24,000/43,200   24:00            from 24:00     │
│   commits to #R   stakes frozen     chain at 23,100      pick known       anyone can run │
│ The colony is running. Pick at 24:00 UTC, in 5:20:00.               [Crank] (ghost, only │
│                                                                      when behind)        │
├────────────────────────────────────────────────────┬─────────────────────────────────────┤
│ STAGE (8 col)                                      │ TODAY'S POT                         │
│ Pot colony · day 20,756 · seed 9f3a…e21c          │ The colony picks the size at 24:00. │
│ ┌────────────────────────────────────────────────┐ │ Leading so far: ◆ 0.50%             │
│ │                                                │ │                                     │
│ │      map 720×480 (10 px per cell)              │ │ BURN (estimate)   SHARE (estimate)  │
│ │      piles ▲ ■ ◆ ● ★ with glyph labels         │ │ ≈ 3,087 $ANTO     ≈ 975 $ANTO       │
│ │      staker ants tinted                        │ │ [pot meter, 0 → 2.00% cap]          │
│ │  HUD: tick 24,000 / 43,200 · 18:40 UTC         │ │ ├▒▒█████████─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤ │
│ │       Leading so far ◆ 0.50% · 31% of trail    │ │  ↑share ↑burn            cap 2.00%  │
│ └────────────────────────────────────────────────┘ │ If ◆ 0.50% is picked, at today's    │
│ [▶] ← → ⇥  1× 4× 16× 128×  scrub ──|chain──|now   │ treasury of 812,400 $ANTO.          │
│ Nest | Cells                                       │ Any size: 162–14,948 burn,          │
│ Calm summary (text, aria-live polite):            │ 650–1,300 shared.                   │
│ "Day 20,756, 18:40 UTC, tick 24,000 of 43,200.    │ From the treasury. Cap 2.00%. ›     │
│  Leading so far: ◆ 0.50% with 31% of the trail,   ├─────────────────────────────────────┤
│  then ■ 0.25% with 24%. 12 wallets staked 640     │ YOUR PART                           │
│  $ANTO. The pick is made at 24:00 UTC."            │ (no wallet: one line + Connect)     │
│                                                    │ Your stake   25 $ANTO on ◆ 0.50%    │
│                                                    │ Influence    weight 5.0 (√25)       │
│                                                    │              29% of what feeds ◆    │
│                                                    │              handicap ×0.750        │
│                                                    │ Est. share   ≈ 174 $ANTO            │
│                                                    │              if ◆ is picked         │
│                                                    │ Locked until day 20,756 pays.       │
│                                                    │ [Stake for tomorrow] (primary)      │
├────────────────────────────────────────────────────┴─────────────────────────────────────┤
│ THE FIVE SIZES · drop sugar                                                              │
│ ┌▲ 0.10%──────┐┌■ 0.25%──────┐┌◆ 0.50% ✓yours┐┌● 1.00%──────┐┌★ 2.00%──────┐            │
│ │burn 0.02%   ││burn 0.15%   ││burn 0.38%    ││burn 0.86%   ││burn 1.84%   │            │
│ │share 0.08%  ││share 0.10%  ││share 0.12%   ││share 0.14%  ││share 0.16%  │            │
│ │×1.000 · 3 w ││×0.875 · 4 w ││×0.750 · 5 w  ││×0.625 · 0   ││×0.500 · 2 w │            │
│ └─────────────┘└─────────────┘└──────────────┘└─────────────┘└─────────────┘            │
│ The contract caps the pot at 2.00% of the treasury.                                      │
│ Stake panel (.stake, Burn variant): amount, 10 · 25 · Max, budget meter, weight,         │
│ when it counts, with/without preview toggle on the stage above.                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ RECEIPTS · day 20,755 (last paid)               │ YOUR DAYS                              │
│ Seed            9f3a 1c2e … 4f10 e21c [⧉]       │ Day     Your stake  Picked   Your share│
│   from drand #5203117, signature checked        │ 20,755  25 on ◆     ◆ 0.50%  174.09    │
│ Stake snapshot  5861 …  4375 [⧉]                │ 20,754  25 on ◆     ■ 0.25%  — not     │
│ Result hash     a0c4 …  77be [⧉]  ✓ Match       │                              picked    │
│ Payout tx       8Hk2…Qp  burned 3,087.12        │ 20,753  —           ● 1.00%  —         │
│                 shared 974.88 to 5 wallets      │ Lifetime shared to you: 523.40 $ANTO   │
│ [Verify from seed] → replay.html?colony=burn&day=20755                                   │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ PAST POTS (table) · ▸ $ANTO facts (folded) · ▸ Top earners (folded)                      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Above the fold at 1440×900:** top bar (56) + page head (about 72) + day strip and stepper (about 120) + the stage at 720×480 with its head and playback bar (about 570) comes to about 840 px. So the whole stage, the stepper, all of Today's pot and the top of Your part are on the first screen. The answer sentence and the two numbers sit at eye level, right of the map.

**Hierarchy (reading order and DOM order):**

1. The page head: a one-line rule sentence (who decides, what burns, what is shared).
2. The day strip and stepper: where we are in the day.
3. The stage.
4. Today's pot, with its two numbers.
5. Your part.
6. The five sizes and the stake panel.
7. Receipts and your days.
8. Past pots, then the folded facts.

In the DOM, Today's pot comes right after the stepper so that screen readers reach the answer first. CSS grid places it beside the stage.

## 3. Layout at 390 px

One column. Gutter 16. The top bar is not sticky, and the nav is its own scrollable row.

```
┌ top bar ──────────────────── [chip][⚇]┐
│ Live  Pot  Recruit  Random  Replay …  │  nav row, scrolled to Pot
├───────────────────────────────────────┤
│ Daily Pot          Day 20,756 · 30 Oct│
│ ══════════ 12 ▀▀▀▀▀▀────────── 24     │  day bar
│ ✓ ✓ ◌ Colony runs  ○ ○   pick in 5:20 │  stepper compact: only the current step named
├───────────────────────────────────────┤
│ TODAY'S POT                           │
│ The colony picks the size at 24:00.   │
│ Leading so far: ◆ 0.50%               │
│ Burn ≈ 3,087      Share ≈ 975 $ANTO   │  both labelled "estimate"
│ ├▒▒███████─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤  │  pot meter
│ If ◆ is picked · today's treasury ›   │
├───────────────────────────────────────┤
│ Pot colony · tick 24,000 / 43,200     │
│┌─────────────────────────────────────┐│  full bleed: 360×240 (5 px per cell)
││              map                    ││
│└─────────────────────────────────────┘│
│ [▶] ← →  4× ▾  scrub ───|──|          │  speeds in one select
│ Leading so far ◆ 0.50% · 31% of trail │
│ Summary ▸ (the calm text, open by     │
│   default with reduced motion)        │
├───────────────────────────────────────┤
│ YOUR PART                              │
│ Stake 25 on ◆ · weight 5.0 · ≈ 174    │
│ if ◆ is picked (estimate)             │
│ [Stake for tomorrow] (primary, full)  │
├───────────────────────────────────────┤
│ THE FIVE SIZES (list variant, 48 rows)│
│ ◆ 0.50% · burn 0.38 · share 0.12 ✓    │
│ …                                     │
│ Stake panel                           │
├───────────────────────────────────────┤
│ RECEIPTS (hashes shortened, copy)     │
│ [Verify from seed]                    │
│ YOUR DAYS (one block per day)         │
│ PAST POTS · ▸ facts                   │
└───────────────────────────────────────┘
```

**Above the fold at 390×844:** top bar and nav row (about 96) + title and day line (40) + day bar and compact stepper (about 56) + Today's pot (about 150) + the stage (240) and its playback bar (44) comes to about 650 px. The answer and the whole map are on the first screen.

- Today's pot comes **before** the stage on phones. Both still fit, and the success test is about the numbers.
- The live summary is a `<details>`, closed by default and open by default under reduced motion. Live text that never stops would be noisy on a small screen.
- Tables become one block per row: Your days and Past pots. There is never horizontal scroll, and the page reflows at 320 CSS px.

## 4. Burned and shared: two numbers that can't be mistaken for a promise

The page shows amounts in three **tenses**. Each looks different, and none relies on colour.

| Tense | When | Type | Number | Bar | Words |
|---|---|---|---|---|---|
| **Rule** | Always | `--num-lg` only for the % | "0.50%", fixed by the contract | Tick marks on the meter track | "fixed by the contract" in the tooltip |
| **Estimate** | Before the payout | Body mono at `--text-lg`, never `--num-lg` | "≈ 3,087", whole $ANTO, prefixed "≈" | Segments **dashed outline**, no fill | Always "estimate" in the label, and a condition: "if ◆ 0.50% is picked, at today's treasury" |
| **Done** | After the payout transaction | `--num-lg` mono | "3,087.12", exact to 2 decimals, copyable | **Solid fill** | "Burned" / "Shared", the `✓ Paid` pill and the transaction link |

**Rules:**

1. **Only certain numbers are big.** Before the payout the large type holds the percentage (a rule). The $ANTO amounts take the large type only once the transaction has landed.
2. **Each estimate names its two conditions:** which size is picked, and the treasury balance. The pot is computed from the treasury when `execute_burn` runs, not at 12:00, so request fees and faucet claims move it. The condition line reads: "If ◆ 0.50% is picked, at today's treasury of 812,400 $ANTO."
3. **The range sits beside the leader.** Under the two numbers: "Any size: 162–14,948 $ANTO burn, 650–1,300 shared." The burn swings 90-fold; the shared part barely doubles. That one line explains the mechanism.
4. **Leading so far** is a separate line with the tick, and it never sits inside the number's label.
5. **The pot meter** (`.pot-meter`, new) is one track from 0 to the 2.00% cap.
   - Five ticks with glyphs mark the sizes, and the cap is labelled at the end.
   - The pot is drawn up to the leader's size (estimate) or the picked size (done), split into the shared part (the first 0.08–0.16%) and the burn part.
   - Share and burn differ by **form** as well as tone: share is `--bone-100`, burn is `--bone-300`, and the segment labels sit beside them.
   - Neither part is amber (brand), red (fault) or green (match). Burn is not a fault.
   - The meter is `aria-hidden`; the two numbers carry the meaning. Its segments are at least 3:1 against `--surface` (1.4.11).
6. **Your estimated share** shows the arithmetic in a tooltip and in Docs: "25 of the 140 $ANTO staked on ◆ × 974.88 $ANTO shared = 174.09. Changes as others stake until 12:00, and with the treasury until the payout."
7. **After the payout** the card swaps in place. The heading changes from "Today's pot" to "Day 20,756's pot · paid". The numbers become Done. A `✓ Paid` pill and the transaction link appear. The estimate wording disappears completely; it does not linger as a strikethrough.

## 5. Components

### Reused (`web/ds/`, `web/ui.mjs`)

| Component | Use here |
|---|---|
| `.page-head__split` | Title, the rule sentence, the testnet line |
| `.day-strip` (kept, per the brief) | The 00–24 UTC bar with the 12:00 marker and now |
| `.stepper` (day variant, full / `--compact`), `__clock` | Replaces `.day-steps`. Five steps (§6). Phones show the compact variant |
| `.stage`, `.sim-frame`, `.playback`, `.scrub--live`, `Player.setChain`, `ColonyView`, `.seg` (Nest / Cells) | The stage: day variant with a UTC axis, a "chain is here" marker and a "now" marker |
| `stakerAnts`, `walletColor`, `.roster`, spotlight | Staker ants on the preview and the live run. Clicking a roster row spotlights that wallet's ants |
| `.option-cards` (tile at 1440, `--list` at 390), `.opt-chip`, `__facts`, `__mine`, `__why`, `.option-card--picked`, `.option-cards__cap` | The five sizes; the picked one after 24:00 |
| `.stake` (Burn variant), `.budget` (locked part hatched), `.influence`, `__when` | The stake panel |
| `sugarPreview` (`web/sugar.mjs`) | The with/without toggle on the stage while staking |
| `.hash`, `hashHTML`, `installCopy` | Seed, stake snapshot, result hash |
| `.verify`, `.progress` | Verify from seed (a 43,200-tick replay with progress, Stop and the result line) |
| `.pill` (running, pending, stalled, paused, skipped, done, match, mismatch) | Step and payout status |
| `.banner` (`--hold`, `--fault`) | Paused, stalled, skipped, chain unreachable, mismatch |
| `.toast`, `toast()` | Stake, withdraw and payout transactions |
| `.btn` (one primary), `.why`, `.what` | Actions, disabled reasons, links to Docs |
| `.table`, `.board` | Past pots, top earners (folded) |

### New

| Class | What | Notes |
|---|---|---|
| `.pot` (`__answer`, `__lead`, `__nums`, `__cond`, `__range`, `[data-tense=estimate\|done\|skipped]`) | Today's pot card | The answer sentence first. `__nums` holds two `<dl>` items: Burn and Share |
| `.pot-meter` (`--leader`, `--picked`, `__share`, `__burn`, `__tick[data-opt]`, `__cap`) | Split bar on a track from 0 to the 2% cap | Dashed for estimates, solid when done; `aria-hidden` |
| `.est` | Estimate marker | "≈" + value + a visually hidden "estimate"; dashed underline; `title` with the condition |
| `.mine` (`__row`, `__action`) | Your part | Stake, influence, estimated share, lock, and one action: Stake, Run the payout or Withdraw. Without a wallet: one line and Connect |
| `.stage-summary` | Calm text summary | `aria-live="polite"`, `aria-atomic`. It updates only when the leader changes, every 3,600 ticks (one hour), or on a phase change; never every tick |
| `.day-receipts` | Receipts | Seed (+ drand round, "signature checked on chain"), stake snapshot hash, result hash with its badge, payout transaction (burned, shared, wallet count), Verify from seed |
| `.my-days` | Your days | Day, your stake and size, picked size, your share or "not picked", pre-handicap note. Lifetime from `rewards_earned` |

## 6. Stepper

The day as five steps: the brief's six moments, mapped onto what the contract does.

| Step | Brief's moment | Time | Under the label | Contract |
|---|---|---|---|---|
| Staking | committed | 00:00–12:00 | "seed commits to drand #R" (known from 00:00: the first drand round after 12:00) | `stake`, `burn_schedule().drand_round` |
| Seed | staking closed + published | 12:00 | "stakes frozen · drand #R" | The first `crank_burn` passes the signature; `freeze_burn`; `EVENT burn_seed` |
| Colony runs | advancing | 12:00–24:00 | "tick n / 43,200 · chain at m" | `crank_burn`, up to 1,500 ticks a call |
| Final tick | final tick | 24:00 | "pick known" | `burn_run().done`, `winner_option`, `result_hash` |
| Paid | finalized | from 24:00 | "anyone can run" → "burned X · shared Y" | `execute_burn(day)`, or the next day's first crank |

The stepper's clock shows the one time that matters now: "Staking closes in 2:14:05" · "Waiting for drand #R" · "Pick at 24:00 UTC, in 5:20:00" · "Payout due" · "✓ Paid 00:03 UTC".

## 7. States

Wallet-independent states change the pot card, the stepper and the banners. Wallet states change Your part. Day numbers, times and amounts below are examples.

| State | Trigger | Shown as | Copy |
|---|---|---|---|
| **No wallet** | Not connected | Your part: one line and a non-amber Connect. Everything else is fully shown | "Connect a NEAR testnet wallet to stake. Your first visit gets 150 $ANTO of play tokens, once." |
| **No stake** | Connected, no Burn stake | Your part shows the stake panel. Estimated share: "—" | "You have no stake on today's pot. Stake on a size to steer the colony and to share in the pot if that size is picked." |
| **Staking open** | 00:00–11:45 | Stepper: Staking now. Stage: preview on the sample map with staker ants. Primary: Stake | Stage label: "Preview · sample map · today's real map is drawn at 12:00 UTC from drand #5204411." Button: "Stake 25 $ANTO on ◆ 0.50%". When: "Counts for today, day 20,756." |
| **Staking closing** | 11:45–12:00 | The clock turns to minutes and seconds; `.why` under the button | "Staking closes at 12:00 UTC. A stake that lands after 12:00 counts from tomorrow; your wallet's confirmation will say which day." |
| **Staking closed for today** | 12:00–24:00 | Stake stays enabled, for tomorrow. Withdraw is locked | Head: "Today's stakes froze at 12:00 UTC." Button: "Stake for tomorrow". When: "Counts from day 20,757." |
| **Waiting for the seed** | Past 12:00, no `burn_seed` yet | Stepper: Seed now, ◌. Stage: the last preview frame, dimmed, with a veil | "Waiting for drand #5204411. The first crank brings its signature, and the contract checks it." If drand is late: "drand hasn't published #5204411 yet. Nothing can start until it does; nobody can pick the seed." |
| **Advancing** | Run started, not done | Stage: the real run. The page runs on to the clock tick and marks the chain tick. Pill: ◌ Running | Pot card: "Leading so far: ◆ 0.50% · 31% of the trail at 18:40 UTC. The pick is made at 24:00." |
| **Stalled** (brief: keeper stalled) | Chain tick more than 5,400 ticks (90 min) behind the clock, or no start by 13:30 | `.banner--hold`, the ! Stalled pill, and the Seed or Colony runs step hatched. Crank button (ghost) | "Stalled: the colony hasn't been cranked since 16:02 UTC. The page runs it ahead from the seed, so the map is still right; the chain needs a crank to catch up. Anyone can crank (about 0.02 NEAR of gas)." After 24:00: "Skipped at 12:00 UTC tomorrow if the run hasn't finished by then." **There is no default split.** |
| **Paused** | `is_paused` | `.banner--hold` inverted, ‖ Paused pill. Stake, crank and payout disabled with `.why`. Withdraw enabled | "Paused by the guardian at 14:10 UTC. Staking, cranks and payouts wait until it is lifted. You can withdraw your stake now; the Burn lock is lifted while paused." |
| **Final tick, payout due** | `done` and past 24:00, `last_burn_day` < day | Stepper: Paid now. Pot card: the pick and its amounts, still estimates (the treasury can still move). **Run the payout** shown to everyone | "The colony picked ◆ 0.50%. Anyone can now run the payout: it burns the burn part and pays the stakers on ◆ in one transaction." Button: "Run the payout for day 20,756". |
| **Payout overdue** | Due for more than 30 min | As above, and a hold banner | "Day 20,756's payout hasn't run yet. Anyone can run it. If nobody does, the next run starts at 12:00 UTC and runs it first." |
| **Payout sending** (brief: claim pending) | The user ran it | `.btn.is-loading`, pending toast | "Running the payout… Confirming." |
| **Payout failed** (brief: claim failed) | Transaction error | Fault toast, with Retry if the error can be retried | Not over: "The day isn't over until 24:00 UTC." Not finished: "The run isn't at its last tick yet. Crank it first." Other: "The payout didn't go through: {chain message}. Nothing was burned or paid. Retry." |
| **Already paid** (brief: already claimed) | `AlreadyBurned`, or `last_burn_day` ≥ day | Treated as success; the button disappears | "Already paid by `cranker.antonomy-oracle.testnet` at 00:03 UTC. Nothing more to do." |
| **Paid, with your share** (brief: finalized, claimable) | Paid; you staked on the picked size | Pot card in Done. Your part: share received | "Your share: 174.09 $ANTO, already in your balance. There is nothing to claim." |
| **Paid, your size not picked** | Paid; you staked on another size | Your part | "◆ 0.50% was picked; your stake was on ■ 0.25%, so no share this time. Your stake keeps counting for the next days until you withdraw it." |
| **Nobody staked on the picked size** | Picked size has zero raw stake | Pot card: Share in Done tense reads "0", with the reason | "Nobody staked on ● 1.00%, so its shared part, 1,137.36 $ANTO, stays in the treasury. The burn part burned as usual." |
| **Nobody staked at all** | Empty snapshot | Stage plays normally; the roster is empty | "No stakes today, so the colony ran on the flat base and the handicap alone; smaller pots are more likely. If nobody stakes on the size picked, its shared part stays in the treasury." |
| **Skipped** | `EVENT burn_skipped`, or a day with no payout once the next run starts | Stepper: ✗ Skipped on Colony runs, later steps greyed. Skipped pill. Your days row | "Day 20,756 was skipped: its run didn't finish before the next day's started. Nothing burned and nothing was shared; the pot stayed in the treasury. No rollover: tomorrow's pot is still at most 2.00%." Stakes: "Your stake unlocks at 24:00 UTC on 31 Oct, a day after the missed payout was due." |
| **Wallet cap reached** | `wallet_total` + amount > 100 | Inline error on the amount. The budget meter shows the over part. Button disabled with `.why` | "That's 20 over your 100 $ANTO cap. Your cap covers the pot, markets and requests together: 35 on the pot (locked until day 20,756 pays), 45 on market 3 (refunded when round 42 opens)." At exactly 100: "You've used your whole 100 $ANTO cap." |
| **Stake locked** | `burn_lock.locked` | Withdraw disabled with `.why` | "Locked until day 20,756's pot is paid, about 00:05 UTC. At the latest, unlocked at 24:00 UTC on 31 Oct if that payout never runs." |
| **Faucet used, balance 0** | `has_claimed` and balance 0 | Stake disabled with `.why` | "Your one faucet claim is used and your balance is 0. Withdraw a stake elsewhere to free tokens." |
| **Chain unreachable** | RPC error or rate limit | `.banner--fault`. Values show the last read with its time | "Can't reach the NEAR testnet RPC. Showing what we last read at 18:32 UTC. Retry." |
| **Hash mismatch** | Your browser's hash ≠ `result_hash` | `.banner--fault`; `.hash-compare` in Receipts | "✗ Mismatch on day 20,755. Chain `a0c4…77be`, your browser `9f3a…e21c`. See which input differs." |
| **Pre-handicap day** | Day < 20,755 | Your days or Past pots row note | "Ran under the first rules: no handicap, the whole pot burned." |

## 8. Names

The page now does two things with the pot: burn it and share it.

| Option | Page | Colony | For | Against |
|---|---|---|---|---|
| **A. Daily Pot** (recommended) | Daily Pot (nav: **Pot**) | **Pot colony** | Plain, and it matches the contract's `daily_pot` view, the landing page's "The daily pot" and the brief. Neutral between burn and share. Short in the nav | Less flavour |
| B. Burn & Share | Burn & Share | Split colony | States both outcomes in the title | "Split" suggests the colony sets the ratio, but it picks a size. Long in the nav. Keeps "burn" first, the framing the page is moving away from |
| C. The Larder | The Larder | Larder colony | Ant flavour: the treasury is the colony's store, and each day it decides how much to spend. Good for the memecoin track | Needs explaining, so it fails the 10-second test. The voice rules keep charm on the stage, not in labels |

**Recommendation: A.** The page answers "how big is today's pot and where does it go", and "Daily Pot" says that. The day keeps its name, **day** (the foundations' naming table). "Burn" stays as a verb ("burns 3,087 $ANTO"). Code identifiers (`BURN_COLONY`, `execute_burn`) stay as they are.

## 9. Accessibility (WCAG 2.1 AA)

- **1.4.1 Use of colour:** sizes carry glyphs. Share and burn on the meter differ by fill and by label. Status uses a pill with a glyph and a word. Estimates carry "≈" and the word "estimate".
- **1.4.3 and 1.4.11:** every token used is measured in `DESIGN_SYSTEM.md` (faint text 4.8:1, input borders 3.3:1). Meter segments and step segments are at least 3:1 against `--surface`.
- **2.2.2 Pause, stop, hide:** the live stage moves for more than 5 s, so it always shows Pause. Burn days never autoplay a replay; the live run follows the clock only while the stage is on screen and not paused.
- **Reduced motion** (`prefers-reduced-motion`):
  - The stage opens on the chain's tick and redraws once per checkpoint (100 ticks) with no in-between frames.
  - Ants snap to cells, with no gait, rings or crumbs.
  - Play steps one checkpoint a second.
  - The running pulse stops, and toasts fade.
  - The summary `<details>` opens by default.
- **Calm text summary:** `.stage-summary` (§5), polite, updated at most once an hour, on a leader change or on a phase change. The map has `role="img"` with `aria-describedby` pointing at it.
- **4.1.3 Status messages:** transaction toasts and payout states go through `aria-live`. The stepper's clock is not live; it is read when focused.
- **1.4.10 Reflow:** the 390 layout reflows down to 320 CSS px with no horizontal scroll. Tables become blocks.
- **Keyboard:**
  - Order: skip link, stepper help link, Today's pot, stage (Space, ← →, Home, End), Your part, the sizes as one radio group (arrow keys), receipts.
  - Focus is the bone ring.
  - Touch rows are 48 px.
- **3.3.1 and 3.3.3:** the cap error names the amount over the cap and where the rest of the budget is.

## 10. What has to be built

No contract change. Web only, with one data gap.

1. **Payout transactions the indexer misses.** `indexerBurns` (`web/burnchain.mjs`) lists `execute_burn` calls only. A day paid by the next day's first `crank_burn` has no row, so Receipts and Your days would show it as missing. Also read `crank_burn` transactions whose logs carry `EVENT burn day=`.
2. **Your days.** The per-wallet history reads each day's snapshot at the block before its payout (as `burnRow` already does). Cap it at the last 14 days and cache it like the past-pot rows. Lifetime comes from `rewards_earned`.
3. **Estimated share.** `stake_totals(0, 5)` (raw stake per size), `stakes_of(you)` and `daily_pot`. Influence comes from `stake_weights` and `BURN_HANDICAP`, as `sugar.mjs` already computes.
4. **Stalled and overdue thresholds:** 5,400 ticks behind and 30 minutes overdue, as constants in `web/burn.mjs` with tests.
5. **Stage before 12:00:** swap `.nest` for the preview `Player` on the sample map, fed by `sugarPreview(...).without` (and `.with` while the stake panel has an amount).
6. Update `docs/DESIGN_SYSTEM.md` (Burn page paragraph, components) and the nav label once built.

## 11. Cut first if time is short

In this order. Each cut leaves a working page.

1. **Your days via archival reads.** Keep the lifetime line from `rewards_earned` and link to Past pots.
2. **The with/without toggle on the stage.** Keep the single preview with your ants; the stake panel's weight line stays.
3. **The ant follow card** on the Pot map. Replay still has it.
4. **The pot sizes table and top earners.** The option cards already carry burn, share and handicap.
5. **The calm summary's hourly updates.** Keep it static per phase: "The colony is running; the pick is made at 24:00 UTC".

**Never cut:**

- the answer sentence and the two numbers in their tenses;
- the stepper and the stage;
- the stake panel with the shared cap;
- Run the payout;
- Receipts with Verify from seed;
- the Paused, Stalled and Skipped states.

## 12. As built (2026-10-30)

`web/pot.html` with `web/pot.css` and `web/pot.mjs` (tests: `node web/test_pot.mjs`; the crank-paid days in `web/test_burn.mjs`). Where the build settled something the design left open:

- **Before 12:00 the two numbers show the range** ("≈ 198–18,195 burn, ≈ 791–1,582 shared, depending on the size picked"), since no real colony runs yet; a preview's leader on a sample map would read as a forecast of the pick. The leader's pair appears from the seed. Under the card, the day before in the done tense (or skipped).
- **The focus day** is the day before while its run is unfinished or its payout due (stages finishing, due, overdue); otherwise today. `potStage()` in `pot.mjs` decides it.
- **The live stage is its own small player** (`.pot-live`): Pause / Back to live, a `.day-track` with the chain's tick, Nest / Cells, and a link to Replay for scrubbing. The shared `Player` restarts from tick 0 on Play when at its limit, which would re-run 43,200 ticks, so it is used for the 800-tick preview only. The ant follow card is cut (§11, item 3).
- **Paused** shows as the banner only; the stepper's clock keeps the day's time.
- **Revised layout (2026-10-30, after review).** One progress bar: the 00–24 day bar is gone and the stepper's current step fills (staking by the clock to 12:00, the run by its tick); the clock sits beside the title. The pot card is now a strip at the top of a **stake card** beside the map, so staking happens next to the colony; the five sizes are a list in it (burn and share if picked, staked, a "leading" or "picked" tag), and the separate sizes section is gone. The **preview** no longer uses `Player`: the same canvas runs the sample map at 1× (12 ticks a second) with no end, and ants that reach a pile walk on instead of carrying food, so nothing is collected and no trail or leader shows until the real run at 12:00. Its with/without toggle is cut; the amount you type hatches your ants on it instead. **Staker ants** are open under the map, not a fold: the nest (one dot per ant, tinted by the wallet whose stake hatched it; hovering a wallet lights its dots and its ants on the map), then the grid of wallets. The **Your part card is gone**, since it repeated your row in that grid; what it alone had sits under the grid as **Your stakes**, shown only when the wallet holds a stake or shared in the last pot: per size held, the estimated share and Withdraw, then the lock line and the last pot's share. The tables in §8 and §9 that mention Your part now mean this block.
- **Indexer rate limits** (nearblocks answers with a message and no list) show as "indexer unreachable", not as "no payouts". The crank_burn list reaches back about three days (100 transactions).
- Thresholds: `STALL_TICKS` 5,400, `SEED_LATE_MS` 90 min, `OVERDUE_MS` 30 min, `CLOSING_MS` 15 min, `SUMMARY_TICKS` 3,600, in `pot.mjs`.

