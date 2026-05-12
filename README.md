# Magic Taste — cake configurator

Single-page cake order flow: shape → size → colour → wrap → message → review.
Photoreal cake previews generated on demand by Gemini and cached.

## Local dev

```bash
npm install
GEMINI_KEY=<your-key> npm start
# open http://127.0.0.1:4173/Cake Order.html
```

Get a free Gemini key at https://aistudio.google.com/apikey.

## Project layout

```
.
├── Cake Order.html        # the page (entry point)
├── cake-preview.jsx       # React cake-preview component (Babel-transpiled in browser)
├── colors_and_type.css    # design tokens
├── server.js              # Express server + Gemini integration
├── package.json
├── render.yaml            # Render Blueprint
├── assets/
│   ├── patterns/          # original SVG wrap patterns
│   ├── patterns-png/      # rasterised PNGs passed to Gemini as image input
│   └── cakes/             # legacy base-cake photos (no longer the primary preview)
└── cache/
    └── cakes/             # generated cake photos, keyed {shape}-{color}-{pattern}[-top].png
```

## Cache key format

```
{shape}-{colorId}-{patternId|none}[-top].png
```

Examples:
- `round-blush-confetti.png` — side view of a round blush cake with confetti wrap
- `round-noir-gold-leaf-top.png` — top-down view of a noir cake with gold-leaf wrap

To override the AI-generated photo for any combo, drop a real photograph at the matching cache path. The server serves it as-is and never calls Gemini for that combo again.

## Deploy

### Render (recommended)

1. Push this directory to a GitHub repo.
2. Visit [render.com](https://render.com) → New → Blueprint.
3. Connect your repo. Render reads `render.yaml` and creates the service.
4. Set `GEMINI_KEY` in the service's environment variables.
5. Done. Render gives you `https://magic-taste.onrender.com`. Add a custom domain in the dashboard for free.

**Free tier caveats:** spins down after 15 min idle (cold-start ~30s on next hit); no persistent disk (cache rebuilds on cold-start, which means extra Gemini calls per combo until the cache is warm again).

**Upgrade ($7/mo) for production:** edit `render.yaml`, change `plan: free` to `plan: starter`, uncomment the `disk:` block. Always-on, persistent cache.

### Cloudflare Tunnel (quickest demo)

Public URL in 30 seconds with no deploy. Your local `node server.js` stays running and the tunnel forwards from a Cloudflare edge:

```bash
cloudflared tunnel --url http://127.0.0.1:4173
```

Caveats: random URL each run, tied to your local process being up.

## Owner mode

Append `?owner=1` to any URL to expose a `↻ Regenerate` button on the cake preview — forces a fresh Gemini call ignoring the cache.

For production you should gate this behind a token instead of a URL flag.

## Hardening before public launch

1. **Rate-limit** `/api/cake-photo` by IP (e.g. with `express-rate-limit`): the endpoint is public and a single malicious caller can exhaust your Gemini quota.
2. **Lock down `owner=1`** behind an `OWNER_TOKEN` env var that must match a query param.
3. **Don't commit `GEMINI_KEY`** — it lives in env vars only.
4. **Validate** that the requested `{shape,colorId,patternId,view}` combo is in the allowed set (already done in `server.js`).
