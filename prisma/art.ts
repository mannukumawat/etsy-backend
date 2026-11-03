// Copied into backend/ so the seed renders the same artwork the apps ship. Independent copy.
// Copied from frontend/src/data/art.ts (independent copy — admin must not import storefront code).
// Procedural placeholder product imagery.
//
// Each product image is a self-contained SVG rendered to a data URI, so the demo works offline,
// every image has the same aspect ratio, and colour variants genuinely change the picture.
// Phase 2: product images will come from the backend/CDN as URLs; components only read `ProductImage.src`.

export type ArtKind =
  | 'mug' | 'bowl' | 'vase' | 'plates' | 'teapot'
  | 'basketBag' | 'tote' | 'crossbody' | 'clutch'
  | 'necklace' | 'hoops' | 'jhumka' | 'ring' | 'bracelet'
  | 'lamp' | 'candle' | 'cushion' | 'macrame' | 'planter';

export interface ArtSpec {
  kind: ArtKind;
  color: string;
  accent?: string;
  pattern?: 'jute' | 'print';
  seed?: string;
}

// ---------- colour + random helpers ----------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

const L = (c: string, t: number) => mix(c, '#ffffff', t);
const D = (c: string, t: number) => mix(c, '#1c140e', t);

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

// ---------- drawing primitives ----------

interface Ctx {
  c: string;
  a: string;
  p: string; // id prefix
  r: () => number;
  pattern?: ArtSpec['pattern'];
}

interface Drawn {
  defs: string;
  body: string;
  /** Half width (for shadows / fitting). */
  w: number;
  /** Height above the ground line (standing) or total height (flat). */
  h: number;
  flat?: boolean;
}

function cylGrad(id: string, c: string): string {
  return `<linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">
<stop offset="0" stop-color="${D(c, 0.22)}"/><stop offset=".3" stop-color="${L(c, 0.12)}"/>
<stop offset=".58" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.3)}"/></linearGradient>`;
}

function speckles(ctx: Ctx, n: number, x0: number, y0: number, x1: number, y1: number, opacity = 0.5): string {
  const dark = luminance(ctx.c) > 0.45;
  const col = dark ? '#4a3a2c' : '#efe6da';
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = x0 + ctx.r() * (x1 - x0);
    const y = y0 + ctx.r() * (y1 - y0);
    const rad = 1.2 + ctx.r() * 2.6;
    out += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(rad)}" fill="${col}" opacity="${f(opacity * (0.5 + ctx.r() * 0.5))}"/>`;
  }
  return out;
}

const shine = (x: number, y: number, w: number, h: number, o = 0.16) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}" fill="#fff" opacity="${o}"/>`;

// ---------- kinds ----------

