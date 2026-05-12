// Cake Shop server: serves static files and a tiny image-generation API.
//
// GET /api/cake-photo?shape=&colorId=&patternId=&sizeInch=[&force=1]
//   - Returns { url, cached, generated } pointing to /cache/cakes/<key>.png
//   - Cache hit: instant. Cache miss: call Gemini 2.5 Flash Image,
//     write the result to cache/cakes/, return the URL.
//   - force=1 ignores any existing cache and regenerates.
//
// Cache key format: `${shape}-${colorId}-${patternId|'none'}.png`. Owner
// can drop a real photo at that path to override the AI output.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = Number(process.env.PORT || 4173);
const HOST       = process.env.HOST || '0.0.0.0';
const CACHE_DIR  = path.join(__dirname, 'cache', 'cakes');
const PATTERN_DIR = path.join(__dirname, 'assets', 'patterns-png');
const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`;

fs.mkdirSync(CACHE_DIR, { recursive: true });

const COLOR_NAMES = {
  ivory:  'ivory cream',
  butter: 'butter yellow',
  blush:  'blush pink',
  peach:  'soft peach',
  lilac:  'pale lilac',
  sage:   'sage green',
  rose:   'dusty rose pink',
  sky:    'sky blue',
  navy:   'deep navy blue',
  noir:   'matte black',
};

const PATTERN_NAMES = {
  confetti:      'Confetti',
  floral:        'Floral',
  'gold-leaf':   'Gold Leaf',
  mediterranean: 'Mediterranean Tile',
  polka:         'Polka',
  stripes:       'Sorbet Stripes',
};

const PATTERN_SUBS = {
  confetti:      'small colorful paper rectangles tossed evenly (red, yellow, blue, green, purple, with a few black dots) on a cream background',
  floral:        'hand-illustrated pink rose flowers with green leaves on a cream background',
  'gold-leaf':   'scattered angular brass-gold leaf flecks on a near-black background',
  mediterranean: 'small Portuguese tile motifs — geometric compass roses in blue with yellow centres on a cream background',
  polka:         'evenly spaced red and yellow polka dots on a cream background',
  stripes:       'vertical pastel sorbet ribbon stripes (alternating soft pink, butter yellow, mint green, lilac, sky blue, cream)',
};

const SHAPES   = new Set(['round', 'square']);
const PATTERNS = new Set(['none', ...Object.keys(PATTERN_NAMES)]);

const VIEWS = new Set(['side', 'top']);

const cacheKey = ({ shape, colorId, patternId, view }) => {
  const v = view === 'top' ? '-top' : '';
  return `${shape}-${colorId}-${patternId || 'none'}${v}.png`;
};

const buildPrompt = ({ shape, colorId, patternId, sizeInch, view }) => {
  const colorName = COLOR_NAMES[colorId] || colorId;
  const shapeDesc = shape === 'round'
    ? `round cylindrical 4-layer cake (${sizeInch} inch diameter, about 5 inches tall — taller than it is wide)`
    : `square cube-shaped 4-layer cake (${sizeInch} inch sides, about 5 inches tall)`;

  // === TOP-DOWN VIEW =====================================================
  // Used on the message step when the user picks "On top". The camera is
  // tilted high — close to directly overhead — so the full top surface
  // is the dominant feature of the frame.
  if (view === 'top') {
    const topShape = shape === 'round' ? 'a large round disc' : 'a large square panel';
    const baseTop = `FLAT-LAY style photorealistic product photo. Camera is positioned DIRECTLY ABOVE the cake, shooting straight down (bird's-eye view, approximately 80–85 degrees from horizontal). The flat TOP of the cake fills most of the frame — it appears as ${topShape} of smooth ${colorName} fondant icing, perfectly circular${shape === 'round' ? '' : ' / square'} because we are looking down at it. The top is completely PLAIN, blank, smooth ${colorName} icing with NO writing, NO motifs, NO decorations on the surface — it is a clean empty canvas waiting for hand-piped text.`;
    if (!patternId || patternId === 'none') {
      return baseTop + ` Around the edges of the cake top, a narrow rim of the cake's side wall is visible at extreme foreshortening — also plain ${colorName} icing. Beyond the cake we glimpse a small ring of white ceramic cake stand and a neutral cream backdrop. Soft natural daylight, shallow depth of field, professional bakery flat-lay photography, square frame, cake exactly centred.`;
    }
    const patName = PATTERN_NAMES[patternId] || patternId;
    const patSub  = PATTERN_SUBS[patternId]  || patternId;
    return baseTop + ` Around the cake top, the side wall is visible only as a thin foreshortened ring — that ring is decorated with the "${patName}" pattern (${patSub}) from the attached reference. But the TOP surface itself stays absolutely plain ${colorName} icing — no pattern, no motifs, no text. Beyond the cake, a small ring of white ceramic cake stand and a neutral cream backdrop. Soft natural daylight, shallow depth of field, professional bakery flat-lay photography, square frame, cake exactly centred.`;
  }

  // === STANDARD SIDE VIEW (default) ======================================
  if (!patternId || patternId === 'none') {
    return `Photorealistic product photo of a single ${shapeDesc}, covered in smooth ${colorName} fondant icing on top and all sides — no pattern, just clean solid icing. The cake sits on a white ceramic pedestal cake stand. Soft natural daylight from upper left, neutral cream backdrop, slight shadow on the stand, shallow depth of field. Professional bakery product photography, square frame, cake centered.`;
  }

  const patName = PATTERN_NAMES[patternId] || patternId;
  const patSub  = PATTERN_SUBS[patternId]  || patternId;

  return `Photorealistic product photo of a single ${shapeDesc}. The flat TOP of the cake is smooth ${colorName} fondant icing.

The ENTIRE side of the cake is covered by an edible icing decoration matching the attached reference image — this is "${patName}" (${patSub}).

VERY IMPORTANT visual rules for the side:
- The decoration is hand-applied directly ONTO the ${colorName} fondant icing of the cake side — it is NOT a separate paper wrap, label, sleeve, or ribbon. There is no visible edge, seam, lip, or border between the decoration and the cake itself.
- The decoration covers the FULL height of the side: it starts flush against the TOP EDGE of the cake and continues down to the BOTTOM EDGE where the cake meets the stand. NO plain band of unpatterned ${colorName} icing is visible above, below, or between the motifs.
- The motifs sit ON the ${colorName} icing — the ${colorName} colour shows through any background spaces between motifs, so the cake's own colour is part of the design.
- The pattern wraps continuously 360 degrees around the cake without seams.
- The motif colours, shapes and density match the reference image.

The cake sits on a white ceramic pedestal cake stand. Soft natural daylight from upper left, neutral cream backdrop, slight shadow on the stand, shallow depth of field. Professional bakery product photography, square frame, the cake centered.`;
};

