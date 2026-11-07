# Forecast page: design

Written 2026-10-30. The Forecast page replaces Live's **Markets** and **Requested forecasts** sections with one list: the round's top 10 trending markets, then the community's requested markets. The round timeline sits on top. Static mock: `web/ds/forecast-mock.html` (serve the repo root, open `/web/ds/forecast-mock.html`, narrow the window under 600px for the phone layout). The mock's dashed top strip has a mock-only phase switcher (Staking … Result), also reachable as `#phase-ready,mk-1` (the second part scrolls to that market's card). Its colonies run the real sim from a sample round seed, so its maps and numbers agree.

## Decisions (2026-10-30)

| Question | Decision |
|---|---|
| Where the track record's numbers come from | **Build a scorer.** It replays resolved markets with the round rules and scores market odds and swarm belief against the result. The panel reads its output; the same scorer later runs on live rounds |
| How the swarm is scored | **Brier score only**, one number per side, with the line "Scored as if the trail shares were odds, only to compare them." No hit rate |
| Community slots | **No slots.** Anyone can request a forecast at any time for the fee. No contract change; "slots left" is gone from the design |
| Resolution date and status | **Keepers post both under the 2-of-3 quorum:** the end date in the market post, and a new `post_resolution` (proposed, disputed, resolved, 50-50) |
| Where the track record sits | **Under the lists, not on the first screen.** Until 20 markets are scored it is one quiet line ("Track record: 0 markets scored so far…"); from 20 the full panel (§5) takes its place there. The side column holds only Add a market, and on tablet and phone it comes after the lists |

**Success test:** within 5 seconds a visitor can say which market the swarm disagrees with most. Three things carry that: the list sorts by gap by default, a **Widest gap** line sits above the list, and every card ends in its headline gap as a large number on the right edge, so the eye can run down one column.

## 1. Hard rules and how the page meets them

| Rule | On the page |
|---|---|
| Colony output is "swarm belief", never probability or advice | The column head says "Swarm belief". The persistent line says it is a trail share, not a probability. It is the list's one forecast label: sticky, so it is in view beside every card, and the cards carry no `.tag-forecast` of their own (decided 2026-10-30, to stop repeating it 30 times). The market page keeps its `.tag-forecast` |
| Persistent "forecast display, not betting" line | `.fc-line`, sticky under the top bar on every width, never dismissible |
| No links to betting sites | Questions link to our own market page only. The source is plain text ("Polymarket · `fed-decision-in-december`"), never a link. A pasted Polymarket link is parsed to a slug and never shown back as a link |
| No payout language | Nobody "wins" here. Gap, not "edge". "Scored better", not "beat the market". The fee "pays for work". Banned words: bet, wager, payout, win, edge, value, odds to win, profit |
| Honest track record | Under the lists (decided 2026-10-30): one line with the scored count until 20 markets are scored, then the full panel. Its headline is chosen by the data (e.g. the market's own odds scored better than the swarm). It never folds, and it shows the count still waiting |

## 2. Layout

### Desktop (≥ 1200px, 12 columns)

```
┌ top bar ───────────────────────────────────────────────────────────────────────┐
├ ◇ Forecast display, not betting · swarm belief is a trail share, not a        ┤ sticky
│   probability · not advice                                                     │
├────────────────────────────────────────────────────────────────────────────────┤
│ Round 41 · The seed is drawn and checked on chain. Each crank runs one colony. │
│ ✓ Staking    ✓ Agents post  ✓ Seed        ◌ Colonies run   Result   Colonies   │
│ 13:55–14:15  until 14:20    drand #5203117 one per call             cranked    │
│ ═══════════  ═══════════    ════════════  ▀▀▀▀▀▀▀▀▀▀▀▀▀  ─────────  29 / 30   │
├──────────────────────────────────────────────────────┬─────────────────────────┤
│ FORECASTS (h1, Fraunces)                              │ TRACK RECORD            │
│ Widest gap now: #3 Fed decision in December           │ The market's own odds   │
│   ▲ Cut · market 62 · swarm 41 · −21 pts   [Open]     │ scored better than the  │
│   [Momentum map] [Community map] [Agents map]         │                         │
│                                                       │ swarm.                  │
│ Sort [Gap ▾]    Show [All | Top 10 | Community]       │ Brier (lower is better) │
│ Momentum reads odds + 6h move · Community $ANTO …     │  Market  0.171 ▬▬▬      │
│ ┌───────────────────────────────────────────────────┐ │  Swarm   0.214 ▬▬▬▬     │
│ │ 3  Fed decision in December        ✓ Verified  −21│ │                         │
│ │    [Widest gap] Yes or No · resolves 10 Dec  ▲Cut │ │ 48 scored · 6 waiting   │
│ │ ┌──────┐┌──────┐┌──────┐  Outcome Market Swarm Gap│ │ (2 disputed)            │
│ │ │ map  ││ map  ││ map  │  ▲ Cut  55→62   41  −21 █│ │ How we score ›          │
│ │ └──────┘└──────┘└──────┘  ■ Hold 45→38   59 mirrors ├─────────────────────────┤
│ │ Momentum Community Agents                         │ │ ADD A MARKET            │
│ │ ■ Hold 62 ○ out    ■ Hold 56                      │ │ [paste link or ID    ]  │
│ │ ◇ Forecast · not advice · Polymarket · fed-…      │ │ Fee 100 $ANTO           │
│ │                  Market page: stake, follow an ant›│ │ you have 150 $ANTO      │
│ └───────────────────────────────────────────────────┘ │ [Request forecast]      │
│ ┌ 7  Champions League winner …            ✓    +14 ┐ │ Pays keepers, agents    │
│ │ …                                                 │ │ and crankers for work.  │
│ Left out this round: 3 ▸                              │                         │
│ COMMUNITY MARKETS · requested for a fee               │                         │
│ ┌ R12 Will ETH close above $4,000 …  2 of 3     +6 ┐ │                         │
│ │ …same card, "Market page: follow the request ›"   │ │                         │
└──────────────────────────────────────────────────────┴─────────────────────────┘
```

- Main column fills the width, side column 320px, sticky where it fits. The side holds the track record first, then Add a market.
- **Market cards, nothing to expand.** One list per section, one card per market. A card is: a head (rank, question as a link to the market page, a meta line with "Widest gap" flag, "yours", outcome count and resolution date, the run status, and the headline gap on the right edge as a large signed number with its outcome under it); a body with the three colony maps on the left and the outcome table (design B) on the right; and a footer line: the source as plain text, and "Market page: stake, follow an ant ›" ("Request page ›" on community markets). A two-outcome card is about 240px tall, a five-outcome one about 300px.
- **Ways to the market page:** the question, each of the three maps (opens the market page on that colony; needs `market.html` to read a colony parameter such as `&c=community`), and the footer link. Staking, following an ant and the hash checks live there.
- **Round timeline** (`.fc-round`, the design system's `.stepper`): one line saying what is happening now with the one clock that matters at its right end, then the five steps (Staking, Agents post, Seed, Colonies run, Result) with their UTC times (on a phone only the current step keeps its name). Clocks: "Staking closes in 06:12", "Agents' window ends in 02:40", "Waiting for the seed #5203117", "Colonies cranked 29 / 30", "✓ final". Under it one row: seed, receipts and the $ANTO staked on the round on the left; Demo limits, Auto-crank and Crank a colony on the right. No $ANTO strip: burn and balance are in the top bar's chip (removed 2026-10-30). The seed is a step of its own, so the moment nobody could know the outcome is visible. Requests run on their own clock and are not part of the round timeline; their rows carry their own status.
- **Widest-gap line:** one panel above the list, laid out like a card's head: on the left the label, the question, and the outcome with the largest |gap| with its market odds and swarm belief; on the right edge the gap in points as a large number with "See its colonies ↓" under it (on a phone the two stack, the gap and the link sharing one row). The link scrolls to that market's card (bone border and a "Widest gap" flag). No maps of its own; the card has them. Only markets whose three colonies have all run count, so a partial result never headlines the page (a partial market can still sort first, marked "so far"). Before the seed it reads "No gaps yet this round. The colonies run after the seed at 14:20 UTC."
- **The three colonies** (`.fc-cols`), always shown: Momentum, Community and Agents side by side in every card (144×96 canvases, 2 px per cell), each with its name and its leader with its trail share. What each reads is said once in a legend line above the list and in each map's tooltip. After the seed each map replays its run from the round seed (`ColonyThumb` on a real `Colony`, 4×, once, then holds the final frame; the final frame at once under reduced motion). With 40-odd maps on the page, only cards on screen step or animate (`IntersectionObserver`); a card's replay starts when it scrolls into view. Before the seed the maps show idle scouts (`drawIdle`) and say "Scouts waiting for the seed"; a colony not yet cranked stays idle with "○ not cranked yet"; a colony that sat out says "○ out · nobody staked" or "○ out · no agent posted".

### Tablet (900 to 1199px)

Same as desktop, but the side column drops under the page head as two panels side by side (track record | add a market), above the list.

### Mobile (< 600px)

```
┌ top bar (not sticky) ─────────────┐
├ ◇ Forecast, not betting · not     ┤ sticky, 1 line
│   advice · belief ≠ probability   │
├───────────────────────────────────┤
│ Round 41 · what's happening now   │
│ ✓Stak ✓Agen ✓Seed ◌Colo  Resu    │
│ Colonies cranked 29 / 30          │
│ FORECASTS                         │
│ Track record: the market's own    │
│ odds scored better than the swarm │
│ (Brier 0.171 vs 0.214, 48) ›      │
│ Widest gap: Fed decision in Dec   │
│ ▲ Cut  market 62 · swarm 41 −21   │
│ See its colonies ↓                │
│ [Gap ▾] [All | Top 10 | Community]│
│ ┌───────────────────────────────┐ │
│ │ Fed decision in December  −21 │ │
│ │ Yes or No · 10 Dec     ▲ Cut  │ │
│ │ ✓ Verified                    │ │
│ │ [map] [map] [map]             │ │
│ │ Momentum Community Agents     │ │
│ │ ■ Hold 62 ○ out  ■ Hold 56    │ │
│ │ ▲ Cut                         │ │
│ │ Market 55 → 62 · Swarm 41 −21 █│ │
│ │ ■ Hold                        │ │
│ │ Market 45 → 38 · Swarm 59     │ │
│ │ ◇ Forecast · not advice       │ │
│ │ Market page: stake, follow ›  │ │
│ └───────────────────────────────┘ │
│ …                                 │
│ Left out this round: 3 ▸          │
│ COMMUNITY MARKETS                 │
│ ADD A MARKET (full width)         │
│ TRACK RECORD (full panel)         │
└───────────────────────────────────┘
```

- The track record's one-line summary comes before the list and links to the full panel at the bottom, so the honest result is on the first screen at every width.
- Cards stack: the question with the headline gap beside it, then the status, then the three maps in a row (about 110px wide each), then one block per outcome (design B's phone form, below). There is never horizontal scroll. A two-outcome card is about 520px tall on a phone.

## 3. Five numbers per outcome: two table designs

Each outcome has five numbers: market odds now, market odds six hours ago, and the Momentum, Community and Agents trail shares. The swarm belief (the mean of the colonies that took part) and the gap (swarm − market) come from them.

### Design A: full ledger (what `.vs-table` does today)

```
Outcome      Market  6h ago  Momentum  Community  Agents  Swarm  Gap
▲ Cut         62.0    55.0     38.2       out      44.1   41.2  ▼ 20.8
■ Hold        38.0    45.0     61.8       out      55.9   58.8  ▲ 20.8
```

- Good: every number is exact, aligned and copyable, which suits a judge checking the chain.
- Bad: 8 columns. A five-outcome market is 40 numbers of equal weight. To find the disagreement the eye has to subtract two columns. On phones it scrolls sideways.

### Design B: gap ledger (recommended)

```
Outcome    Market         Swarm     Gap
           6h ago → now   belief    swarm − market
▲ Cut      55 → 62         41       −21 ████████▌|
■ Hold     45 → 38         59                    |  mirrors Cut
```

- Two numbers lead: market now and swarm belief. The six-hour move sits inside the market cell as "55 → 62". The gap is a diverging bone bar centred on zero, with its signed number. The three colonies' numbers moved out of the table into the maps beside it: each map shows its colony's leader and share, and the market page has every colony's share of every outcome.
- On phones each outcome is a two-line block: glyph and label; "Market 55 → 62 · Swarm 41 · −21" with the bar.
- Market, six hours ago and swarm stay in the table; the colonies sit beside it as maps. Only one thing in the table is heavy: the gap bar.

**Recommendation: B on the Forecast page.** The page asks "where does the swarm disagree", and B answers with a bar where A needs mental arithmetic. A stays on the market page as the exact, verified table (`.lv-checks`), where precision matters more than scanning. B rounds to whole points; the market page keeps one decimal.

The gap bar is never green or red (a forecast is not a verdict) and never amber (amber is brand). It is `--bone-300` on `--bg-canvas`, with the zero line in `--border-strong`.

### Two outcomes vs five

- **Yes/No and other two-outcome markets.** The two rows mirror each other (No = 100 − Yes in every column), so the card's headline gap names the first outcome only ("▲ Yes −21"). The table shows both rows, with "mirrors Yes" in the second row's gap cell instead of a second bar. Two team names work the same way.
- **Five outcomes.** Five rows in the keeper's order, not sorted by gap, so the glyphs stay in place between rounds. The card's headline gap names the outcome with the widest |gap|. The bar scale is shared across the whole page (±50 pts = full width), so a five-way market's gaps compare honestly with a binary's.
- **Grouped Other.** When an event has more than five outcomes, the keeper keeps the four most likely and folds the rest into Other (`group_other` in `keeper/trending.py`): 100 minus the four, for both now and six hours ago. Other is always the last row and carries ★. Its label reads "Other · the rest, folded", with a `.what` link: "The keeper keeps the four most likely outcomes and folds the rest into one food source." If Other's market odds are 0, the cell says "0 (floored)".

## 4. Cases

### Add a market

1. **Paste.** One field: "Polymarket link or market ID". On paste the page takes the slug out of `/event/<slug>` (or uses a bare slug) and looks it up through the Polymarket market search, which is the one allowed outside API read.
2. **Preview.** The question, its outcomes with glyphs (and Other if there are more than five), its resolution date, and the checks: open ✓, not decided ✓, allowed topic ✓, not already in the top 10 ✓.
3. **Cost line.** "Fee 100 $ANTO · you have 150 $ANTO." There is no slot limit. The fee split is the neutral `.fee-split` bar: keepers, agents, crankers, treasury. "Pays for the work. Nobody is paid for being right. Refunded if the keepers don't agree on the odds."
4. **One primary:** "Request forecast · 100 $ANTO". After signing, the market appears under Community markets, marked "yours", as "○ Waiting for keepers".

Blocked cases, each with the reason and the way forward:

| Case | Copy | Fee |
|---|---|---|
| Already in the top 10 | "Already forecast this round as #4. No fee needed." [Show it] | Not taken |
| Blocked topic (slug deny list, checked by the contract) | "We don't forecast markets about violence, deaths or private individuals." | Refused before any fee |
| Blocked topic the keepers catch later (by tag) | Row: "✗ Skipped: the keepers' filter left it out. Fee refunded." | Refunded |
| Closed or decided (top odds ≥ 97%) | "This market is closed or as good as decided, so there is nothing to forecast." | Not taken |
| Balance below the fee | "You have 40 $ANTO; a request costs 100." Faucet link if unclaimed, otherwise "The faucet is once per account." | Not taken |
| No keeper quorum | Row: "✗ Skipped: the keepers didn't agree on the odds. Fee refunded." | Refunded |

### Filtered-out markets

Under the top 10, a folded line: **"Left out this round: 3 ▸"**. When opened, it lists each market with its reason:

```
Topic not allowed (violence, deaths or private individuals)   title withheld
As good as decided (top outcome ≥ 97%)                         "Will the Fed hold in November?"
Ends within a day                                              "Lakers vs Celtics, Oct 30"
```

Content-filter cases never show their title, since that would put the excluded topic on the page. Every other reason shows the title, so the list can be audited. The reasons are the keeper's floors: 24-hour volume ≥ $100k, liquidity ≥ $50k, 1 to 90 days to the end, top odds below 97%, and the content filter.

### Disputed or ambiguous resolution

The resolution chip (`.res`) shows one of: Open · Closed, awaiting result · Result proposed · **Disputed** · Resolved: ▲ Cut · Resolved 50-50.

- **Disputed** (and Result proposed): the chip is `--hold` with a dashed border and "!": "Disputed · not scored until the result is final". The row stays in the list, its forecast is unchanged, and the track record counts it as waiting, never as scored.
- **Resolved 50-50 / N/A:** "Resolved 50-50 · not scored". It is left out of the track record and counted on its own line.

## 5. Track record panel

```
TRACK RECORD                                 SAMPLE BACKTEST
The market's own odds scored better than the swarm.

Brier score, lower is better
  Market odds   0.171  ▬▬▬▬▬▬▬▬▬
  Swarm belief  0.214  ▬▬▬▬▬▬▬▬▬▬▬

48 markets scored · 6 waiting (2 disputed) · 1 resolved 50-50, not scored
Scored as if the trail shares were odds, only to compare them.
How we score ›
```

- The headline is a sentence chosen by the data: "The market's own odds scored better than the swarm." / "The swarm scored better than the market's own odds." / "Too few markets to compare yet (under 20 scored)." It never shows a win rate or a streak.
- The two bars share one scale, are bone, and are never coloured by which did better.
- **The numbers above are placeholders** until the scorer runs (see §9). While they come from a backtest rather than live rounds, the panel carries a `SAMPLE BACKTEST` chip and the line "Markets from {dates}, replayed with the round rules."
- One metric only: the Brier score, the mean over markets of the squared distance between each side's numbers and the result (1 for the outcome that happened, 0 for the rest). Lower is better.
- Scoring is per market. It uses the swarm belief and market odds frozen at the round's seed and scores them against the final resolution the keepers posted on chain. Disputed, unresolved and 50-50 markets are excluded and counted.

## 6. Components

Existing (`web/ds/components.css`): `.tag-forecast`, `.pill`, `.opt` / `.opt-chip`, `.delta`, `.banner`, `.btn` (one primary), `.why`, `.seg`, `.fee-split` (Recruit), `.forecaster`, `.stepper` (round timeline), `ColonyThumb` (`attach`, `draw`, `drawIdle`), `.what`, `.hash`.

New:

| Class | What | Notes |
|---|---|---|
| `.fc-line` | Persistent forecast line | Sticky, one line, `role="note"`; on phones it shortens |
| `.fc-round` | Round timeline | Head line with the clock (`__clock`), `.stepper__steps` with `__at` times, `__foot` (facts left, actions right) |
| `.fc-widest` | Widest-gap line | Question, outcome, market, swarm, gap, "See its colonies ↓" (anchor to the card); finished markets only |
| `.fc-cols` | The three colonies | Always on; each map is a link to the market page on that colony: canvas (144×96), name, leader or why not; what it reads in the `title` |
| `.fc-tools`, `.fc-legend` | Sort, filter, legend | `.seg` for All / Top 10 / Community; sort `select`: Gap (default), Resolves soonest, Trending rank; one legend line says what each colony reads |
| `.fc-list`, `.fc-card` (`.is-widest`, `.is-skipped`) | Market card | `__head` (`__n`, `__q` with meta and `.fc-flag`, `__status`, `__gap`), `__body` (`.fc-cols` beside `.fc-table`), `__foot`; `id="mk-…"` for anchors; nothing expands |
| `.gap-bar` (`--gap`, −50…50) | Diverging bar | Bone on canvas, zero line; `aria-hidden`, the signed number beside it carries the meaning |
| `.fc-table` | Design B | Four columns; `caption` names the market for screen readers and shows only notes ("so far", "sat out"); `__move` for "55 → 62"; `__mirror` |
| `.res` (`[data-state=open\|closed\|proposed\|disputed\|resolved\|void]`) | Resolution chip | Date in mono; disputed dashed with "!" |
| `.fc-left-out` | Filtered-out fold | `<details>`, reasons, withheld titles |
| `.fc-add` | Add a market | Field, preview, checks, cost line, `.fee-split`, primary |
| `.track` | Track record | Headline sentence, one Brier bar per side, counts, method link, `SAMPLE BACKTEST` chip |

## 7. States

| Thing | State | Shown as |
|---|---|---|
| Page | Loading | Rows as `…` in mono with `aria-busy`; the persistent line and track record show at once |
| | Chain unreachable or rate limited | `.banner--fault`: "Can't reach the NEAR testnet RPC. Showing what we last read at 14:02 UTC." [Retry] |
| | Round skipped (no keeper quorum) | Timeline ✗ "Round 41 skipped: the keepers didn't agree"; the list shows round 40 under "Previous round" |
| | No run yet (Staking, Agents post, Seed) | Headline gaps read "–" with "gap after the seed at 14:20 UTC"; the widest-gap line says "No gaps yet this round"; every map shows idle scouts; the table shows market odds with "–" for the rest |
| Round timeline | Staking / Agents post / Seed / Colonies run / Result | The current step thick with ◌, past steps ✓; the clock as in §2. Skipped: the first step ✗ and the rest greyed |
| Market run status | Posting odds | ○ "Keepers posting" |
| | Staking open | ○ "Staking until 14:05" |
| | Agents posting | ○ "Agents post until 14:10" |
| | Waiting for seed | ○ "Waiting for drand #1234567" |
| | Running | ◌ "2 of 3 colonies" (pulse) |
| | Done | ● "Done", then ✓ "Verified" once the browser's hash matches |
| | Mismatch | ✗ "Hash differs" (hatched); opens the diagnosis on the market page |
| | Skipped | ✗ "Skipped · no keeper quorum"; no bar |
| Colony | Before the seed | Idle scouts, "Scouts waiting for the seed" |
| | Not cranked yet | Idle scouts, "○ not cranked yet"; the caption and headline gap say "so far" |
| | Playing / final | The real run at 4×, once, then the final frame; leader and its share |
| | Sat out | Map runs on an even map; "○ out · nobody staked" / "○ out · no agent posted"; the caption notes "mean of 2 colonies" |
| Resolution | Open / Closed / Proposed / Disputed / Resolved / 50-50 | `.res` chip; only Resolved is scored |
| Add a market | Empty / Parsing ◌ / Preview / Blocked (reason) / Signing ◌ / Sent / Waiting for keepers / Skipped, refunded | See §4 |
| Wallet | Not connected | The button reads "Connect a wallet to request" (not amber) |
| Track record | Sample / Live / Too few (< 20) | Chip and headline as in §5 |
| Community markets | Empty | "No requested forecasts yet. Paste a Polymarket link to add one." |

## 8. Copy

- **Persistent line:** "Forecast display, not betting. Swarm belief is how the colonies' trails split, not a probability. Not advice." Phone: "Forecast, not betting · not advice · belief ≠ probability".
- **Round timeline:** steps "Staking", "Agents post", "Seed", "Colonies run", "Result". Head line by phase: "Keepers have posted the odds. Stake $ANTO on an outcome to feed the Community colony." · "Staking is closed. Agents post their own odds for the Agents colony." · "Inputs are frozen. The seed comes from drand round #{R}, which nobody knows yet." · "The seed is drawn and checked on chain. Each crank runs one colony." · "Every colony has run. Your browser re-runs them and checks the hashes."
- **Colonies:** names "Momentum", "Community", "Agents"; reads "Market odds and their 6h move", "$ANTO stakes", "The agents' median odds" (map tooltips). **Legend:** "Three colonies per market: Momentum reads the odds and their 6h move, Community reads $ANTO stakes, Agents reads the agents' median odds. Click a map to watch it on the market page."
- **Page title:** "Forecasts". **Lede:** "Three ant colonies read each market and lay trails. The gap is where their trails split from the market's odds."
- **Widest gap:** "Widest gap now: {question}. {glyph} {outcome} · market {m} · swarm belief {s} · {gap} pts · See its colonies ↓". The card's flag: "Widest gap".
- **Sections:** "Top 10 trending" ("Picked by 24-hour volume on Polymarket, read by three keepers.") · "Community markets" ("Requested by anyone for a {fee} $ANTO fee."); your own carry a "yours" tag
- **Column heads:** "Outcome" · "Market" (sub: "6h ago → now") · "Swarm" (sub: "belief") · "Gap" (sub: "swarm − market").
- **Other:** "Other · the rest, folded". **Mirror:** "mirrors {first}". **Sat out:** "out" (title: "No stakes, so Community sat out of the swarm belief").
- **Card footer:** "Polymarket · {slug}" (plain text) · "Market page: stake, follow an ant ›" (community markets: "Market page: follow the request ›", to `market.html?r=<id>`).
- **Left out:** "Left out this round: {n}" · "Topic not allowed (violence, deaths or private individuals) · title withheld".
- **Disputed:** "Disputed · not scored until the result is final."
- **Track record:** see §5. Method link: "How we score".
- **Add a market:** head "Add a market"; field "Polymarket link or market ID"; button "Request forecast · {fee} $ANTO"; fee line "Pays keepers, agents and crankers for their work. Nobody is paid for being right. Refunded if the keepers don't agree."

## 9. What has to be built

**Built 2026-10-30:** the page itself in `web/live.html` (cards from `web/forecasts.mjs`, tested in `web/test_forecasts.mjs`), the `.gap-bar` component, and item 7 (`market.html` reads `&c=`). What differs from the drawing until the items below land: no resolution date, `.res` chip or "Resolves soonest" sort (item 1); the track record says nothing is scored yet (item 2); the left-out fold is hidden (item 5); Add a market (built in `web/addmarket.mjs`, see `docs/RECRUIT_PAGE.md`) also takes search text, shows up to five hits, and links a sent request to `recruit.html#request-N`; the list shows the previous round's cards until this round's colonies run, and the newest six requests.

CLAUDE.md requires forecast inputs to come from the chain. These changes come before the page can be built as drawn.

**Built 2026-10-31 (docs/FORECAST_QUALITY.md):** items 1 and 2. Keepers post resolutions and end dates (`post_resolutions`, `keeper/resolve.py`), the contract keeps the scorebook and `score_market` scores every source; the track record reads `score_tally`. It scores live rounds only: there is no backtest yet, so the `SAMPLE BACKTEST` chip never shows. The end date is on chain (`resolution(market_id).end_ms`) but the cards don't show it yet.

**Decided (see Decisions):**

1. **Resolution date and status on chain.** The keeper reads Polymarket's `endDate` and resolution fields but posts neither. Keepers post the end date with the market, and a new `post_resolution(market_id, state, outcome)` with state proposed, disputed, resolved or 50-50, accepted when 2 of 3 keepers agree, like the odds. Each post stores a hash of the raw response, like `raw_hash`. **Redeploy risk:** a new field on the stored `Market` changes its encoding, and a code-only redeploy keeps state only if the stored layout is unchanged. Keep end dates and resolutions in their own storage keys, keyed by market id, and run the `live_state` test before deploying.
2. **The scorer.** The repo has no scorer and no backtest (`BRIER_NOTE` in `web/ui.mjs` says so for agents). It takes each market's frozen market odds and swarm belief, plus its on-chain resolution, and outputs the Brier score per side, the scored count, the waiting count (disputed among them) and the 50-50 count. It runs first as a backtest over past resolved markets with the round rules (the panel keeps its `SAMPLE BACKTEST` chip), then over live rounds once enough resolve. The panel shows "Too few markets to compare yet" under 20 scored.
3. **No slots.** Requests stay unlimited (`MAX_REQUESTS` is only the size of the id space). Nothing to build.

**Smaller, with defaults:**

4. **Top 10.** `MAX_TRENDING` is 12 (`token/src/market.rs`); run the keepers with `--count 10`.
5. **Left-out list.** The keeper drops filtered events without recording them. It should write its skipped events and reasons next to `--save-raw`, and the daemon post the count by reason. Until then the fold is hidden.
6. **Folded count in Other.** The keeper posts "Other" without a count, so the copy leaves the count out.
7. **Open the market page on a colony.** Each card's maps link to the market page with that colony selected. `market.html` reads only `?m=` today; add a colony parameter (`&c=momentum|community|agents`) that sets the selected map.