const DRAW: Record<ArtKind, (ctx: Ctx) => Drawn> = {
  mug: (ctx) => {
    const { c, p } = ctx;
    const body = 'M-100,-196 L100,-196 L96,-14 Q94,0 78,0 L-78,0 Q-94,0 -96,-14 Z';
    return {
      w: 140,
      h: 212,
      defs: `${cylGrad(`${p}g`, c)}<clipPath id="${p}cl"><path d="${body}"/></clipPath>
<linearGradient id="${p}clay" x1="0" x2="1"><stop offset="0" stop-color="#b89a78"/><stop offset=".4" stop-color="#dcc6a8"/><stop offset="1" stop-color="#a88a68"/></linearGradient>`,
      body: `<path d="M86,-162 C178,-168 180,-50 90,-48" fill="none" stroke="${D(c, 0.16)}" stroke-width="26" stroke-linecap="round"/>
<path d="M92,-160 C168,-162 168,-58 96,-55" fill="none" stroke="${L(c, 0.08)}" stroke-width="8" stroke-linecap="round" opacity=".6"/>
<path d="${body}" fill="url(#${p}g)"/>
<g clip-path="url(#${p}cl)">
<path d="M-110,-36 Q-70,-44 -30,-35 T50,-38 T110,-32 L110,10 L-110,10 Z" fill="url(#${p}clay)"/>
${speckles(ctx, 70, -96, -190, 96, -40)}
${shine(-74, -182, 16, 132)}
</g>
<ellipse cx="0" cy="-196" rx="100" ry="15" fill="${L(c, 0.06)}"/>
<ellipse cx="0" cy="-194" rx="90" ry="11" fill="${D(c, 0.42)}"/>`,
    };
  },

  bowl: (ctx) => {
    const { c, p } = ctx;
    const body = 'M-180,-130 C-176,-50 -100,-8 0,-8 C100,-8 176,-50 180,-130 Z';
    return {
      w: 182,
      h: 168,
      defs: `${cylGrad(`${p}g`, c)}<clipPath id="${p}cl"><path d="${body}"/></clipPath>
<clipPath id="${p}in"><ellipse cx="0" cy="-130" rx="168" ry="30"/></clipPath>
<linearGradient id="${p}ig" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${D(c, 0.3)}"/><stop offset="1" stop-color="${L(c, 0.1)}"/></linearGradient>`,
      body: `<path d="M-62,-14 L62,-14 L58,0 L-58,0 Z" fill="${D(c, 0.38)}"/>
<path d="${body}" fill="url(#${p}g)"/>
<g clip-path="url(#${p}cl)">${speckles(ctx, 60, -175, -128, 175, -12)}${shine(-120, -112, 18, 70, 0.14)}</g>
<ellipse cx="0" cy="-130" rx="180" ry="36" fill="${L(c, 0.1)}" stroke="${D(c, 0.45)}" stroke-width="3"/>
<ellipse cx="0" cy="-130" rx="168" ry="30" fill="url(#${p}ig)"/>
<g clip-path="url(#${p}in)">${speckles(ctx, 40, -165, -160, 165, -100, 0.4)}</g>`,
    };
  },

  vase: (ctx) => {
    const { c, a, p, r } = ctx;
    const body =
      'M-18,-300 L18,-300 C18,-250 22,-230 40,-210 C112,-170 122,-60 70,-6 Q64,0 50,0 L-50,0 Q-64,0 -70,-6 C-122,-60 -112,-170 -40,-210 C-22,-230 -18,-250 -18,-300 Z';
    let leaves = '';
    const stems: Array<[number, number, number, number]> = [
      [0, -300, -70, -480],
      [0, -300, 50, -510],
      [0, -300, 105, -430],
    ];
    let stemPaths = '';
    for (const [x0, y0, x1, y1] of stems) {
      stemPaths += `<path d="M${x0},${y0} Q${(x0 + x1) / 2 + 10},${(y0 + y1) / 2} ${x1},${y1}" stroke="#6b5a3e" stroke-width="3" fill="none"/>`;
      for (let i = 1; i <= 6; i++) {
        const t = i / 7;
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
        const side = i % 2 ? 40 : -40;
        const col = r() > 0.5 ? '#7d8c5c' : '#93a06e';
        leaves += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="22" ry="6" fill="${col}" transform="rotate(${f(ang + side)} ${f(x)} ${f(y)}) translate(14 0)"/>`;
      }
    }
    let motif = '';
    for (let i = 0; i < 5; i++) {
      const x = -80 + i * 40;
      motif += `<path d="M${x},-120 C${x + 14},-150 ${x + 26},-150 ${x + 20},-175 C${x + 6},-160 ${x - 6},-140 ${x},-120 Z" fill="${a}" opacity=".85"/>`;
      motif += `<circle cx="${x + 20}" cy="-90" r="5" fill="${a}" opacity=".8"/>`;
    }
    return {
      w: 125,
      h: 520,
      defs: `${cylGrad(`${p}g`, c)}<clipPath id="${p}cl"><path d="${body}"/></clipPath>`,
      body: `${stemPaths}${leaves}
<path d="${body}" fill="url(#${p}g)"/>
<g clip-path="url(#${p}cl)">
<path d="M-130,-196 H130" stroke="${a}" stroke-width="4" opacity=".8"/>
<path d="M-130,-60 H130" stroke="${a}" stroke-width="3" opacity=".7"/>
${motif}${speckles(ctx, 30, -110, -290, 110, -10, 0.35)}${shine(-60, -190, 14, 150, 0.15)}
</g>
<ellipse cx="0" cy="-300" rx="19" ry="5" fill="${D(c, 0.4)}"/>`,
    };
  },

  plates: (ctx) => {
    const { c, p } = ctx;
    const rim = D(c, 0.42);
    return {
      w: 235,
      h: 375,
      defs: `<radialGradient id="${p}rg" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="${L(c, 0.14)}"/><stop offset="1" stop-color="${D(c, 0.12)}"/></radialGradient>
<clipPath id="${p}up"><circle cx="50" cy="-200" r="170"/></clipPath>`,
      body: `<circle cx="50" cy="-200" r="170" fill="url(#${p}rg)" stroke="${rim}" stroke-width="3"/>
<circle cx="50" cy="-200" r="118" fill="${D(c, 0.06)}" stroke="${D(c, 0.15)}" stroke-width="2"/>
<g clip-path="url(#${p}up)">${speckles(ctx, 70, -120, -370, 220, -30, 0.45)}</g>
<ellipse cx="0" cy="-10" rx="230" ry="60" fill="${D(c, 0.3)}"/>
<ellipse cx="0" cy="-20" rx="230" ry="60" fill="${c}" stroke="${rim}" stroke-width="2.5"/>
<ellipse cx="0" cy="-36" rx="230" ry="60" fill="${D(c, 0.24)}"/>
<ellipse cx="0" cy="-46" rx="230" ry="60" fill="url(#${p}rg)" stroke="${rim}" stroke-width="3"/>
<ellipse cx="0" cy="-48" rx="165" ry="40" fill="${D(c, 0.07)}" stroke="${D(c, 0.16)}" stroke-width="2"/>
${speckles(ctx, 40, -150, -80, 150, -20, 0.4)}`,
    };
  },

  teapot: (ctx) => {
    const { c, p } = ctx;
    return {
      w: 250,
      h: 312,
      defs: `${cylGrad(`${p}g`, c)}<clipPath id="${p}cl"><ellipse cx="0" cy="-135" rx="150" ry="122"/></clipPath>`,
      body: `<path d="M-130,-212 C-238,-216 -238,-56 -132,-70" fill="none" stroke="${D(c, 0.14)}" stroke-width="22" stroke-linecap="round"/>
<path d="M118,-150 C170,-152 196,-204 232,-252 L250,-240 C224,-178 204,-108 132,-92 Z" fill="url(#${p}g)"/>
<rect x="-80" y="-24" width="160" height="24" rx="8" fill="${D(c, 0.32)}"/>
<ellipse cx="0" cy="-135" rx="150" ry="122" fill="url(#${p}g)"/>
<g clip-path="url(#${p}cl)">${speckles(ctx, 90, -150, -257, 150, -13)}${shine(-100, -210, 18, 120, 0.15)}</g>
<ellipse cx="0" cy="-250" rx="80" ry="17" fill="${D(c, 0.18)}"/>
<path d="M-70,-252 C-60,-302 60,-302 70,-252 Z" fill="url(#${p}g)"/>
<ellipse cx="0" cy="-300" rx="17" ry="12" fill="${D(c, 0.22)}"/>`,
    };
  },

  basketBag: (ctx) => {
    const { c, a, p } = ctx;
    const body = 'M-160,-290 L160,-290 L132,-22 Q128,0 104,0 L-104,0 Q-128,0 -132,-22 Z';
    return {
      w: 165,
      h: 445,
      defs: `<pattern id="${p}wv" width="28" height="20" patternUnits="userSpaceOnUse">
<rect width="28" height="20" fill="${c}"/><rect width="14" height="10" fill="${D(c, 0.12)}"/><rect x="14" y="10" width="14" height="10" fill="${D(c, 0.12)}"/>
<path d="M0,10 H28" stroke="${D(c, 0.3)}" stroke-width="1.2"/><path d="M14,0 V10 M0,10 V20 M28,10 V20" stroke="${D(c, 0.22)}" stroke-width="1"/></pattern>
<linearGradient id="${p}sh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".35" stop-color="#fff" stop-opacity=".06"/><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".32"/></linearGradient>`,
      body: `<path d="M-80,-288 C-86,-420 86,-420 80,-288" fill="none" stroke="${D(a, 0.25)}" stroke-width="14" stroke-linecap="round"/>
<path d="${body}" fill="url(#${p}wv)"/><path d="${body}" fill="url(#${p}sh)"/>
<rect x="-164" y="-298" width="328" height="28" rx="8" fill="${D(c, 0.2)}"/>
<path d="M-160,-284 H160" stroke="${D(c, 0.4)}" stroke-width="2" stroke-dasharray="10 6"/>
<path d="M-102,-282 C-108,-452 108,-452 102,-282" fill="none" stroke="${a}" stroke-width="16" stroke-linecap="round"/>
<circle cx="-102" cy="-276" r="7" fill="#c9a45c"/><circle cx="102" cy="-276" r="7" fill="#c9a45c"/>`,
    };
  },

  tote: (ctx) => {
    const { c, p } = ctx;
    const body = 'M-150,-320 L150,-320 L158,0 L-158,0 Z';
    const strap = D(c, 0.18);
    return {
      w: 160,
      h: 470,
      defs: `<pattern id="${p}cv" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="${c}"/><path d="M0,3 H6 M3,0 V6" stroke="${D(c, 0.08)}" stroke-width=".8"/></pattern>
<linearGradient id="${p}sh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".2"/><stop offset=".4" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#000" stop-opacity=".24"/></linearGradient>`,
      body: `<path d="M-74,-318 C-78,-470 78,-470 74,-318" fill="none" stroke="${strap}" stroke-width="22"/>
<path d="M-74,-318 C-78,-470 78,-470 74,-318" fill="none" stroke="${L(c, 0.3)}" stroke-width="1.5" stroke-dasharray="6 5"/>
<path d="${body}" fill="url(#${p}cv)"/><path d="${body}" fill="url(#${p}sh)"/>
<path d="M-150,-296 H150" stroke="${D(c, 0.25)}" stroke-width="1.5" stroke-dasharray="7 5"/>
<rect x="-82" y="-176" width="164" height="112" rx="4" fill="${D(c, 0.05)}" stroke="${D(c, 0.25)}" stroke-width="1.5" stroke-dasharray="7 5"/>
<path d="M-120,-250 L-60,-40" stroke="#000" stroke-opacity=".05" stroke-width="18"/>`,
    };
  },

  crossbody: (ctx) => {
    const { c, p } = ctx;
    return {
      w: 160,
      h: 450,
      defs: `<linearGradient id="${p}lg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${L(c, 0.1)}"/><stop offset="1" stop-color="${D(c, 0.18)}"/></linearGradient>`,
      body: `<path d="M-130,-205 C-150,-470 150,-470 130,-205" fill="none" stroke="${D(c, 0.28)}" stroke-width="12"/>
<rect x="-155" y="-215" width="310" height="215" rx="34" fill="url(#${p}lg)"/>
<path d="M-155,-180 Q-155,-215 -120,-215 L120,-215 Q155,-215 155,-180 L155,-98 Q155,-60 118,-60 L-118,-60 Q-155,-60 -155,-98 Z" fill="${D(c, 0.06)}"/>
<path d="M-143,-176 Q-143,-203 -116,-203 L116,-203 Q143,-203 143,-176 L143,-100 Q143,-72 114,-72 L-114,-72 Q-143,-72 -143,-100 Z" fill="none" stroke="${L(c, 0.35)}" stroke-width="1.4" stroke-dasharray="6 4"/>
<rect x="-20" y="-82" width="40" height="28" rx="6" fill="#c9a45c"/><rect x="-10" y="-74" width="20" height="12" rx="3" fill="#a8843e"/>
<rect x="-162" y="-212" width="14" height="22" rx="4" fill="#c9a45c"/><rect x="148" y="-212" width="14" height="22" rx="4" fill="#c9a45c"/>
${shine(-130, -46, 200, 10, 0.08)}`,
    };
  },

  clutch: (ctx) => {
    const { c, a, p } = ctx;
    const body = 'M-170,-200 L170,-200 L176,-18 Q176,0 158,0 L-158,0 Q-176,0 -176,-18 Z';
    const fill =
      ctx.pattern === 'print'
        ? `<pattern id="${p}pt" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="${c}"/>
<g fill="${a}"><circle cx="32" cy="32" r="6"/><ellipse cx="32" cy="18" rx="5" ry="9"/><ellipse cx="32" cy="46" rx="5" ry="9"/><ellipse cx="18" cy="32" rx="9" ry="5"/><ellipse cx="46" cy="32" rx="9" ry="5"/>
<circle cx="0" cy="0" r="4"/><circle cx="64" cy="0" r="4"/><circle cx="0" cy="64" r="4"/><circle cx="64" cy="64" r="4"/></g></pattern>`
        : `<pattern id="${p}pt" width="16" height="12" patternUnits="userSpaceOnUse"><rect width="16" height="12" fill="${c}"/><rect width="8" height="6" fill="${D(c, 0.14)}"/><rect x="8" y="6" width="8" height="6" fill="${D(c, 0.14)}"/></pattern>`;
    return {
      w: 178,
      h: 210,
      defs: `${fill}<linearGradient id="${p}sh" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient>`,
      body: `<path d="${body}" fill="url(#${p}pt)"/><path d="${body}" fill="url(#${p}sh)"/>
<rect x="-172" y="-206" width="344" height="18" rx="6" fill="${D(c, 0.3)}"/>
<path d="M-164,-197 H164" stroke="#8a7f72" stroke-width="5" stroke-dasharray="3 2"/>
<rect x="120" y="-206" width="16" height="30" rx="4" fill="#b59a62"/>
<path d="M128,-176 l-8,60 M128,-176 l0,62 M128,-176 l8,60" stroke="${a}" stroke-width="3" stroke-linecap="round"/>`,
    };
  },

  necklace: (ctx) => {
    const { c, p } = ctx;
    return {
      flat: true,
      w: 240,
      h: 420,
      defs: `<radialGradient id="${p}gd" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="${L(c, 0.45)}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.35)}"/></radialGradient>`,
      body: `<g transform="translate(0 60)">
<path d="M-230,-260 C-200,40 200,40 230,-260" fill="none" stroke="${D(c, 0.25)}" stroke-width="1.6"/>
<path d="M-230,-260 C-200,40 200,40 230,-260" fill="none" stroke="${c}" stroke-width="5" stroke-dasharray="7 4" stroke-linecap="round"/>
<circle cx="-230" cy="-262" r="7" fill="none" stroke="${c}" stroke-width="3"/><rect x="224" y="-276" width="12" height="18" rx="4" fill="${c}"/>
<circle cx="0" cy="-26" r="9" fill="none" stroke="${c}" stroke-width="4"/>
<path d="M0,-16 C58,20 62,96 0,142 C-62,96 -58,20 0,-16 Z" fill="url(#${p}gd)"/>
<path d="M0,-6 V128" stroke="${D(c, 0.35)}" stroke-width="2.5"/>
<path d="M0,30 L26,12 M0,60 L32,40 M0,90 L26,74 M0,30 L-26,12 M0,60 L-32,40 M0,90 L-26,74" stroke="${D(c, 0.3)}" stroke-width="1.8"/>
</g>`,
    };
  },

  hoops: (ctx) => {
    const { c, p } = ctx;
    const hoop = (x: number) => `<ellipse cx="${x}" cy="20" rx="82" ry="94" fill="none" stroke="url(#${p}gd)" stroke-width="16"/>
<ellipse cx="${x}" cy="20" rx="82" ry="94" fill="none" stroke="${L(c, 0.55)}" stroke-width="3" stroke-dasharray="3 16" opacity=".8"/>
<path d="M${x},-74 v-26" stroke="${D(c, 0.2)}" stroke-width="4" stroke-linecap="round"/>`;
    return {
      flat: true,
      w: 210,
      h: 240,
      defs: `<linearGradient id="${p}gd" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${L(c, 0.4)}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.3)}"/></linearGradient>`,
      body: `${hoop(-108)}${hoop(108)}`,
    };
  },

  jhumka: (ctx) => {
    const { c, a, p } = ctx;
    const one = (x: number) => {
      let beads = '';
      for (let i = 0; i < 9; i++) {
        const bx = x - 56 + i * 14;
        beads += `<line x1="${bx}" y1="62" x2="${bx}" y2="${82 + (i % 2) * 8}" stroke="${c}" stroke-width="2"/><circle cx="${bx}" cy="${88 + (i % 2) * 8}" r="6" fill="url(#${p}pr)"/>`;
      }
      let dots = '';
      for (let i = 0; i < 7; i++) dots += `<circle cx="${x - 36 + i * 12}" cy="${30 + Math.abs(3 - i) * -4}" r="3" fill="${L(c, 0.5)}"/>`;
      return `<circle cx="${x}" cy="-110" r="24" fill="url(#${p}gd)"/><circle cx="${x}" cy="-110" r="9" fill="${a}"/>
${[0, 60, 120, 180, 240, 300].map((d) => `<circle cx="${f(x + Math.cos((d * Math.PI) / 180) * 24)}" cy="${f(-110 + Math.sin((d * Math.PI) / 180) * 24)}" r="5" fill="${L(c, 0.3)}"/>`).join('')}
<path d="M${x},-86 v26" stroke="${c}" stroke-width="4"/>
<path d="M${x - 60},62 C${x - 60},-40 ${x + 60},-40 ${x + 60},62 Z" fill="url(#${p}gd)"/>
<path d="M${x - 60},62 H${x + 60}" stroke="${D(c, 0.3)}" stroke-width="5"/>${dots}${beads}`;
    };
    return {
      flat: true,
      w: 180,
      h: 260,
      defs: `<radialGradient id="${p}gd" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="${L(c, 0.5)}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.35)}"/></radialGradient>
<radialGradient id="${p}pr" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d8cfc2"/></radialGradient>`,
      body: `${one(-115)}${one(115)}`,
    };
  },

  ring: (ctx) => {
    const { c, p } = ctx;
    return {
      flat: true,
      w: 215,
      h: 430,
      defs: `<radialGradient id="${p}dish" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="#f3ece2"/><stop offset=".8" stop-color="#e3d7c6"/><stop offset="1" stop-color="#cdbfab"/></radialGradient>
<linearGradient id="${p}gd" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${L(c, 0.45)}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.3)}"/></linearGradient>
<radialGradient id="${p}ms" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#e3ebf3"/><stop offset="1" stop-color="#a9bcd4"/></radialGradient>`,
      body: `<circle cx="0" cy="0" r="210" fill="url(#${p}dish)"/><circle cx="0" cy="0" r="168" fill="none" stroke="#d4c6b2" stroke-width="2"/>
<ellipse cx="6" cy="30" rx="74" ry="64" fill="none" stroke="#000" stroke-opacity=".1" stroke-width="18"/>
<ellipse cx="0" cy="22" rx="72" ry="62" fill="none" stroke="url(#${p}gd)" stroke-width="15"/>
<ellipse cx="0" cy="-42" rx="31" ry="27" fill="${c}"/><ellipse cx="0" cy="-42" rx="25" ry="21" fill="url(#${p}ms)"/>
<ellipse cx="-8" cy="-50" rx="7" ry="4" fill="#fff" opacity=".8"/>`,
    };
  },

  bracelet: (ctx) => {
    const { c, p, r } = ctx;
    let beads = '';
    const n = 20;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = Math.cos(t) * 160;
      const y = Math.sin(t) * 140;
      if (i === 5) {
        beads += `<circle cx="${f(x)}" cy="${f(y)}" r="12" fill="#c9a45c"/>`;
        continue;
      }
      const tint = r() * 0.18;
      beads += `<circle cx="${f(x)}" cy="${f(y)}" r="20" fill="url(#${p}b)" />`;
      if (tint > 0.1) beads += `<circle cx="${f(x)}" cy="${f(y)}" r="20" fill="${D(c, 0.4)}" opacity="${f(tint)}"/>`;
    }
    return {
      flat: true,
      w: 185,
      h: 330,
      defs: `<radialGradient id="${p}b" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="${L(c, 0.55)}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${D(c, 0.35)}"/></radialGradient>`,
      body: `<ellipse cx="0" cy="0" rx="160" ry="140" fill="none" stroke="#bfb3a3" stroke-width="2"/>${beads}`,
    };
  },

  lamp: (ctx) => {
    const { c, p } = ctx;
    return {
      w: 180,
      h: 440,
      defs: `<pattern id="${p}rt" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="16" height="16" fill="${c}"/><path d="M0,4H16M0,12H16" stroke="${D(c, 0.2)}" stroke-width="2.5"/><path d="M4,0V16M12,0V16" stroke="${L(c, 0.18)}" stroke-width="2"/></pattern>
<radialGradient id="${p}glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffe3a8" stop-opacity=".9"/><stop offset="1" stop-color="#ffe3a8" stop-opacity="0"/></radialGradient>
<linearGradient id="${p}sh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>`,
      body: `<ellipse cx="0" cy="-232" rx="230" ry="90" fill="url(#${p}glow)"/>
<path d="M-60,0 L60,0 C72,-60 52,-120 22,-160 L-22,-160 C-52,-120 -72,-60 -60,0 Z" fill="url(#${p}rt)"/>
<path d="M-60,0 L60,0 C72,-60 52,-120 22,-160 L-22,-160 C-52,-120 -72,-60 -60,0 Z" fill="url(#${p}sh)"/>
<rect x="-6" y="-262" width="12" height="104" fill="#6b5038"/>
<ellipse cx="0" cy="-250" rx="175" ry="16" fill="#ffd98a"/>
<path d="M-90,-430 L90,-430 L175,-250 L-175,-250 Z" fill="url(#${p}rt)"/>
<path d="M-90,-430 L90,-430 L175,-250 L-175,-250 Z" fill="url(#${p}sh)"/>
<path d="M-175,-250 H175" stroke="${D(c, 0.35)}" stroke-width="5"/><ellipse cx="0" cy="-430" rx="90" ry="9" fill="${D(c, 0.3)}"/>`,
    };
  },

  candle: (ctx) => {
    const { c, a, p } = ctx;
    const body = 'M-90,-200 L90,-200 L84,-12 Q82,0 66,0 L-66,0 Q-82,0 -84,-12 Z';
    return {
      w: 92,
      h: 275,
      defs: `${cylGrad(`${p}g`, c)}<clipPath id="${p}cl"><path d="${body}"/></clipPath>
<radialGradient id="${p}fl" cx=".5" cy=".65" r=".6"><stop offset="0" stop-color="#fff6d8"/><stop offset=".55" stop-color="#ffb648"/><stop offset="1" stop-color="#f08a24"/></radialGradient>
<radialGradient id="${p}gl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffd27a" stop-opacity=".55"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>`,
      body: `<circle cx="0" cy="-236" r="78" fill="url(#${p}gl)"/>
<path d="${body}" fill="url(#${p}g)"/>
<g clip-path="url(#${p}cl)">${speckles(ctx, 50, -90, -195, 90, -5, 0.4)}${shine(-66, -186, 14, 150, 0.15)}</g>
<rect x="-50" y="-138" width="100" height="58" rx="4" fill="#f4eee3"/><rect x="-36" y="-122" width="72" height="5" rx="2" fill="${a}"/><rect x="-26" y="-108" width="52" height="4" rx="2" fill="#b9ab98"/>
<ellipse cx="0" cy="-200" rx="90" ry="14" fill="${D(c, 0.1)}"/><ellipse cx="0" cy="-196" rx="82" ry="10" fill="#f3ebdd"/>
<path d="M0,-196 V-214" stroke="#3a2f25" stroke-width="3"/>
<path d="M0,-270 C15,-246 15,-226 0,-213 C-15,-226 -15,-246 0,-270 Z" fill="url(#${p}fl)"/>`,
    };
  },

  cushion: (ctx) => {
    const { c, a, p } = ctx;
    const body = 'M-210,-400 Q0,-418 210,-400 Q226,-205 210,-12 Q0,6 -210,-12 Q-226,-205 -210,-400 Z';
    return {
      w: 230,
      h: 420,
      defs: `<pattern id="${p}bp" width="70" height="70" patternUnits="userSpaceOnUse"><rect width="70" height="70" fill="${c}"/>
<g fill="${a}" opacity=".9"><circle cx="35" cy="35" r="7"/><circle cx="35" cy="17" r="4"/><circle cx="35" cy="53" r="4"/><circle cx="17" cy="35" r="4"/><circle cx="53" cy="35" r="4"/>
<path d="M0,0 l8,4 -8,4 -8,-4 Z M70,0 l8,4 -8,4 -8,-4 Z M0,70 l8,4 -8,4 -8,-4 Z M70,70 l8,4 -8,4 -8,-4 Z"/></g></pattern>
<radialGradient id="${p}sh" cx=".5" cy=".45" r=".65"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></radialGradient>`,
      body: `<path d="${body}" fill="url(#${p}bp)"/><path d="${body}" fill="url(#${p}sh)"/>
<path d="${body}" fill="none" stroke="${D(c, 0.25)}" stroke-width="5"/>
${[[-210, -400], [210, -400], [-210, -12], [210, -12]].map(([x, y]) => `<path d="M${x},${y} l${x < 0 ? -14 : 14},${y < -100 ? -10 : 14} M${x},${y} l${x < 0 ? -18 : 18},${y < -100 ? 2 : 4}" stroke="${a}" stroke-width="4" stroke-linecap="round"/>`).join('')}`,
    };
  },

  macrame: (ctx) => {
    const { c } = ctx;
    const cords: number[] = [];
    for (let i = 0; i < 12; i++) cords.push(-165 + i * 30);
    let lines = '';
    for (const x of cords) {
      const end = 300 - Math.abs(x) * 0.5;
      lines += `<path d="M${x},-272 V80" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`;
      lines += `<path d="M${x},80 L${x - 6},${f(end)} M${x},80 L${x},${f(end + 4)} M${x},80 L${x + 6},${f(end)}" stroke="${L(c, 0.2)}" stroke-width="2.4" stroke-linecap="round"/>`;
    }
    let knots = '';
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 11; j++) {
        if ((i + j) % 2 !== 0) continue;
        if (Math.abs(j - 5) > 5 - Math.abs(i - 3)) continue;
        const x = -150 + j * 30;
        const y = -220 + i * 40;
        knots += `<ellipse cx="${x}" cy="${y}" rx="16" ry="10" fill="${D(c, 0.08)}" stroke="${D(c, 0.25)}" stroke-width="1.5"/>`;
      }
    }
    return {
      flat: true,
      w: 210,
      h: 670,
      defs: '',
      body: `<g transform="translate(0 30)"><path d="M-200,-272 L0,-360 L200,-272" fill="none" stroke="${c}" stroke-width="3"/>
<circle cx="0" cy="-362" r="5" fill="#8a7f72"/>
${lines}${knots}
<rect x="-180" y="52" width="360" height="22" rx="10" fill="${D(c, 0.1)}" stroke="${D(c, 0.25)}" stroke-width="1.5"/>
<rect x="-210" y="-284" width="420" height="18" rx="9" fill="#9c7650"/><rect x="-210" y="-284" width="420" height="6" rx="3" fill="#b8916a"/></g>`,
    };
  },

  planter: (ctx) => {
    const { c, p, r } = ctx;
    let leaves = '';
    const specs: Array<[number, number, number]> = [
      [-50, -70, 300], [-22, -30, 380], [8, 10, 410], [36, 40, 340], [62, 85, 270], [-70, -110, 230],
    ];
    for (const [x0, dx, H] of specs) {
      const tipx = x0 + dx;
      const tipy = -210 - H;
      const g = r() > 0.5 ? '#4f6b3a' : '#5d7a44';
      leaves += `<path d="M${x0 - 13},-205 C${x0 - 18},${-210 - H * 0.5} ${tipx - 8},${tipy + 50} ${tipx},${tipy} C${tipx + 8},${tipy + 50} ${x0 + 18},${-210 - H * 0.5} ${x0 + 13},-205 Z" fill="${g}" stroke="#c8b45a" stroke-width="2.5"/>`;
      leaves += `<path d="M${x0},-215 Q${x0 + dx * 0.5},${-210 - H * 0.6} ${tipx},${tipy + 10}" stroke="#86a06a" stroke-width="1.5" fill="none" opacity=".6"/>`;
    }
    return {
      w: 130,
      h: 630,
      defs: `${cylGrad(`${p}g`, c)}`,
      body: `<ellipse cx="0" cy="-208" rx="112" ry="13" fill="#4a3426"/>${leaves}
<path d="M-110,-172 L110,-172 L88,-8 Q86,0 74,0 L-74,0 Q-86,0 -88,-8 Z" fill="url(#${p}g)"/>
<rect x="-122" y="-212" width="244" height="44" rx="7" fill="url(#${p}g)"/>
<path d="M-118,-168 H118" stroke="${D(c, 0.35)}" stroke-width="3" opacity=".6"/>
${speckles({ ...ctx, c: '#2a2a2a' }, 20, -100, -160, 100, -10, 0.25)}`,
    };
  },
};

