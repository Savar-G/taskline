export const SETTINGS_VERSION = 1;

export type SourceRole = "tasks" | "inbox";
export type EditPolicy = "route" | "stay";
export type GroupMode = "flat" | "by-heading";

export interface TaskSourceSetting {
  id: string;
  label: string;
  path: string;
  role: SourceRole;
  groupId?: string;
  editPolicy: EditPolicy;
  proposals: boolean;
}

export interface SourceGroupSetting {
  id: string;
  label: string;
  mode: GroupMode;
  ownerDisplay: boolean;
  color?: string;
}

export interface AreaSetting {
  id: string;
  label: string;
  sourceId: string;
  heading: string;
  color?: string;
}

export interface CaptureRouteSetting {
  tag: string;
  aliases: string[];
  destination: { sourceId: string; heading: string };
  keywords: string[];
  showAsChip: boolean;
}

export interface TagFilterSetting {
  tag: string;
  label: string;
  color?: string;
}

export interface TasklineSettings {
  version: number;
  sources: TaskSourceSetting[];
  sourceGroups: SourceGroupSetting[];
  areas: AreaSetting[];
  captureRoutes: CaptureRouteSetting[];
  tagFilters: TagFilterSetting[];
  displayOrder: string[];
  fallbackCaptureDestination: { sourceId: string; heading: string } | null;
  ownerSelfAliases: string[];
}

export interface SettingsIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface RuntimeWorkspace {
  settings: TasklineSettings;
  issues: SettingsIssue[];
  configured: boolean;
  sources: TaskSourceSetting[];
  sourceById: Map<string, TaskSourceSetting>;
  sourceByPath: Map<string, TaskSourceSetting>;
  groupById: Map<string, SourceGroupSetting>;
  areaById: Map<string, AreaSetting>;
  areasBySourceHeading: Map<string, AreaSetting>;
  routeByTag: Map<string, CaptureRouteSetting>;
  tagFilterByTag: Map<string, TagFilterSetting>;
  displayRank: Map<string, number>;
  selfAliases: Set<string>;
}

export const DEFAULT_SETTINGS: TasklineSettings = {
  version: SETTINGS_VERSION,
  sources: [],
  sourceGroups: [],
  areas: [],
  captureRoutes: [],
  tagFilters: [],
  displayOrder: [],
  fallbackCaptureDestination: null,
  ownerSelfAliases: [],
};

export function normalizeVaultPath(path: string): string {
  const segments = path.trim().replace(/\\/g, "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/");
}

function isUnsafeVaultPath(path: string): boolean {
  const trimmed = path.trim();
  return /^[/\\]/.test(trimmed)
    || /^[a-zA-Z]:[/\\]/.test(trimmed)
    || trimmed.replace(/\\/g, "/").split("/").includes("..");
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  const result = text(value).trim();
  return result || undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  issues: SettingsIssue[]
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  issues.push({ level: "error", path, message: `Expected one of: ${allowed.join(", ")}.` });
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean, path: string, issues: SettingsIssue[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  issues.push({ level: "error", path, message: "Expected a boolean." });
  return fallback;
}

function colorValue(value: unknown, path: string, issues: SettingsIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ level: "error", path, message: "Expected a non-empty CSS color string." });
    return undefined;
  }
  const color = value.trim();
  if (!/^(--[\w-]+|var\(--[\w-]+\)|#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^\r\n]+\)|[a-zA-Z]+)$/.test(color)) {
    issues.push({ level: "error", path, message: "Expected a CSS color name, hex/rgb/hsl value, or CSS variable." });
    return undefined;
  }
  return color;
}

function stringArray(value: unknown, path: string, issues: SettingsIssue[]): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push({ level: "error", path, message: "Expected an array." });
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") result.push(item);
    else issues.push({ level: "error", path: `${path}.${index}`, message: "Expected a string." });
  });
  return result;
}

function objectArray<T>(
  value: unknown,
  path: string,
  issues: SettingsIssue[],
  decode: (item: UnknownRecord, index: number) => T
): T[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push({ level: "error", path, message: "Expected an array." });
    return [];
  }
  const result: T[] = [];
  value.forEach((item, index) => {
    const raw = record(item);
    if (raw) result.push(decode(raw, index));
    else issues.push({ level: "error", path: `${path}.${index}`, message: "Expected an object." });
  });
  return result;
}

