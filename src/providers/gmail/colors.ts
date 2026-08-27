import { PostbusError } from "../../types.js";

export interface LabelColor {
  textColor: string;
  backgroundColor: string;
}

// Gmail rejects anything outside this palette with an opaque 400, so validate
// here. Source: Schema$LabelColor in the Gmail API v1 reference.
const ALLOWED = new Set([
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#cccccc",
  "#efefef",
  "#f3f3f3",
  "#ffffff",
  "#fb4c2f",
  "#ffad47",
  "#fad165",
  "#16a766",
  "#43d692",
  "#4a86e8",
  "#a479e2",
  "#f691b3",
  "#f6c5be",
  "#ffe6c7",
  "#fef1d1",
  "#b9e4d0",
  "#c6f3de",
  "#c9daf8",
  "#e4d7f5",
  "#fcdee8",
  "#efa093",
  "#ffd6a2",
  "#fce8b3",
  "#89d3b2",
  "#a0eac9",
  "#a4c2f4",
  "#d0bcf1",
  "#fbc8d9",
  "#e66550",
  "#ffbc6b",
  "#fcda83",
  "#44b984",
  "#68dfa9",
  "#6d9eeb",
  "#b694e8",
  "#f7a7c0",
  "#cc3a21",
  "#eaa041",
  "#f2c960",
  "#149e60",
  "#3dc789",
  "#3c78d8",
  "#8e63ce",
  "#e07798",
  "#ac2b16",
  "#cf8933",
  "#d5ae49",
  "#0b804b",
  "#2a9c68",
  "#285bac",
  "#653e9b",
  "#b65775",
  "#822111",
  "#a46a21",
  "#aa8831",
  "#076239",
  "#1a764d",
  "#1c4587",
  "#41236d",
  "#83334c",
  "#464646",
  "#e7e7e7",
  "#0d3472",
  "#b6cff5",
  "#0d3b44",
  "#98d7e4",
  "#3d188e",
  "#e3d7ff",
  "#711a36",
  "#fbd3e0",
  "#8a1c0a",
  "#f2b2a8",
  "#7a2e0b",
  "#ffc8af",
  "#7a4706",
  "#ffdeb5",
  "#594c05",
  "#fbe983",
  "#684e07",
  "#fdedc1",
  "#0b4f30",
  "#b3efd3",
  "#04502e",
  "#a2dcc1",
  "#c2c2c2",
  "#4986e7",
  "#2da2bb",
  "#b99aff",
  "#994a64",
  "#f691b2",
  "#ff7537",
  "#ffad46",
  "#662e37",
  "#ebdbde",
  "#cca6ac",
  "#094228",
  "#42d692",
  "#16a765",
  "#757575",
  "#1e53b8",
  "#007286",
  "#7858c3",
  "#c2185b",
  "#d93025",
  "#54240e",
  "#633e04",
  "#521d28",
  "#202124",
  "#083018",
]);

const NAMED: Record<string, LabelColor> = {
  red: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  darkred: { backgroundColor: "#cc3a21", textColor: "#ffffff" },
  orange: { backgroundColor: "#ffad47", textColor: "#ffffff" },
  yellow: { backgroundColor: "#fad165", textColor: "#000000" },
  green: { backgroundColor: "#16a766", textColor: "#ffffff" },
  lightgreen: { backgroundColor: "#43d692", textColor: "#000000" },
  teal: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  blue: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  darkblue: { backgroundColor: "#285bac", textColor: "#ffffff" },
  purple: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  pink: { backgroundColor: "#f691b3", textColor: "#ffffff" },
  brown: { backgroundColor: "#7a4706", textColor: "#ffffff" },
  grey: { backgroundColor: "#999999", textColor: "#ffffff" },
  black: { backgroundColor: "#000000", textColor: "#ffffff" },
  white: { backgroundColor: "#ffffff", textColor: "#000000" },
};

export function colorNames(): string[] {
  return Object.keys(NAMED);
}

/** Accepts a colour name, or an explicit pair of hex values from the palette. */
export function resolveLabelColor(input: {
  color?: string;
  backgroundColor?: string;
  textColor?: string;
}): LabelColor {
  if (input.backgroundColor || input.textColor) {
    const backgroundColor = normalize(input.backgroundColor, "background_color");
    const textColor = normalize(input.textColor, "text_color");
    return { backgroundColor, textColor };
  }

  const name = input.color
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  const named = name ? NAMED[name] : undefined;

  if (!named) {
    throw new PostbusError(
      input.color ? `"${input.color}" is not a colour I know.` : "No colour given.",
      `Use one of: ${colorNames().join(", ")}. Or pass background_color and text_color as hex from Gmail's palette.`,
    );
  }

  return named;
}

function normalize(value: string | undefined, field: string): string {
  const hex = value?.trim().toLowerCase();

  if (!hex) {
    throw new PostbusError(
      `${field} is missing.`,
      "Gmail needs both background_color and text_color, or use `color` with a name instead.",
    );
  }

  const full = /^#?[0-9a-f]{6}$/.test(hex) ? (hex.startsWith("#") ? hex : `#${hex}`) : hex;

  if (!ALLOWED.has(full)) {
    throw new PostbusError(
      `Gmail does not allow ${full} as a label colour.`,
      `Gmail only accepts its own palette. Use \`color\` with one of: ${colorNames().join(", ")}.`,
    );
  }

  return full;
}
