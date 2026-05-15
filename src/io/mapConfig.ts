import type { MapSpec } from "../state/types";

export interface MapConfigEntry {
  filename: string;
  realWidthMm: number;
  realHeightMm: number;
}

export interface MapManifestEntry {
  id: string;
  filename: string;
  realWidthMm: number;
  realHeightMm: number;
}

export interface LoadedMap {
  spec: MapSpec;
  image: HTMLImageElement;
  url: string;
}

export interface LoadMapManifestResult {
  maps: MapManifestEntry[];
  defaultMapId: string | null;
  warnings: string[];
}

export interface LoadMapByEntryResult {
  map: LoadedMap | null;
  warnings: string[];
}

interface ParseMapConfigResult {
  entries: MapConfigEntry[];
  defaultFilename: string | null;
  warnings: string[];
}

export function parseMapConfig(text: string): ParseMapConfigResult {
  const entries: MapConfigEntry[] = [];
  let defaultFilename: string | null = null;
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts[0].toLowerCase() === "default") {
      if (parts.length >= 2) {
        defaultFilename = parts.slice(1).join(" ");
      } else {
        warnings.push(`config.txt:${lineIndex + 1} ignored (default expects filename)`);
      }
      continue;
    }

    if (parts.length < 3) {
      warnings.push(`config.txt:${lineIndex + 1} ignored (expected filename width height)`);
      continue;
    }

    const filename = parts.slice(0, -2).join(" ");
    const widthToken = parts[parts.length - 2];
    const heightToken = parts[parts.length - 1];
    const realWidthMm = Number(widthToken);
    const realHeightMm = Number(heightToken);
    if (
      !Number.isFinite(realWidthMm) ||
      !Number.isFinite(realHeightMm) ||
      realWidthMm <= 0 ||
      realHeightMm <= 0
    ) {
      warnings.push(`config.txt:${lineIndex + 1} ignored (invalid dimensions)`);
      continue;
    }

    entries.push({ filename, realWidthMm, realHeightMm });
  }

  return { entries, defaultFilename, warnings };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizePathLower(value: string): string {
  return normalizePath(value).toLowerCase();
}

function normalizeMapId(filename: string): string {
  const normalized = normalizePath(filename);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.[^.]+$/, "");
}

function buildManifest(entries: MapConfigEntry[]): MapManifestEntry[] {
  return entries.map((entry) => ({
    id: normalizeMapId(entry.filename),
    filename: entry.filename,
    realWidthMm: entry.realWidthMm,
    realHeightMm: entry.realHeightMm,
  }));
}

function resolveDefaultMapId(defaultFilename: string | null, maps: MapManifestEntry[]): string | null {
  if (!defaultFilename) {
    return null;
  }
  const target = normalizePathLower(defaultFilename);
  const matched = maps.find((map) => normalizePathLower(map.filename) === target);
  return matched?.id ?? null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

async function fetchConfigText(configUrl: string): Promise<{ text: string | null; warnings: string[] }> {
  try {
    const response = await fetch(configUrl, { cache: "no-cache" });
    if (!response.ok) {
      return {
        text: null,
        warnings: [`Failed to load ${configUrl} (HTTP ${response.status})`],
      };
    }
    return { text: await response.text(), warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: null,
      warnings: [`Failed to load ${configUrl}: ${message}`],
    };
  }
}

export async function loadMapManifest(configUrl = "/maps/config.txt"): Promise<LoadMapManifestResult> {
  const fetched = await fetchConfigText(configUrl);
  if (!fetched.text) {
    return {
      maps: [],
      defaultMapId: null,
      warnings: fetched.warnings,
    };
  }

  const parsed = parseMapConfig(fetched.text);
  const maps = buildManifest(parsed.entries);
  const defaultMapId = resolveDefaultMapId(parsed.defaultFilename, maps);
  const warnings = [...fetched.warnings, ...parsed.warnings];

  if (parsed.defaultFilename && !defaultMapId) {
    warnings.push(`default map "${parsed.defaultFilename}" not found among configured maps`);
  }

  return { maps, defaultMapId, warnings };
}

export async function loadMapByEntry(
  entry: MapManifestEntry,
  configUrl: string,
): Promise<LoadMapByEntryResult> {
  const baseUrl = new URL(configUrl, window.location.href);
  const imageUrl = new URL(entry.filename, baseUrl).toString();
  const warnings: string[] = [];

  let image: HTMLImageElement;
  try {
    image = await loadImage(imageUrl);
  } catch {
    return {
      map: null,
      warnings: [`${entry.filename} ignored (image load failed)`],
    };
  }

  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return {
      map: null,
      warnings: [`${entry.filename} ignored (invalid image dimensions)`],
    };
  }

  if (image.naturalWidth < 1000 || image.naturalHeight < 600) {
    warnings.push(`${entry.filename} is a low-resolution placeholder; export the CDR to PNG for real work`);
  }

  return {
    map: {
      spec: {
        id: entry.id,
        filename: entry.filename,
        realWidthMm: entry.realWidthMm,
        realHeightMm: entry.realHeightMm,
        imgWidthPx: image.naturalWidth,
        imgHeightPx: image.naturalHeight,
      },
      image,
      url: imageUrl,
    },
    warnings,
  };
}