function decodeSettings(data: unknown): { settings: TasklineSettings; issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = [];
  const raw = record(data) ?? {};
  if (data !== undefined && data !== null && !record(data)) {
    issues.push({ level: "error", path: "settings", message: "Expected a settings object." });
  }
  const version = raw.version === undefined ? SETTINGS_VERSION : raw.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    issues.push({ level: "error", path: "version", message: "Schema version must be an integer." });
  } else if (version > SETTINGS_VERSION) {
    issues.push({ level: "error", path: "version", message: `Unsupported future schema version: ${version}` });
  } else if (version < 1) {
    issues.push({ level: "error", path: "version", message: `Unsupported schema version: ${version}` });
  }

  const fallbackRaw = raw.fallbackCaptureDestination === null || raw.fallbackCaptureDestination === undefined
    ? null
    : record(raw.fallbackCaptureDestination);
  if (raw.fallbackCaptureDestination !== null && raw.fallbackCaptureDestination !== undefined && !fallbackRaw) {
    issues.push({ level: "error", path: "fallbackCaptureDestination", message: "Expected an object or null." });
  }

  return {
    issues,
    settings: {
      version: SETTINGS_VERSION,
      sources: objectArray(raw.sources, "sources", issues, (source, index) => {
        const path = text(source.path);
        if (isUnsafeVaultPath(path)) {
          issues.push({ level: "error", path: `sources.${index}.path`, message: "Source path must stay within the vault." });
        }
        return {
          id: text(source.id).trim(),
          label: text(source.label).trim(),
          path: normalizeVaultPath(path),
          role: enumValue(source.role, ["tasks", "inbox"], "tasks", `sources.${index}.role`, issues),
          groupId: optionalText(source.groupId),
          editPolicy: enumValue(source.editPolicy, ["route", "stay"], "route", `sources.${index}.editPolicy`, issues),
          proposals: booleanValue(source.proposals, false, `sources.${index}.proposals`, issues),
        };
      }),
      sourceGroups: objectArray(raw.sourceGroups, "sourceGroups", issues, (group, index) => ({
        id: text(group.id).trim(),
        label: text(group.label).trim(),
        mode: enumValue(group.mode, ["flat", "by-heading"], "flat", `sourceGroups.${index}.mode`, issues),
        ownerDisplay: booleanValue(group.ownerDisplay, false, `sourceGroups.${index}.ownerDisplay`, issues),
        color: colorValue(group.color, `sourceGroups.${index}.color`, issues),
      })),
      areas: objectArray(raw.areas, "areas", issues, (area, index) => ({
        id: text(area.id).trim(),
        label: text(area.label).trim(),
        sourceId: text(area.sourceId).trim(),
        heading: text(area.heading).trim(),
        color: colorValue(area.color, `areas.${index}.color`, issues),
      })),
      captureRoutes: objectArray(raw.captureRoutes, "captureRoutes", issues, (route, index) => {
        const destination = record(route.destination);
        if (!destination) issues.push({ level: "error", path: `captureRoutes.${index}.destination`, message: "Destination is required and must be an object." });
        return {
          tag: lower(text(route.tag)),
          aliases: stringArray(route.aliases, "captureRoutes.aliases", issues).map(lower).filter(Boolean),
          destination: {
            sourceId: text(destination?.sourceId).trim(),
            heading: text(destination?.heading).trim(),
          },
          keywords: stringArray(route.keywords, "captureRoutes.keywords", issues).map(lower).filter(Boolean),
          showAsChip: booleanValue(route.showAsChip, true, `captureRoutes.${index}.showAsChip`, issues),
        };
      }),
      tagFilters: objectArray(raw.tagFilters, "tagFilters", issues, (filter, index) => ({
        tag: lower(text(filter.tag)),
        label: text(filter.label).trim() || text(filter.tag),
        color: colorValue(filter.color, `tagFilters.${index}.color`, issues),
      })),
      displayOrder: stringArray(raw.displayOrder, "displayOrder", issues),
      fallbackCaptureDestination: fallbackRaw ? {
        sourceId: text(fallbackRaw.sourceId).trim(),
        heading: text(fallbackRaw.heading).trim(),
      } : null,
      ownerSelfAliases: stringArray(raw.ownerSelfAliases, "ownerSelfAliases", issues).map(lower).filter(Boolean),
    },
  };
}

export function createSettingsDraft(active: TasklineSettings, rejectedRaw: unknown): Record<string, unknown> {
  const rejected = record(rejectedRaw);
  const source = rejected ? { ...active, ...rejected } : active;
  return JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
}

