import type { RuntimeWorkspace } from "../settings";
import { workspaceColor } from "../settings";

const HASH_PALETTE = [
  "--color-orange",
  "--color-blue",
  "--color-green",
  "--color-purple",
  "--color-pink",
  "--color-cyan",
  "--color-yellow",
  "--color-red",
];

function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function cssColor(value: string): string {
  if (value.startsWith("var(") || value.startsWith("#") || value.startsWith("rgb") || value.startsWith("hsl")) return value;
  return `var(${value.startsWith("--") ? value : `--${value}`})`;
}

export function areaColor(area: string, workspace?: RuntimeWorkspace): string {
  const configured = workspace ? workspaceColor(workspace, area) : undefined;
  if (configured) return cssColor(configured);
  const picked = HASH_PALETTE[hashString(area.trim().toLowerCase()) % HASH_PALETTE.length];
  return `var(${picked})`;
}
