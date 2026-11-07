# Antonomy brand files

The logo is a worker ant seen from above, head up: three body segments, six legs, elbowed antennae. The wordmark is "**Anto**nomy" in IBM Plex Sans semibold, with "Anto" in amber so the $ANTO ticker shows inside the name. Colours come from `web/ds/tokens.css`. The brand is dark-first: use the light files only where the ground can't be dark.

Every file here is written by `node web/brand/make_brand.mjs`. Change the drawing there, not in the files. PNGs need Chrome (set `CHROME` to its binary if it's not in the macOS default place) and the network for Google Fonts; `--svg-only` skips them.

| File | What it is | Use it for |
|---|---|---|
| `mark.svg`, `mark-512.png` | Amber ant, no background | The logo on dark ground |
| `mark-bone.svg` | Bone ant | One colour on dark ground or photos |
| `mark-ink.svg` | Ink ant | One colour on light ground, print |
| `icon.svg` | Ink ant on an amber rounded tile | Favicon, app icon |
| `favicon.ico` | `icon.svg` at 16, 32 and 48 px | Browsers without SVG favicons |
| `icon-512.png`, `apple-touch-icon.png` | `icon.svg` at 512 and 180 px | Listings, home-screen icon |
| `avatar-400.png` | Ink ant on full-bleed amber | X, Telegram and Discord avatars (they crop to a circle) |
| `lockup.svg`, `lockup.png` | Ant plus wordmark, amber and bone | The name on dark ground |
| `lockup-light.svg`, `lockup-light.png` | Ant plus wordmark, deep amber and ink | The name on light ground |
| `social-card.png` | 1200×630 link preview: lockup, tagline, seed 42's colony trail with its hash | `og:image` on `web/index.html` and `web/app.html` |
| `x-header.png` | 1500×500 banner, copy kept clear of the avatar | X profile header |

The lockup SVGs set the wordmark as live text and import Plex Sans from Google Fonts. Opened in a browser they render right. Inside an `<img>` tag, or in a design tool without the font installed, they fall back to a system sans, so use the PNGs there.

## Use

- Keep clear space around the mark of at least the width of its head on every side.
- Don't recolour the ant outside these files, rotate it, outline it or add effects.
- On light ground use the light files: plain amber on white is 2:1 and too faint.
- The web app draws the mark inline in `web/ui.mjs` (`MARK`) with `var(--accent)`. If the ant's geometry changes, copy the new path there too.