// ---------- scenes ----------

type Theme = 'warm' | 'soft' | 'sage' | 'linen' | 'stone' | 'blush';

const THEMES: Record<Theme, { wall: [string, string]; table: [string, string] }> = {
  warm: { wall: ['#f3e9db', '#e8d7c0'], table: ['#c9996a', '#a87a4e'] },
  soft: { wall: ['#f7f1e8', '#eee3d4'], table: ['#e9ded0', '#ddd0bf'] },
  sage: { wall: ['#e6e8dc', '#d6dac8'], table: ['#dcb88f', '#c69f73'] },
  linen: { wall: ['#efe7da', '#e6dccc'], table: ['#efe7da', '#e6dccc'] },
  stone: { wall: ['#dfd9d1', '#d2cbc1'], table: ['#dfd9d1', '#d2cbc1'] },
  blush: { wall: ['#f3e2d8', '#ead2c5'], table: ['#f3e2d8', '#ead2c5'] },
};

function background(w: number, h: number, theme: Theme, tableY: number | null, id: string): { defs: string; body: string } {
  const t = THEMES[theme];
  let defs = `<linearGradient id="${id}wall" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${t.wall[0]}"/><stop offset="1" stop-color="${t.wall[1]}"/></linearGradient>
<radialGradient id="${id}sun" cx=".2" cy=".15" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="${id}blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>`;
  let body = `<rect width="${w}" height="${h}" fill="url(#${id}wall)"/><rect width="${w}" height="${h}" fill="url(#${id}sun)"/>`;
  if (tableY !== null) {
    defs += `<linearGradient id="${id}tab" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${t.table[0]}"/><stop offset="1" stop-color="${t.table[1]}"/></linearGradient>`;
    body += `<rect y="${tableY}" width="${w}" height="${h - tableY}" fill="url(#${id}tab)"/>`;
    if (theme === 'warm' || theme === 'sage') {
      for (let i = 0; i < 6; i++) {
        const y = tableY + 30 + i * ((h - tableY) / 6);
        body += `<path d="M0,${f(y)} C${w * 0.3},${f(y - 8)} ${w * 0.6},${f(y + 10)} ${w},${f(y - 4)}" stroke="#000" stroke-opacity=".05" stroke-width="2" fill="none"/>`;
      }
    }
    body += `<rect y="${tableY}" width="${w}" height="3" fill="#fff" opacity=".25"/>`;
  } else {
    // fabric texture for flat-lays
    defs += `<pattern id="${id}fab" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0,4H8M4,0V8" stroke="#000" stroke-opacity=".035" stroke-width="1"/></pattern>
<radialGradient id="${id}vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></radialGradient>`;
    body += `<rect width="${w}" height="${h}" fill="url(#${id}fab)"/><rect width="${w}" height="${h}" fill="url(#${id}vig)"/>`;
  }
  return { defs, body };
}

