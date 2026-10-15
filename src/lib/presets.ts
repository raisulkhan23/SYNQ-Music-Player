/**
 * SYNQ theme presets — compact preset architecture.
 *
 * A preset is the smallest app-wide visual identity switch SYNQ supports:
 * scene + accent family + a few ambient surface tokens. It is deliberately NOT
 * a second theme engine: it reuses the existing `.dark` / `.light` / `.amoled`
 * + `data-scene` + `--tint` / `--brand` / `--primary` / `--ring` model, and it
 * only adds the small number of coordinated tokens a preset genuinely needs.
 *
 * Presets are stored as a compact id. Customization is stored separately as
 * overrides (accent override, scene override, etc.), so the preset catalog can
 * grow without rewriting persistence or the settings UI.
 */

/** A preset id the app understands. */
export type PresetId =
  | "snqx-studio"
  | "snqx-midnight"
  | "snqx-aurora"
  | "snqx-eclipse"
  | "snqx-nebula"
  | "snqx-sakura-day"
  | "snqx-sakura-night"
  | "snqx-forest"
  | "snqx-ocean"
  | "snqx-sunset"
  | "snqx-autumn"
  | "snqx-winter"
  | "snqx-pure-amoled"
  | "snqx-graphite"
  | "snqx-cloud"
  | "snqx-frost"
  | "snqx-cyber"
  | "snqx-synthwave"
  | "snqx-neon-lime"
  | "snqx-electric-violet"
  | "snqx-electric-blue"
  | "snqx-coffee"
  | "snqx-rainy-night"
  | "snqx-dream"
  | "snqx-focus"
  | "snqx-late-night"
  | "snqx-original-studio"
  | "snqx-original-night"
  | "snqx-original-neon";

export interface PresetMeta {
  /** Stable id. */
  id: PresetId;
  /** Human label. */
  name: string;
  /** Short, honest descriptor. */
  tagline: string;
  /** Category label for the picker tab. */
  category: PresetCategory;
  /** Which existing SYNQ scene this preset prefers. */
  scene?: string;
  /** When present, overrides the scene default `--tint`. */
  tint?: string;
  /** Accent family hint for the picker card + any future accent presets. */
  accentFamily?: string;
  /** Compact preview swatch so the picker can render a face without a wallpapers
      pack. Three stops: background depth, surface, accent glow. */
  preview?: string;
  /** When true, the preset prefers reduced ambient motion — useful for calm /
      low-distraction presets without hard-clobbering the app-level motion flag. */
  calm?: boolean;
}

export type PresetCategory =
  | "Recommended"
  | "SYNQ Originals"
  | "Cinematic"
  | "Nature"
  | "Seasonal"
  | "Colorful"
  | "Minimal"
  | "Mood";

