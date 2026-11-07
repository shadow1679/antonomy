# The nest: the front page

Written 2026-10-31. `web/app.html` shows the whole project as one cutaway ant base, painted in the colony map's own style. It is the app's home: the brand in every top bar links to it and it carries the standard bar. The landing page is `web/index.html`, which draws the same nest in a section of its own (`#the-nest`) with each chamber tag linking to `app.html#<chamber>`.

Built in `web/app.html` and `web/nest.css` (scoped to `body.nest-page`), with the pure layer `web/nest.mjs` (`web/test_nest.mjs`), the loader `web/nestchain.mjs` and the canvas `web/ds/nest-view.mjs` on the shared painters in `web/ds/earth-paint.mjs`. Checked in headless Chrome at 1440 px wide and 390 px wide, by keyboard, under reduced motion and with Check the receipts run against the live contract (round 38: 36 colonies and 12 market hashes matched).

## Layout

```
┌ brand ─────────────────────────────── $ANTO chip · [Enter the app] ┐
│ i NEAR testnet · play token. Every chamber is read from the contract │
│ One nest, the whole oracle.            lede                          │
│ ┌──────────── nest (canvas) ─────────────┐ ┌── panel ─────────────┐  │
│ │        sky · grass · ⌂ mound (Entrance) │ │ Pick a chamber       │  │
│ │ Guard ·      Workers' hall      Well ║ │ │  or: name, headline, │  │
│ │ Nursery   Queen's chamber   Granary  │ │ │  what it is, live    │  │
│ │              Forecast gallery  Burn pit│ │  rows, links, Back   │  │
│ └────────────────────────────────────────┘ └──────────────────────┘  │
│ Chambers (the text version)            Nest log · [Check the receipts]│
└──────────────────────────────────────────────────────────────────────┘
```

Two layouts, both pure data in `nest.mjs`: **wide** (120 × 80 nest units) from 720 px and **tall** (64 × 116) under it. The canvas is scaled by a whole number of pixels per unit (`nestScale`, 4 to 16, at the device pixel ratio up to 2). Under 1000 px the panel sits under the stage; under 1200 px (and in the tall layout) the name tags drop their numbers, which stay in the chamber list.

## Chambers

| Chamber | Stands for | Live numbers (read) | Drawn as |
|---|---|---|---|
| Entrance | wallets, faucet | faucet amount, the connected wallet's balance and stake, supply (`loadToken`) | the mound, cut open down to the entrance hall |
| Guard post | filters and caps | 2 to 5 outcomes, blocked topics, the keepers' 24 h volume floor (100,000 USDC), the stake cap (`stake_config`), the 2% burn cap, the keepers' quorum (`keepers`), the guardian pause (`is_paused`); requests accepted, turned away (skipped and refunded) and at the gate (`forecast_requests`, newest 50) | two guard ants; bars across the gate while paused |
| Nursery | work that hatches next | blue eggs: requests in their odds or agents' window; pink eggs: agents' posts on those requests and on this round's markets (`agent_snapshot` per market, re-read every 5 minutes) | heaps of pale eggs, 18 of each at most |
| Queen's chamber | the contract | round and phase (`loadRound`); one egg per round (8 at most), the last round's carrying its market hashes; the current one "being laid" | the queen (a long gaster) and a row of eggs; Check the receipts rings the newest laid egg ✓ green or ≠ red |
| Granary | treasury and staked pool | the treasury; held for others = the `stake-vault.antonomy`, `request-escrow.antonomy` and `agent-vault.antonomy` ledger balances; staked this round | a sugar pile (treasury over the starting supply) and a smaller pile (held over the treasury), square-root heights |
| Burn pit | burns | burned since launch, the last paid burn (nearblocks plus the archive, as the Pot page reads it), today's pot range (`daily_pot`) and phase (`burn_schedule`) | embers and a flame whose height follows the last pot's size on the menu |
| Forecast gallery | the round's markets | one cell per market of the round on show (12 at most); swarm belief's favourite vs the market odds' favourite | alcoves with the favourite's glyph; a bone glow where they differ |
| Well | randomness | this round's drand round, randomness requests and the newest one's status | a shaft from the surface to still water |
| Workers' hall | keepers, agents, crankers | keepers and quorum, registered agents, the request fee, its split and the agent deposit (`request_config`) | ants pottering in the hall |

## Flows

Tunnels are Catmull-Rom curves through the layout's waypoints (`smoothPath`); ants walk them by arc length (`pointAt`) with the map's tripod gait and a soft halo of lit earth, so brown ants read in the dark bores.

| Flow | From → to | Carries | Bursts when a poll sees… |
|---|---|---|---|
| stake | entrance → granary | a sugar crumb | more $ANTO held for others |
| burn | granary → burn pit | an ember (sparks on arrival) | the supply fall |
| submit | entrance → guard | a pale egg | a new request |
| admit | guard → nursery | a pale egg | a request's odds accepted |
| reject | guard → entrance | a pale egg | a request skipped |
| crank | workers' hall → queen | nothing | colonies cranked |
| seed | well → queen | a seed | the round's seed drawn, or a randomness request |
| hatch | nursery → gallery | a larva | a request done |
| result | queen → gallery | an egg | a new round |

A slow ambient trickle runs on every flow (`AMBIENT`). Under reduced motion the ants stand still along the tunnels, the grass and flame don't move, and the canvas is redrawn once a second.

## The log and the receipts

The nest log lists the contract's newest calls from the nearblocks indexer, in plain words ("keeper2 posted the trending markets' odds"). When the indexer lists nothing (as on 2026-10-31) or doesn't answer, it says so and shows what the chain dates itself: each request's ask and fate, the newest randomness request (`chainLog`). It also logs what this page sees change.

**Check the receipts** re-runs every cranked colony of the round on show (the last finished round until the current one runs), compares each colony hash and the market hash with the chain's, and logs one line per market. With nothing on the chain it re-runs round 4's recording (`landing.mjs`) and says so.

## States

- Before the chain answers: the chambers are drawn empty, the tags carry names only, the list keeps its descriptions.
- A read that fails leaves its rows at "—"; if nothing loads, a fault banner with Retry.
- Without JS: the title, the lede and the chamber list with descriptions.
- Keyboard: every chamber is a button (Tab, Enter or Space); Escape returns to the nest and the focus to the chamber. Hover and focus ring the chamber on the canvas in bone.