function svgDoc(w: number, h: number, defs: string, body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${defs}</defs>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s*\n\s*/g, ' '))}`;
}

function drawSpec(spec: ArtSpec, prefix: string): Drawn {
  const ctx: Ctx = {
    c: spec.color,
    a: spec.accent ?? '#2f4a7a',
    p: prefix,
    r: makeRng(`${spec.kind}|${spec.color}|${spec.seed ?? ''}|${prefix}`),
    pattern: spec.pattern,
  };
  return DRAW[spec.kind](ctx);
}

function prop(scene: number, x: number, y: number): string {
  if (scene !== 2) return '';
  // a small sprig + pebbles as a styling prop
  return `<g transform="translate(${x} ${y}) scale(2)"><ellipse cx="0" cy="0" rx="34" ry="12" fill="#cfc3b3"/><ellipse cx="40" cy="6" rx="22" ry="9" fill="#bfb2a1"/>
<path d="M-60,4 Q-20,-30 30,-70" stroke="#6b5a3e" stroke-width="2.5" fill="none"/>
<ellipse cx="-30" cy="-18" rx="14" ry="5" fill="#8a9a68" transform="rotate(-40 -30 -18)"/><ellipse cx="0" cy="-42" rx="14" ry="5" fill="#7d8c5c" transform="rotate(-55 0 -42)"/><ellipse cx="22" cy="-60" rx="12" ry="4.5" fill="#93a06e" transform="rotate(-30 22 -60)"/></g>`;
}

/** Render a single product image. scene 0 = hero, 1 = detail close-up, 2 = styled. */
export function productArt(spec: ArtSpec, scene: 0 | 1 | 2 = 0): string {
  const S = 800;
  const d = drawSpec(spec, 'o');
  if (d.flat) {
    const theme: Theme = scene === 0 ? 'linen' : scene === 1 ? 'stone' : 'blush';
    const bg = background(S, S, theme, null, 'b');
    const fit = Math.min(560 / (2 * d.w), 600 / d.h);
    const scale = scene === 1 ? fit * 1.45 : scene === 2 ? fit * 0.82 : fit;
    const cx = scene === 2 ? 430 : 400;
    const cy = scene === 1 ? 470 : 400;
    const defs = `${bg.defs}${d.defs}<filter id="ds" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="6" dy="12" stdDeviation="9" flood-color="#3b2a1a" flood-opacity=".22"/></filter>`;
    const extra = scene === 2 ? `<circle cx="120" cy="690" r="120" fill="#e8dccb"/><circle cx="120" cy="690" r="92" fill="#f2e9dd"/>${prop(2, 650, 140)}` : '';
    return svgDoc(S, S, defs, `${bg.body}${extra}<g filter="url(#ds)" transform="translate(${cx} ${cy}) scale(${f(scale * 100) / 100})">${d.body}</g>`);
  }

  const theme: Theme = scene === 0 ? 'warm' : scene === 1 ? 'soft' : 'sage';
  const tableY = scene === 1 ? 640 : 600;
  const bg = background(S, S, theme, tableY, 'b');
  const fit = Math.min(1.7, 470 / d.h, 560 / (2 * d.w));
  const scale = scene === 1 ? fit * 1.5 : scene === 2 ? fit * 0.82 : fit;
  const cx = scene === 2 ? 440 : scene === 1 ? 430 : 400;
  const baseY = scene === 1 ? 760 : scene === 2 ? 670 : 650;
  const shadow = `<ellipse cx="${cx}" cy="${baseY + 2}" rx="${f(d.w * scale * 1.05)}" ry="${f(16 * scale + 6)}" fill="#3b2a1a" opacity=".3" filter="url(#bblur)"/>`;
  const extra = scene === 2 ? prop(2, 130, baseY - 6) : '';
  return svgDoc(S, S, `${bg.defs}${d.defs}`, `${bg.body}${extra}${shadow}<g transform="translate(${cx} ${baseY}) scale(${f(scale * 100) / 100})">${d.body}</g>`);
}

export interface CompositeItem {
  spec: ArtSpec;
  x: number;
  baseY: number;
  scale: number;
}

/** Wide multi-object scenes for hero banners and category headers. */
export function compositeArt(width: number, height: number, items: CompositeItem[], theme: Theme = 'warm', tableY?: number): string {
  const ty = tableY ?? Math.round(height * 0.74);
  const bg = background(width, height, theme, ty, 'b');
  let defs = bg.defs;
  let body = bg.body;
  // soft window light beams
  body += `<path d="M${width * 0.08},0 L${width * 0.22},0 L${width * 0.42},${ty} L${width * 0.26},${ty} Z" fill="#fff" opacity=".12"/>
<path d="M${width * 0.26},0 L${width * 0.33},0 L${width * 0.53},${ty} L${width * 0.45},${ty} Z" fill="#fff" opacity=".09"/>`;
  items.forEach((it, i) => {
    const d = drawSpec(it.spec, `i${i}`);
    defs += d.defs;
    body += `<ellipse cx="${it.x}" cy="${it.baseY + 2}" rx="${f(d.w * it.scale * 1.05)}" ry="${f(16 * it.scale + 6)}" fill="#3b2a1a" opacity=".28" filter="url(#bblur)"/>`;
    body += `<g transform="translate(${it.x} ${it.baseY}) scale(${it.scale})">${d.body}</g>`;
  });
  return svgDoc(width, height, defs, body);
}