/** The curated catalog. Quality over quantity: each preset is distinct. */
export const PRESETS: ReadonlyArray<PresetMeta> = [
  // Recommended: small, strong starting points.
  {
    id: "snqx-studio",
    name: "Studio",
    tagline: "SYNQ's default, tuned for music-first focus",
    category: "Recommended",
    scene: "studio",
    accentFamily: "SYNQ Lime",
    preview: "203 244 143",
  },
  {
    id: "snqx-midnight",
    name: "Midnight",
    tagline: "Deep, cinematic, almost no noise",
    category: "Recommended",
    scene: "midnight",
    accentFamily: "Cool blue",
    preview: "262 255 255",
  },
  {
    id: "snqx-aurora",
    name: "Aurora",
    tagline: "Cool atmospheric glow, soft and calm",
    category: "Recommended",
    scene: "aurora",
    accentFamily: "Violet + cyan",
    preview: "167 139 250",
  },
  {
    id: "snqx-neon-lime",
    name: "Neon Lime",
    tagline: "SYNQ's own accent, with control around it",
    category: "Recommended",
    scene: "studio",
    accentFamily: "SYNQ Lime",
    tint: "203 244 143",
    calm: true,
  },

  // SYNQ Originals.
  {
    id: "snqx-original-studio",
    name: "SYNQ Studio",
    tagline: "The official SYNQ atmosphere, unhurried",
    category: "SYNQ Originals",
    scene: "studio",
    accentFamily: "SYNQ Lime",
    preview: "203 244 143",
  },
  {
    id: "snqx-original-night",
    name: "SYNQ Night",
    tagline: "Darker default, lime keeps its place",
    category: "SYNQ Originals",
    scene: "night",
    accentFamily: "SYNQ Lime",
    tint: "203 244 143",
    calm: true,
  },
  {
    id: "snqx-original-neon",
    name: "SYNQ Neon",
    tagline: "SYNQ lime plus a stronger ambient glow",
    category: "SYNQ Originals",
    scene: "studio",
    accentFamily: "SYNQ Lime + cyan",
    tint: "203 244 143",
  },

  // Cinematic.
  {
    id: "snqx-eclipse",
    name: "Eclipse",
    tagline: "Near-black with violet/blue lighting",
    category: "Cinematic",
    scene: "eclipse",
    accentFamily: "Violet + blue",
    preview: "167 139 250",
  },
  {
    id: "snqx-nebula",
    name: "Nebula",
    tagline: "Soft purple-cyan ambient atmosphere",
    category: "Cinematic",
    scene: "nebula",
    accentFamily: "Violet + cyan",
    preview: "167 139 250",
  },

  // Nature.
  {
    id: "snqx-forest",
    name: "Forest",
    tagline: "Deep green, calm and grounded",
    category: "Nature",
    scene: "forest",
    accentFamily: "Emerald",
    preview: "76 143 43",
  },
  {
    id: "snqx-ocean",
    name: "Ocean",
    tagline: "Cool teal and calm water tones",
    category: "Nature",
    scene: "tide",
    accentFamily: "Teal",
    preview: "45 212 191",
  },
  {
    id: "snqx-coffee",
    name: "Coffee",
    tagline: "Warm brown, cream and amber comfort",
    category: "Nature",
    scene: "coffee",
    accentFamily: "Amber",
    preview: "251 146 60",
  },

  // Seasonal.
  {
    id: "snqx-sakura-day",
    name: "Sakura Day",
    tagline: "Soft pink, warm cream, gentle daylight",
    category: "Seasonal",
    scene: "sakura-day",
    accentFamily: "Soft pink",
    preview: "251 180 200",
  },
  {
    id: "snqx-sakura-night",
    name: "Sakura Night",
    tagline: "Moonlit pinks over deep violet ambience",
    category: "Seasonal",
    scene: "sakura-night",
    accentFamily: "Moonlit pink",
    preview: "251 146 60",
  },
  {
    id: "snqx-sunset",
    name: "Sunset",
    tagline: "Plum, orange and warm dusk light",
    category: "Seasonal",
    scene: "sunset",
    accentFamily: "Warm orange",
    preview: "251 146 60",
  },
  {
    id: "snqx-autumn",
    name: "Autumn",
    tagline: "Burnt orange over deep brown-plum",
    category: "Seasonal",
    scene: "autumn",
    accentFamily: "Burnt orange",
    preview: "251 146 60",
  },
  {
    id: "snqx-winter",
    name: "Winter",
    tagline: "Icy cyan, silver highlights, frosted feel",
    category: "Seasonal",
    scene: "winter",
    accentFamily: "Icy cyan",
    preview: "45 212 191",
  },

  // Colorful / Expressive.
  {
    id: "snqx-cyber",
    name: "Cyber",
    tagline: "Electric cyan and violet, controlled glow",
    category: "Colorful",
    scene: "cyber",
    accentFamily: "Electric cyan + violet",
    preview: "45 212 191",
  },
  {
    id: "snqx-synthwave",
    name: "Synthwave",
    tagline: "Deep purple, pink and electric blue",
    category: "Colorful",
    scene: "synthwave",
    accentFamily: "Pink + electric blue",
    preview: "251 146 60",
  },
  {
    id: "snqx-electric-violet",
    name: "Electric Violet",
    tagline: "Deep indigo with magenta highlights",
    category: "Colorful",
    scene: "violet",
    accentFamily: "Magenta",
    preview: "167 139 250",
  },
  {
    id: "snqx-electric-blue",
    name: "Electric Blue",
    tagline: "Bright blue and cyan over dark navy",
    category: "Colorful",
    scene: "electric",
    accentFamily: "Bright blue",
    preview: "45 212 191",
  },

  // Minimal.
  {
    id: "snqx-pure-amoled",
    name: "Pure AMOLED",
    tagline: "True black, minimal surfaces, low glow",
    category: "Minimal",
    scene: "pure-amoled",
    accentFamily: "SYNQ Lime",
    tint: "203 244 143",
    calm: true,
  },
  {
    id: "snqx-graphite",
    name: "Graphite",
    tagline: "Charcoal surfaces, neutral gray accents",
    category: "Minimal",
    scene: "graphite",
    accentFamily: "Neutral gray",
    preview: "200 200 205",
  },
  {
    id: "snqx-frost",
    name: "Frost",
    tagline: "Light, cool and translucent",
    category: "Minimal",
    scene: "frost",
    accentFamily: "Icy blue",
    preview: "45 212 191",
  },
  {
    id: "snqx-cloud",
    name: "Cloud",
    tagline: "Soft light mode, clean and calm",
    category: "Minimal",
    scene: "cloud",
    accentFamily: "Gentle blue",
    preview: "220 225 235",
  },

  // Mood.
  {
    id: "snqx-dream",
    name: "Dream",
    tagline: "Soft purple, pink and blue, gentle glow",
    category: "Mood",
    scene: "dream",
    accentFamily: "Soft pink",
    preview: "251 180 200",
  },
  {
    id: "snqx-rainy-night",
    name: "Rainy Night",
    tagline: "Deep blue-gray, muted cyan, dim light",
    category: "Mood",
    scene: "rainy-night",
    accentFamily: "Muted cyan",
    preview: "120 160 180",
    calm: true,
  },
  {
    id: "snqx-late-night",
    name: "Late Night",
    tagline: "Very dark, muted violet/blue, low brightness",
    category: "Mood",
    scene: "late-night",
    accentFamily: "Muted violet",
    preview: "167 139 250",
    calm: true,
  },
  {
    id: "snqx-focus",
    name: "Focus",
    tagline: "Minimal, low saturation, less distraction",
    category: "Mood",
    scene: "focus",
    accentFamily: "Neutral",
    tint: "180 180 190",
    calm: true,
  },
] as const;

