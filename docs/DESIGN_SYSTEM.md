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
- `antonomy.css` is the entry point. It loads Google Fonts and then the three files above. Without network, the font stacks fall back to system serif and mono.

## Rules

1. **Amber is reserved.** It means pheromone, the brand and the one primary action in a view. Never use it for an option or a status.
2. **Every option shows its glyph next to its colour** (▲ ■ ◆ ● ★ for options 0 to 4). Use `data-opt="n"` together with `.opt`. Never show an option by colour alone.
3. **Status needs a glyph and a word.** Examples: ✓ Hash match, ✗ Hash mismatch, ▲/▼ for deltas. Colour only reinforces the message.
4. **Hashes and seeds are always mono, copyable, and show their full value on hover** (`.hash` with a `title` and a `.hash__copy` button carrying `data-copy`). When truncating, keep the start and the end, as in `0x9f3a5c07…a3d9e21c`.
5. **Every forecast output carries `.tag-forecast`** ("Forecast · not advice"). Label the averaged number "Swarm belief" until calibration exists. Never link to trading venues.
6. **The colony picks an index, never an amount.** Menus render as `.option-card` radios with fixed values and show the cap.
7. **Wallet tints** use `oklch(0.72 0.07 h)`, where h is the first 2 bytes of sha256(account id) mod 360. Lightness and chroma are fixed so staker ants never outshine trails or food. Use `.wallet` with an inline `--wallet-hue`. Canvas code uses the same numbers.
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
| Sim canvas | `ColonyView` in `colony-view.mjs` | `attach(colony)`, call `afterStep(fx)` after each `step()`, then `draw(frac, now)`. `draw` returns true while effects still need frames. `mode` is `"nest"` or `"cells"` |
| Results | `.share-bars` with `.share-bar[data-opt]` (`--share`, `.is-winner`) | |
| Ant autopsy | `.inspector`, `.compass` (`--heading` 0 to 15, 0 = east, clockwise on screen), `.ant-state[data-state]` | |
| Forms | `.field`, `__label`, `__hint`, `__error`, `.input` (`aria-invalid`), `.input-group`, `.range` | |
| Staking | `.stake`, `__row`, `__readout` | Shows stake, √ weight and cap used |
| Menus | `.option-cards` with `.option-card[data-opt]` and a radio | Selection comes from `:has(input:checked)` |
| Data | `.table-wrap`, `.table`, `.num`, `.col-swarm`, `.delta--up\|down\|flat` | Numeric columns are right-aligned |

## Not done yet

- No light mode (by decision).
- Fonts load from Google Fonts. Self-host them if the replay page must work offline.
- The showcase runs the real sim (`Colony` from `sim/js/antosim.mjs`). Verify compares the browser's hash for seed-1042 with the Python reference, because there is no contract yet. Staker ants and wallet tints aren't in sim v0, so the canvas doesn't show them yet.
