import { clamp, relativeMmToWorld, worldToRelativeMm } from "../geometry/measure";
import type {
  AnimationSpeedMultiplier,
  AppState,
  MapSpec,
  PointPx,
  Polyline,
  PolylineSettings,
  RelativePointMm,
} from "../state/types";

const SESSION_APP_ID = "biathlon-xact";
const SESSION_VERSION = 1;
const MAX_DRIVE_SPEED = 100;
const DEFAULT_ROBOT_SIZE_MM = 250;
const ANIMATION_SPEED_MULTIPLIERS = [2, 4, 8, 16] as const;

export interface ImportedSession {
  polylines: Polyline[];
  polylineSettings: PolylineSettings;
  robotEnabled: boolean;
  robotWidthMm: number;
  robotHeightMm: number;
  warnings: string[];
}

interface SessionV1 {
  version: 1;
  app: string;
  exportedAt: string;
  map: {
    id: string;
    filename: string;
    realWidthMm: number;
    realHeightMm: number;
  };
  polylines: Array<{
    id: string;
    pointsMm: RelativePointMm[];
  }>;
  settings: PolylineSettings;
  robot: {
    enabled: boolean;
    widthMm: number;
    heightMm: number;
  };
}

export function serializeSession(state: AppState, map: MapSpec): string {
  const session: SessionV1 = {
    version: SESSION_VERSION,
    app: SESSION_APP_ID,
    exportedAt: new Date().toISOString(),
    map: {
      id: map.id,
      filename: map.filename,
      realWidthMm: map.realWidthMm,
      realHeightMm: map.realHeightMm,
    },
    polylines: state.polylines.map((polyline) => ({
      id: polyline.id,
      pointsMm: polyline.points.map((point) => toSessionMm(worldToRelativeMm(point, map))),
    })),
    settings: {
      orthoVh: state.polylineSettings.orthoVh,
      round10mm: state.polylineSettings.round10mm,
      showPointCoordinates: state.polylineSettings.showPointCoordinates,
      coordinateMode: state.polylineSettings.coordinateMode,
      driveSpeed: normalizeDriveSpeed(state.polylineSettings.driveSpeed),
      animationSpeedMultiplier: normalizeAnimationSpeedMultiplier(state.polylineSettings.animationSpeedMultiplier),
    },
    robot: {
      enabled: state.robotEnabled,
      widthMm: normalizePositiveNumber(state.robotWidthMm, DEFAULT_ROBOT_SIZE_MM),
      heightMm: normalizePositiveNumber(state.robotHeightMm, DEFAULT_ROBOT_SIZE_MM),
    },
  };

  return `${JSON.stringify(session, null, 2)}\n`;
}

export function parseSession(json: string, currentMap: MapSpec): ImportedSession {
  const raw = parseJsonObject(json);
  const version = readNumber(raw.version);
  if (version !== SESSION_VERSION) {
    throw new Error(`Unsupported session version: ${Number.isFinite(version) ? version : "missing"}`);
  }

  const warnings: string[] = [];
  const rawMap = readObject(raw.map, "map");
  const mapWidth = readNumber(rawMap.realWidthMm);
  const mapHeight = readNumber(rawMap.realHeightMm);
  if (!isSameSize(mapWidth, currentMap.realWidthMm) || !isSameSize(mapHeight, currentMap.realHeightMm)) {
    throw new Error(
      `Session map size ${mapWidth} x ${mapHeight} mm does not match current map ${currentMap.realWidthMm} x ${currentMap.realHeightMm} mm`,
    );
  }

  const filename = typeof rawMap.filename === "string" ? rawMap.filename : "";
  if (filename && filename !== currentMap.filename) {
    warnings.push(`Imported session was exported for ${filename}, current map is ${currentMap.filename}`);
  }

  const settings = parseSettings(readOptionalObject(raw.settings));
  const robot = parseRobot(readOptionalObject(raw.robot));
  const polylines = parsePolylines(raw.polylines, currentMap, warnings);

  return {
    polylines,
    polylineSettings: settings,
    robotEnabled: robot.enabled,
    robotWidthMm: robot.widthMm,
    robotHeightMm: robot.heightMm,
    warnings,
  };
}

