import { worldToCoordinateModeMm } from "../geometry/measure";
import type { CoordinateMode, MapSpec, PointPx } from "../state/types";

export interface RobotCodeCommand {
  xMm: number;
  yMm: number;
  speed: number | null;
}

export interface RobotCodeReset {
  xMm: number;
  yMm: number;
  heading: number | null;
}

export interface RobotCodeTurn {
  headingDeg: number;
}

export type RobotCodeAction =
  | {
      kind: "drive";
      command: RobotCodeCommand;
    }
  | {
      kind: "reset";
      reset: RobotCodeReset;
    }
  | {
      kind: "turn";
      turn: RobotCodeTurn;
    };

export interface ParsedRobotCode {
  actions: RobotCodeAction[];
  drives: RobotCodeCommand[];
  reset: RobotCodeReset | null;
  turns: RobotCodeTurn[];
}

export interface RobotCodeMissionSource {
  title: string;
  points: PointPx[];
}

type ParsedArg = number | null | undefined;

const ROBOT_ACTION_PATTERN = /robot\.(drive_to_point_action|reset_odometry_action|turn_to_heading_action)\s*\(([^)]*)\)\s*,?/g;
const KEYWORD_ARG_PATTERN = /\b([A-Za-z_]\w*)\s*=\s*(None|-?(?:\d+\.?\d*|\.\d+))/g;
const NUMBER_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;

export function serializeRobotCode(
  points: PointPx[],
  map: MapSpec,
  coordinateMode: CoordinateMode,
  originPoint: PointPx | null,
  speed: number,
): string {
  const lines = serializeDriveLines(points, map, coordinateMode, originPoint, speed);

  if (coordinateMode !== "relative" || points.length === 0) {
    return lines.join("\n");
  }
  return `robot.reset_odometry_action(0, 0, 0),\n${lines.join("\n")}`;
}

export function serializeRobotCodeMissions(
  missions: RobotCodeMissionSource[],
  map: MapSpec,
  coordinateMode: CoordinateMode,
  speed: number,
): string {
  const nonEmptyMissions = missions.filter((mission) => mission.points.length > 0);
  if (nonEmptyMissions.length === 0) {
    return "";
  }

  return nonEmptyMissions
    .map((mission, index) => {
      const code = serializeRobotCode(mission.points, map, coordinateMode, mission.points[0] ?? null, speed);
      return nonEmptyMissions.length === 1 ? code : `# ${mission.title || `Mission ${index + 1}`}\n${code}`;
    })
    .join("\n\n");
}

export function serializeRobotCodePreservingActions(
  points: PointPx[],
  map: MapSpec,
  coordinateMode: CoordinateMode,
  originPoint: PointPx | null,
  speed: number,
  previousCode: string,
): string {
  if (points.length === 0) {
    return "";
  }

  const parsed = parseRobotCode(previousCode);
  if (!parsed.actions.some((action) => action.kind !== "drive")) {
    return serializeRobotCode(points, map, coordinateMode, originPoint, speed);
  }

  const driveLines = serializeDriveLines(points, map, coordinateMode, originPoint, speed);
  const lines: string[] = [];
  let driveIndex = 0;
  let hasReset = false;

  for (const action of parsed.actions) {
    if (action.kind === "drive") {
      if (driveIndex < driveLines.length) {
        lines.push(driveLines[driveIndex]);
        driveIndex += 1;
      }
      continue;
    }

    if (action.kind === "reset") {
      hasReset = true;
      lines.push(formatResetAction(action.reset));
      continue;
    }

    lines.push(formatTurnAction(action.turn));
  }

  while (driveIndex < driveLines.length) {
    lines.push(driveLines[driveIndex]);
    driveIndex += 1;
  }

  if (coordinateMode === "relative" && !hasReset) {
    lines.unshift("robot.reset_odometry_action(0, 0, 0),");
  }

  return lines.join("\n");
}

export function serializeRobotCodeMissionsPreservingActions(
  missions: RobotCodeMissionSource[],
  map: MapSpec,
  coordinateMode: CoordinateMode,
  speed: number,
  previousCode: string,
): string {
  const previousMissions = splitRobotCodeMissionTexts(previousCode);
  const nonEmptyMissions = missions.filter((mission) => mission.points.length > 0);
  if (nonEmptyMissions.length === 0) {
    return "";
  }

  return nonEmptyMissions
    .map((mission, index) => {
      const previousMissionCode = previousMissions[index] ?? "";
      const code = previousMissionCode
        ? serializeRobotCodePreservingActions(
            mission.points,
            map,
            coordinateMode,
            mission.points[0] ?? null,
            speed,
            previousMissionCode,
          )
        : serializeRobotCode(mission.points, map, coordinateMode, mission.points[0] ?? null, speed);
      return nonEmptyMissions.length === 1 ? code : `# ${mission.title || `Mission ${index + 1}`}\n${code}`;
    })
    .join("\n\n");
}

