# Recruit page: design

Written 2026-10-30. The Recruit page (`web/recruit.html`) is where you put the swarm to work for you: a forecast on a market you pick, a random value nobody could pick, or your own odds as a forecaster agent. It merges the old Recruit and Random pages, sits in the top bar as Recruit, and shows its three jobs as tabs.

## Decisions (2026-10-30)

| Question | Decision |
|---|---|
| Name | **Recruit** (`recruit.html`). In an ant colony, recruitment is the trail that calls nestmates to work, which covers every job here: forecast, randomness, agents |
| Random page | **Merged in** as the Randomness section. `random.html` redirects to `recruit.html#random` (`?id=` becomes `?rnd=`, `?c=` stays) |
| Top bar | **In it, as Recruit** (updated 2026-10-30): Live · Pot · Recruit, Replay · Receipts, Docs. It is also reached from where its jobs come up (below) |
| Sections | **Tabs**, one shown at a time: Forecast on request, Randomness, Answer as an agent. The hash picks the tab (`#forecast`, `#random`, `#agents`; `#request` and `#recent` open Forecast; `?rnd=` alone opens Randomness). Each section's components are unchanged |
| Requesting a forecast in a browser | **On both pages, user first** (updated 2026-10-30): the same Add a market panel (`addmarket.mjs`) opens Recruit's Forecast tab, beside where the fee goes, and sits in Live's side column. Recruit's new request opens below the form. `recruit.html?q=…` fills the field and looks it up; `#request` focuses it. From code comes last in the tab |
| Following one request | **On the market page** (updated 2026-10-30), as `market.html?r=N` (`requestview.mjs`), with the same components the Recruit page had: lifecycle, what is next, Feed Community, colonies, belief and verify, inputs, who got paid. Recruit keeps only the **request history**, a list. Old `recruit.html#request-N` links redirect |

## Top bar and Live entry (2026-10-30)

Recruit is the one button that starts something, so it sits at the end of the bar, between the $ANTO chip and the wallet, as an amber outline with a `+` (`.nav__cta`, built in `topbar()`), not as a tab; its tooltip reads "Ask the swarm for a forecast". Live's panel is headed **Recruit** (it was Add a market) and Live has no separate button for it (the panel sits in the side column); the page title says the job ("Ask the swarm to forecast any Polymarket market.") and the lede's fee is read from the chain.

## Entry points

| Where | Link |
|---|---|
| Live, Recruit panel | After a request: "Follow it ›" to `market.html?r=N`. Under the panel: "From code, every request, randomness: Recruit ›" |
| Live, Community markets | "All requests" to `#recent`; each card's "Market page: follow the request ›" to `market.html?r=N` |
| Landing, $ANTO's uses | Recruit the swarm → Live's Recruit panel; Forecast as an agent → `#agents`; Randomness → `#random` (the fee burns) |
| Footer | Its own group, **Recruit the swarm**: Forecast on request, Randomness, Agents |
| Docs | One page card for Recruit; the Random entry links to `#random` |

## Layout

```
top bar: Live  Pot │ Replay  Receipts │ Docs      [$ANTO] [+ Recruit] [wallet]
Recruit the swarm · for agents, contracts and anyone
Ask the swarm to forecast         lede: paste a link, pay the fee (read from the
any Polymarket market.            chain), watch three colonies, check the hash;
                                  workers are paid for the work, never for being right
[Forecast on request] [Randomness] [Answer as an agent]      tabs, one shown
──────────────────────────────────────────────────────────────────────────
FORECAST ON REQUEST  tab #forecast                         fee 100 $ANTO
┌ Pick a market ───────────────────────────────┬ Where the fee goes ──┐
│ [polymarket link or search…            ]     │ Fee 100 $ANTO        │
│ ( ) hit · ( ) hit · …   pick + keeper checks │ ▬▬▬▬▬ split bar      │
│ Fee 100 · you have 150   [Request forecast]  │ keepers · agents …   │
└──────────────────────────────────────────────┴──────────────────────┘
Request history  (#, market, by + yours, state, swarm leads)        #recent
  each row opens market.html?r=N: steps · what is next · Feed Community ·
  colonies + swarm belief · inputs · paid
From code: $ recruit.py ask … ⧉ · MCP: ask_swarm, verify
──────────────────────────────────────────────────────────────────────────
RANDOMNESS  tab #random                                 1 $ANTO, burned
┌ Request #7 · steps · big value · facts · check ┐ ┌ Ask: names, Request ┐
└────────────────────────────────────────────────┘ │ From a contract ›   │
Recent values                                       └─────────────────────┘
──────────────────────────────────────────────────────────────────────────
AGENTS  tab #agents                                     10 $ANTO deposit
Your status · Register / Unregister · registered agents count
Open for posts now: requests in their agents' window, with the time left
Paid for posting on time, never for being right · the commands
```

- One primary per tab: Forecast's **Request forecast**, Randomness's **Request a value**. Register is a plain button.
- The tabs are links styled like the top bar's, smaller (`.rc-tabs`, a bone rule under the current one); arrow keys move between them. The panels' ids are `tab-<name>-panel`, so a `#random` link picks the tab without scrolling past it.
- Phones: each section's side card drops under its stage; the ask strip stacks.

## Recruit panel, formerly Add a market (Recruit's Forecast tab and Live)

The panel takes over what the old Recruit composer did. On Recruit it is the first column of the tab, with the fee split and its notes beside it (the panel's own bar is hidden there); on Live it sits in the 320px side column:

1. **Field:** "Polymarket link, market ID or search". A pasted `/event/<slug>` link or a bare slug is looked up directly; other text searches Polymarket (the one allowed outside read). Up to five hits show as a radio list; a single hit from a link is picked at once.
2. **Check:** the pick is read the way a keeper reads it (`readMarket`). Refused markets show the reason and no button.
3. **Preview:** the title, its outcomes with glyphs, the end date; "Already forecast this round" if a round market has the same slug (no fee needed, link to its card); "Already requested as #N" if an open request has it (link, or pay again for a fresh run).
4. **Cost line and split:** "Fee 100 $ANTO · you have 150 $ANTO", then the `.fee-split` bar.
5. **One primary:** "Request forecast · 100 $ANTO" ("Connect a wallet to request", not amber, without a wallet). After signing: "Requested as #N. Follow it ›", and the card appears under Community markets marked "yours". On Recruit the new request opens right below.

## States

| Thing | State | Shown as |
|---|---|---|
| Request history | No request yet | "No requests yet. Be the first: pick a market above." |
| Market page, `?r=N` | Missing | "There is no request #N on {contract}. See every request." |
| Agents | No wallet / not registered / registered | Connect line / Register (deposit) / Unregister, with the deposit |
| | Nothing open | "No request is in its agents' window right now." |
| Randomness | As the Random page was | Waiting (countdown), Round out (Prove), Ready (value, Check against drand) |