function parsePolylines(rawPolylines: unknown, map: MapSpec, warnings: string[]): Polyline[] {
  if (!Array.isArray(rawPolylines)) {
    throw new Error("Session polylines must be an array");
  }

  const usedIds = new Set<string>();
  const polylines: Polyline[] = [];
  rawPolylines.forEach((rawPolyline, index) => {
    if (!isRecord(rawPolyline)) {
      warnings.push(`Polyline ${index + 1} skipped: invalid object`);
      return;
    }

    const rawPoints = rawPolyline.pointsMm;
    if (!Array.isArray(rawPoints)) {
      warnings.push(`Polyline ${index + 1} skipped: pointsMm is missing`);
      return;
    }

    const points = rawPoints.flatMap((rawPoint) => {
      const point = parsePointMm(rawPoint, map);
      return point ? [point] : [];
    });
    if (points.length < 2) {
      warnings.push(`Polyline ${index + 1} skipped: fewer than 2 valid points`);
      return;
    }

    polylines.push({
      id: normalizePolylineId(rawPolyline.id, index, usedIds),
      points,
    });
  });

  return polylines;
}

function parsePointMm(rawPoint: unknown, map: MapSpec): PointPx | null {
  if (!isRecord(rawPoint)) {
    return null;
  }
  const xMm = readNumber(rawPoint.xMm);
  const yMm = readNumber(rawPoint.yMm);
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) {
    return null;
  }

  return relativeMmToWorld(
    {
      xMm: clamp(xMm, 0, map.realHeightMm),
      yMm: clamp(yMm, 0, map.realWidthMm),
    },
    map,
  );
}

function parseSettings(rawSettings: Record<string, unknown> | null): PolylineSettings {
  return {
    orthoVh: readBoolean(rawSettings?.orthoVh, false),
    round10mm: readBoolean(rawSettings?.round10mm, true),
    showPointCoordinates: readBoolean(rawSettings?.showPointCoordinates, false),
    coordinateMode: rawSettings?.coordinateMode === "relative" ? "relative" : "absolute",
    driveSpeed: normalizeDriveSpeed(readNumber(rawSettings?.driveSpeed)),
    animationSpeedMultiplier: normalizeAnimationSpeedMultiplier(readNumber(rawSettings?.animationSpeedMultiplier)),
  };
}

function parseRobot(rawRobot: Record<string, unknown> | null): { enabled: boolean; widthMm: number; heightMm: number } {
  return {
    enabled: readBoolean(rawRobot?.enabled, false),
    widthMm: normalizePositiveNumber(readNumber(rawRobot?.widthMm), DEFAULT_ROBOT_SIZE_MM),
    heightMm: normalizePositiveNumber(readNumber(rawRobot?.heightMm), DEFAULT_ROBOT_SIZE_MM),
  };
}

function normalizePolylineId(rawId: unknown, index: number, usedIds: Set<string>): string {
  const base = typeof rawId === "string" && rawId.trim() ? rawId.trim() : `polyline-import-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function toSessionMm(point: RelativePointMm): RelativePointMm {
  return {
    xMm: toSessionNumber(point.xMm),
    yMm: toSessionNumber(point.yMm),
  };
}

function toSessionNumber(value: number): number {
  return Number(value.toFixed(3));
}

function parseJsonObject(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Session JSON must be an object");
  }
  return parsed;
}

function readObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Session ${fieldName} must be an object`);
  }
  return value;
}

function readOptionalObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeDriveSpeed(speed: number): number {
  return Math.max(0, Math.min(MAX_DRIVE_SPEED, Math.round(Number.isFinite(speed) ? speed : MAX_DRIVE_SPEED)));
}

function normalizeAnimationSpeedMultiplier(value: number): AnimationSpeedMultiplier {
  const multiplier = Math.round(Number.isFinite(value) ? value : 2);
  return ANIMATION_SPEED_MULTIPLIERS.includes(multiplier as AnimationSpeedMultiplier)
    ? (multiplier as AnimationSpeedMultiplier)
    : 2;
}

function normalizePositiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function isSameSize(a: number, b: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) < 0.001;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