export function compileWorkspace(data: unknown): RuntimeWorkspace {
  const decoded = decodeSettings(data);
  const settings = decoded.settings;
  const issues: SettingsIssue[] = [...decoded.issues];
  const sourceById = new Map<string, TaskSourceSetting>();
  const sourceByPath = new Map<string, TaskSourceSetting>();
  const groupById = new Map<string, SourceGroupSetting>();
  const areaById = new Map<string, AreaSetting>();
  const areasBySourceHeading = new Map<string, AreaSetting>();
  const routeByTag = new Map<string, CaptureRouteSetting>();
  const tagFilterByTag = new Map<string, TagFilterSetting>();

  const duplicate = <T>(map: Map<string, T>, key: string, path: string, kind: string, value: T): void => {
    if (!key) {
      issues.push({ level: "error", path, message: `${kind} is required.` });
    } else if (map.has(key)) {
      issues.push({ level: "error", path, message: `Duplicate ${kind}: ${key}` });
    } else {
      map.set(key, value);
    }
  };

  settings.sourceGroups.forEach((group, index) => duplicate(groupById, group.id, `sourceGroups.${index}.id`, "group ID", group));
  settings.sources.forEach((source, index) => {
    duplicate(sourceById, source.id, `sources.${index}.id`, "source ID", source);
    duplicate(sourceByPath, lower(source.path), `sources.${index}.path`, "source path", source);
    if (!source.path) issues.push({ level: "error", path: `sources.${index}.path`, message: "Source path is required." });
    if (!source.label) issues.push({ level: "error", path: `sources.${index}.label`, message: "Source label is required." });
    if (source.groupId && !groupById.has(source.groupId)) {
      issues.push({ level: "error", path: `sources.${index}.groupId`, message: `Unknown source group: ${source.groupId}` });
    }
  });
  settings.areas.forEach((area, index) => {
    duplicate(areaById, area.id, `areas.${index}.id`, "area ID", area);
    if (!sourceById.has(area.sourceId)) {
      issues.push({ level: "error", path: `areas.${index}.sourceId`, message: `Unknown source: ${area.sourceId}` });
    }
    if (!area.label) issues.push({ level: "error", path: `areas.${index}.label`, message: "Area label is required." });
    if (!area.heading) issues.push({ level: "error", path: `areas.${index}.heading`, message: "Area heading is required." });
    const key = `${area.sourceId}\u0000${lower(area.heading)}`;
    duplicate(areasBySourceHeading, key, `areas.${index}.heading`, "source/heading", area);
  });
  settings.captureRoutes.forEach((route, index) => {
    const tags = [route.tag, ...route.aliases];
    tags.forEach((tag) => duplicate(routeByTag, tag, `captureRoutes.${index}`, "capture tag or alias", route));
    if (!sourceById.has(route.destination.sourceId)) {
      issues.push({ level: "error", path: `captureRoutes.${index}.destination.sourceId`, message: `Unknown source: ${route.destination.sourceId}` });
    }
    if (!route.destination.heading) {
      issues.push({ level: "error", path: `captureRoutes.${index}.destination.heading`, message: "Destination heading is required." });
    }
    for (const tag of tags) {
      if (tag && !/^[\w/-]+$/.test(tag)) {
        issues.push({ level: "error", path: `captureRoutes.${index}`, message: `Invalid capture tag: ${tag}` });
      }
    }
  });
  settings.tagFilters.forEach((filter, index) => duplicate(tagFilterByTag, filter.tag, `tagFilters.${index}.tag`, "tag filter", filter));

  if (settings.fallbackCaptureDestination && !sourceById.has(settings.fallbackCaptureDestination.sourceId)) {
    issues.push({ level: "error", path: "fallbackCaptureDestination.sourceId", message: `Unknown source: ${settings.fallbackCaptureDestination.sourceId}` });
  }
  if (settings.fallbackCaptureDestination && !settings.fallbackCaptureDestination.heading) {
    issues.push({ level: "error", path: "fallbackCaptureDestination.heading", message: "Fallback heading is required." });
  }
  settings.displayOrder.forEach((id, index) => {
    if (!areaById.has(id) && !groupById.has(id)) {
      issues.push({ level: "warning", path: `displayOrder.${index}`, message: `Unknown area or group: ${id}` });
    }
  });

  const displayRank = new Map(settings.displayOrder.map((id, index) => [id, index]));
  return {
    settings,
    issues,
    configured: settings.sources.length > 0 && !issues.some((issue) => issue.level === "error"),
    sources: settings.sources,
    sourceById,
    sourceByPath,
    groupById,
    areaById,
    areasBySourceHeading,
    routeByTag,
    tagFilterByTag,
    displayRank,
    selfAliases: new Set(settings.ownerSelfAliases),
  };
}

export function workspaceColor(workspace: RuntimeWorkspace, key: string): string | undefined {
  const normalized = lower(key);
  const area = workspace.areaById.get(key)
    ?? workspace.settings.areas.find((item) => lower(item.label) === normalized || lower(item.heading) === normalized);
  if (area?.color) return area.color;
  const group = workspace.groupById.get(key)
    ?? workspace.settings.sourceGroups.find((item) => lower(item.label) === normalized);
  if (group?.color) return group.color;
  const filterColor = workspace.tagFilterByTag.get(normalized)?.color;
  if (filterColor) return filterColor;
  const destination = workspace.routeByTag.get(normalized)?.destination;
  return destination
    ? workspace.areasBySourceHeading.get(`${destination.sourceId}\u0000${lower(destination.heading)}`)?.color
    : undefined;
}