export function parseRobotCode(text: string): ParsedRobotCode {
  const actions: RobotCodeAction[] = [];
  const drives: RobotCodeCommand[] = [];
  let reset: RobotCodeReset | null = null;
  const turns: RobotCodeTurn[] = [];

  for (const match of text.matchAll(ROBOT_ACTION_PATTERN)) {
    const args = parseArgs(match[2]);
    if (match[1] === "reset_odometry_action") {
      const resetAction = {
        xMm: readOptionalNumber(args, "x", 0) ?? 0,
        yMm: readOptionalNumber(args, "y", 1) ?? 0,
        heading: readOptionalNumber(args, "heading", 2),
      };
      reset ??= resetAction;
      actions.push({ kind: "reset", reset: resetAction });
      continue;
    }
    if (match[1] === "turn_to_heading_action") {
      const headingDeg = readRequiredNumber(args, "target_heading", 0);
      if (headingDeg !== null) {
        const turn = { headingDeg };
        turns.push(turn);
        actions.push({ kind: "turn", turn });
      }
      continue;
    }

    const xMm = readRequiredNumber(args, "x", 0);
    const yMm = readRequiredNumber(args, "y", 1);
    if (xMm === null || yMm === null) {
      continue;
    }
    const command = {
      xMm,
      yMm,
      speed: readOptionalNumber(args, "speed", 2),
    };
    drives.push(command);
    actions.push({ kind: "drive", command });
  }

  return { actions, drives, reset, turns };
}

export function parseRobotCodeMissions(text: string): ParsedRobotCode[] {
  return splitRobotCodeMissionTexts(text).map(parseRobotCode);
}

export function splitRobotCodeMissions(text: string): string[] {
  return splitRobotCodeMissionTexts(text);
}

function serializeDriveLines(
  points: PointPx[],
  map: MapSpec,
  coordinateMode: CoordinateMode,
  originPoint: PointPx | null,
  speed: number,
): string[] {
  return points.map((point) => {
    const coordinate = worldToCoordinateModeMm(point, map, coordinateMode, originPoint);
    return `robot.drive_to_point_action(${Math.round(coordinate.xMm)}, ${Math.round(coordinate.yMm)}, ${speed}),`;
  });
}

function formatResetAction(reset: RobotCodeReset): string {
  return `robot.reset_odometry_action(${formatNumber(reset.xMm)}, ${formatNumber(reset.yMm)}, ${formatNumber(reset.heading ?? 0)}),`;
}

function formatTurnAction(turn: RobotCodeTurn): string {
  return `robot.turn_to_heading_action(${formatNumber(turn.headingDeg)}),`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function splitRobotCodeMissionTexts(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let sawMissionHeader = false;

  for (const line of lines) {
    if (/^\s*#\s*Mission\b/i.test(line)) {
      sawMissionHeader = true;
      if (current.some((item) => item.trim() !== "")) {
        chunks.push(current.join("\n").trim());
      }
      current = [];
      continue;
    }
    current.push(line);
  }

  if (current.some((item) => item.trim() !== "")) {
    chunks.push(current.join("\n").trim());
  }

  if (!sawMissionHeader) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }
  return chunks;
}

function parseArgs(argsText: string): { positional: ParsedArg[]; named: Map<string, ParsedArg> } {
  const named = new Map<string, ParsedArg>();
  for (const match of argsText.matchAll(KEYWORD_ARG_PATTERN)) {
    named.set(match[1].toLowerCase(), parseArgValue(match[2]));
  }

  const positional = argsText.split(",").map((part) => {
    if (part.includes("=")) {
      return undefined;
    }
    return parseArgValue(part.trim());
  });

  return { positional, named };
}

function parseArgValue(value: string): ParsedArg {
  if (value === "None") {
    return null;
  }
  if (!NUMBER_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRequiredNumber(args: ReturnType<typeof parseArgs>, name: string, positionalIndex: number): number | null {
  if (args.named.has(name)) {
    const named = args.named.get(name);
    return typeof named === "number" ? named : null;
  }

  const positional = args.positional[positionalIndex];
  return typeof positional === "number" ? positional : null;
}

function readOptionalNumber(args: ReturnType<typeof parseArgs>, name: string, positionalIndex: number): number | null {
  if (args.named.has(name)) {
    const named = args.named.get(name);
    return typeof named === "number" ? named : null;
  }

  const positional = args.positional[positionalIndex];
  if (typeof positional === "number") {
    return positional;
  }
  return null;
}