/** Map of id → meta, for quick lookups. */
export const PRESET_BY_ID: Readonly<Record<PresetId, PresetMeta>> =
  Object.fromEntries(PRESETS.map((p) => [p.id, p])) as Readonly<
    Record<PresetId, PresetMeta>
  >;

// Internal catalog sanity check: keep the ids unique and fully mapped.
const _PRESET_IDS = PRESETS.map((p) => p.id);
if (_PRESET_IDS.length !== new Set(_PRESET_IDS).size) {
  const dupes = _PRESET_IDS.filter(
    (k, i, all) => all.indexOf(k) !== all.lastIndexOf(k),
  );
  throw new Error(
    `SYNQ preset catalog contains duplicate ids: ${[...new Set(dupes)].join(", ")}`,
  );
}

for (const [key, value] of Object.entries(PRESET_BY_ID)) {
  const typed = key as PresetId;
  if (!PRESETS.some((p) => p.id === typed)) {
    throw new Error(
      `PRESET_BY_ID contains an id that is not in PRESETS: ${typed}`,
    );
  }
}

/** Presets grouped by category, in catalog order. */
export function presetsByCategory(): ReadonlyArray<{
  category: PresetCategory;
  presets: ReadonlyArray<PresetMeta>;
}> {
  const map = new Map<PresetCategory, PresetMeta[]>();
  for (const preset of PRESETS) {
    const list = map.get(preset.category) ?? [];
    list.push(preset);
    map.set(preset.category, list);
  }
  const order: PresetCategory[] = [
    "Recommended",
    "SYNQ Originals",
    "Cinematic",
    "Nature",
    "Seasonal",
    "Colorful",
    "Minimal",
    "Mood",
  ];
  return order.map((category) => ({
    category,
    presets: map.get(category) ?? [],
  }));
}

/** The compact augmented token set a preset contributes on top of the base. */
export interface PresetTokens {
  /** Current preset id, if one is selected. */
  presetId?: PresetId;
  /** Scene name applied to `data-scene`. */
  scene?: string;
  /** `--tint` as rgb "r g b", or undefined to keep the scene default. */
  tint?: string;
  /** When true, the UI leans into a calmer ambient treatment. */
  calm?: boolean;
  /** Optional accent override (hex RGB "rrggbb"). Stored separately from
      the preset id, so customization survives preset switches. */
  accentOverride?: string;
}

/** Resolve a preset id to its token contribution. */
export function tokensFor(presetId: PresetId | null | undefined): PresetTokens {
  if (!presetId) return {};
  const preset = PRESET_BY_ID[presetId];
  if (!preset) return {};
  return {
    presetId: preset.id,
    scene: preset.scene,
    tint: preset.tint,
    calm: preset.calm ?? false,
  };
}

/** The small set of localStorage keys the preset system owns. */
export const PRESET_KEYS = {
  presetId: "ss.presetId",
  accentOverride: "ss.presetAccentOverride",
} as const;