const callGemini = ({ prompt, patternPngPath }) => new Promise((resolve, reject) => {
  if (!GEMINI_KEY) return reject(new Error('GEMINI_KEY not set on server'));

  const parts = [{ text: prompt }];
  if (patternPngPath && fs.existsSync(patternPngPath)) {
    const b64 = fs.readFileSync(patternPngPath).toString('base64');
    parts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  });

  const req = https.request(
    GEMINI_URL(GEMINI_KEY),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || 'Gemini error'));
          const imgPart = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
          if (!imgPart) return reject(new Error('No image returned'));
          resolve(Buffer.from(imgPart.inlineData.data, 'base64'));
        } catch (e) {
          reject(e);
        }
      });
    },
  );
  req.on('error', reject);
  req.write(body);
  req.end();
});

const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));
app.use('/cache/cakes', express.static(CACHE_DIR, { maxAge: '7d' }));

// Owner-only listing of what's currently cached.
app.get('/api/cake-cache', (req, res) => {
  const files = fs.readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const st = fs.statSync(path.join(CACHE_DIR, f));
      return { file: f, size: st.size, mtime: st.mtime };
    });
  res.json({ count: files.length, files });
});

app.get('/api/cake-photo', async (req, res) => {
  const shape     = String(req.query.shape || 'round');
  const colorId   = String(req.query.colorId || 'blush');
  const patternId = String(req.query.patternId || 'none');
  const sizeInch  = Number(req.query.sizeInch || 5);
  const view      = String(req.query.view || 'side');
  const force     = req.query.force === '1' || req.query.force === 'true';

  if (!SHAPES.has(shape))           return res.status(400).json({ error: 'invalid shape' });
  if (!COLOR_NAMES[colorId])        return res.status(400).json({ error: 'invalid colorId' });
  if (!PATTERNS.has(patternId))     return res.status(400).json({ error: 'invalid patternId' });
  if (!VIEWS.has(view))             return res.status(400).json({ error: 'invalid view' });
  if (!(sizeInch >= 3 && sizeInch <= 9)) return res.status(400).json({ error: 'invalid sizeInch' });

  const key      = cacheKey({ shape, colorId, patternId, view });
  const filepath = path.join(CACHE_DIR, key);
  const urlPath  = `/cache/cakes/${key}`;

  if (!force && fs.existsSync(filepath)) {
    return res.json({ url: urlPath, cached: true, generated: false });
  }

  if (!GEMINI_KEY) {
    return res.status(503).json({ error: 'GEMINI_KEY not configured on server', cached: false });
  }

  try {
    const prompt = buildPrompt({ shape, colorId, patternId, sizeInch, view });
    const patternPngPath = patternId !== 'none'
      ? path.join(PATTERN_DIR, `${patternId}.png`)
      : null;
    const png = await callGemini({ prompt, patternPngPath });
    fs.writeFileSync(filepath, png);
    return res.json({ url: urlPath, cached: false, generated: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, HOST, () => {
  const keyState = GEMINI_KEY ? `Gemini key: set (${GEMINI_KEY.slice(0, 6)}…)` : 'Gemini key: MISSING — set GEMINI_KEY env var';
  console.log(`Cake Shop listening on http://${HOST}:${PORT}`);
  console.log(keyState);
  console.log(`Cache dir : ${CACHE_DIR}`);
  console.log(`Patterns  : ${PATTERN_DIR}`);
});
