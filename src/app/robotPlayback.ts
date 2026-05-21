import { mmPerPxX, mmPerPxY } from "../geometry/measure";
import type { LoadedMap } from "../io/mapConfig";
import type { AnimationSpeedMultiplier, PointPx, Polyline, RobotPlaybackFrame } from "../state/types";

const MAX_DRIVE_SPEED = 100;
const ROBOT_TURN_SPEED_RAD_PER_SEC = Math.PI / 2;
const MIN_ROBOT_TURN_ANGLE_RAD = 0.02;

type RobotPlaybackMode = "move" | "turn";

export type RobotPlaybackAction =
  | {
      kind: "drive";
      point: PointPx;
    }
  | {
      kind: "turn";
      headingRad: number;
    };

export interface RobotPlaybackControllerOptions {
  getActiveMap: () => LoadedMap | null;
  getPolylines: () => Polyline[];
  getPlaybackActions: (polylineId: string) => RobotPlaybackAction[] | null;
  getInitialHeadingRad: () => number;
  getDriveSpeed: () => number;
  getAnimationSpeedMultiplier: () => AnimationSpeedMultiplier;
  requestRender: () => void;
  onPlaybackStateChange: () => void;
}

export class RobotPlaybackController {
  private robotPlaybackFrame: RobotPlaybackFrame | null = null;
  private playingPolylineId: string | null = null;
  private playbackAnimationHandle: number | null = null;
  private playbackLastTimestampMs = 0;
  private playbackSegmentIndex = 0;
  private playbackSegmentOffsetMm = 0;
  private playbackActions: RobotPlaybackAction[] = [];
  private playbackActionIndex = 0;
  private playbackCurrentPosition: PointPx | null = null;
  private playbackMoveStart: PointPx | null = null;
  private playbackMoveEnd: PointPx | null = null;
  private playbackMoveLengthMm = 0;
  private playbackHeadingRad = 0;
  private playbackMode: RobotPlaybackMode = "move";
  private playbackTurnFromHeadingRad = 0;
  private playbackTurnDeltaRad = 0;
  private playbackTurnProgressRad = 0;
  private playbackTurnPosition: PointPx | null = null;

  constructor(private readonly options: RobotPlaybackControllerOptions) {}

  toggle(polylineId: string): void {
    if (this.playingPolylineId === polylineId && this.playbackAnimationHandle !== null) {
      this.stop(false);
      return;
    }
    this.start(polylineId);
  }

  start(polylineId: string): boolean {
    const activeMap = this.options.getActiveMap();
    const polyline = this.options.getPolylines().find((item) => item.id === polylineId) ?? null;
    if (!activeMap || !polyline || polyline.points.length < 2) {
      return false;
    }

    const actions = this.options.getPlaybackActions(polylineId) ?? polyline.points.map((point) => ({ kind: "drive" as const, point }));
    const firstDriveIndex = actions.findIndex((action) => action.kind === "drive");
    if (firstDriveIndex < 0) {
      return false;
    }
    const firstDrive = actions[firstDriveIndex];
    if (firstDrive.kind !== "drive") {
      return false;
    }

    this.resetPlayback(false);
    this.playingPolylineId = polylineId;
    this.playbackMode = "move";
    this.playbackActions = actions.map((action) =>
      action.kind === "drive" ? { kind: "drive", point: { ...action.point } } : { kind: "turn", headingRad: action.headingRad },
    );
    this.playbackActionIndex = firstDriveIndex + 1;
    this.playbackCurrentPosition = { ...firstDrive.point };
    this.playbackHeadingRad = this.options.getInitialHeadingRad();
    this.playbackSegmentIndex = 0;
    this.playbackSegmentOffsetMm = 0;
    this.playbackMoveStart = null;
    this.playbackMoveEnd = null;
    this.playbackMoveLengthMm = 0;
    this.resetRobotTurnState();
    this.playbackLastTimestampMs = performance.now();
    this.robotPlaybackFrame = {
      polylineId,
      position: { ...firstDrive.point },
      headingRad: this.playbackHeadingRad,
    };
    this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
    this.options.onPlaybackStateChange();
    return true;
  }

  stop(clearFrame: boolean): void {
    this.resetPlayback(clearFrame);
    this.options.onPlaybackStateChange();
  }

  stopIfPolylineAffected(polylineId: string): boolean {
    if (polylineId !== this.playingPolylineId && polylineId !== this.robotPlaybackFrame?.polylineId) {
      return false;
    }
    this.stop(true);
    return true;
  }

  getFrame(): RobotPlaybackFrame | null {
    return this.robotPlaybackFrame
      ? {
          polylineId: this.robotPlaybackFrame.polylineId,
          position: { ...this.robotPlaybackFrame.position },
          headingRad: this.robotPlaybackFrame.headingRad,
        }
      : null;
  }

  getPlayingPolylineId(): string | null {
    return this.playingPolylineId;
  }

  dispose(): void {
    this.resetPlayback(true);
  }

  private resetPlayback(clearFrame: boolean): void {
    this.cancelPlaybackAnimationFrame();
    this.playingPolylineId = null;
    this.playbackLastTimestampMs = 0;
    this.playbackSegmentIndex = 0;
    this.playbackSegmentOffsetMm = 0;
    this.playbackActions = [];
    this.playbackActionIndex = 0;
    this.playbackCurrentPosition = null;
    this.playbackMoveStart = null;
    this.playbackMoveEnd = null;
    this.playbackMoveLengthMm = 0;
    this.playbackHeadingRad = 0;
    this.playbackMode = "move";
    this.resetRobotTurnState();
    if (clearFrame) {
      this.robotPlaybackFrame = null;
    }
  }

  private cancelPlaybackAnimationFrame(): void {
    if (this.playbackAnimationHandle === null) {
      return;
    }
    window.cancelAnimationFrame(this.playbackAnimationHandle);
    this.playbackAnimationHandle = null;
  }

  private readonly robotPlaybackTick = (timestampMs: number): void => {
    const activeMap = this.options.getActiveMap();
    const polyline = this.playingPolylineId
      ? this.options.getPolylines().find((item) => item.id === this.playingPolylineId) ?? null
      : null;
    if (!activeMap || !polyline || polyline.points.length < 2 || !this.playingPolylineId) {
      this.stop(true);
      return;
    }

    const dtSec = Math.min(0.1, Math.max(0, (timestampMs - this.playbackLastTimestampMs) / 1000));
    this.playbackLastTimestampMs = timestampMs;

    if (this.playbackMode === "turn") {
      this.stepRobotTurn(dtSec);
      return;
    }

    let remainingDistanceMm = this.distancePerTickMm(dtSec);

    while (remainingDistanceMm >= 0) {
      if (this.playbackMode === "move" && this.playbackMoveStart && this.playbackMoveEnd) {
        if (!this.stepRobotMove(remainingDistanceMm)) {
          return;
        }
        remainingDistanceMm = 0;
        continue;
      }

      const startedMode = this.startNextPlaybackAction();
      if (!startedMode) {
        this.finishRobotPlayback(polyline);
        return;
      }
      if (startedMode === "turn") {
        this.options.requestRender();
        this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
        return;
      }
    }
  };

  private distancePerTickMm(dtSec: number): number {
    return (
      Math.max(1, this.normalizeDriveSpeed(this.options.getDriveSpeed())) *
      this.options.getAnimationSpeedMultiplier() *
      dtSec
    );
  }

  private startNextPlaybackAction(): RobotPlaybackMode | null {
    if (!this.playingPolylineId || !this.playbackCurrentPosition) {
      return null;
    }

    while (this.playbackActionIndex < this.playbackActions.length) {
      const action = this.playbackActions[this.playbackActionIndex];
      this.playbackActionIndex += 1;
      if (action.kind === "turn") {
        if (this.startRobotTurn(this.playbackCurrentPosition, this.playbackHeadingRad, action.headingRad)) {
          return "turn";
        }
        continue;
      }

      const activeMap = this.options.getActiveMap();
      if (!activeMap) {
        return null;
      }
      const segmentLengthMm = this.segmentLengthMm(this.playbackCurrentPosition, action.point, activeMap);
      if (segmentLengthMm <= 0.0001) {
        this.playbackCurrentPosition = { ...action.point };
        continue;
      }

      const moveHeadingRad = this.headingRad(this.playbackCurrentPosition, action.point);
      if (this.startRobotTurn(this.playbackCurrentPosition, this.playbackHeadingRad, moveHeadingRad)) {
        this.playbackActionIndex -= 1;
        return "turn";
      }

      this.playbackMoveStart = { ...this.playbackCurrentPosition };
      this.playbackMoveEnd = { ...action.point };
      this.playbackMoveLengthMm = segmentLengthMm;
      this.playbackSegmentOffsetMm = 0;
      this.playbackHeadingRad = moveHeadingRad;
      return "move";
    }
    return null;
  }

  private stepRobotMove(distanceMm: number): boolean {
    if (!this.playingPolylineId || !this.playbackMoveStart || !this.playbackMoveEnd) {
      return false;
    }

    this.playbackSegmentOffsetMm += distanceMm;
    const t = Math.min(1, this.playbackSegmentOffsetMm / this.playbackMoveLengthMm);
    const position = this.lerpPoint(this.playbackMoveStart, this.playbackMoveEnd, t);
    this.robotPlaybackFrame = {
      polylineId: this.playingPolylineId,
      position,
      headingRad: this.playbackHeadingRad,
    };
    this.options.requestRender();

    if (t >= 1) {
      this.playbackCurrentPosition = { ...this.playbackMoveEnd };
      this.playbackMoveStart = null;
      this.playbackMoveEnd = null;
      this.playbackMoveLengthMm = 0;
      this.playbackSegmentOffsetMm = 0;
      return true;
    }

    this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
    return false;
  }

  private stepRobotTurn(dtSec: number): void {
    if (!this.playingPolylineId || !this.playbackTurnPosition) {
      this.playbackMode = "move";
      this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
      return;
    }

    const totalTurnRad = Math.abs(this.playbackTurnDeltaRad);
    if (totalTurnRad < MIN_ROBOT_TURN_ANGLE_RAD) {
      this.finishRobotTurn();
      this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
      return;
    }

    this.playbackTurnProgressRad = Math.min(
      totalTurnRad,
      this.playbackTurnProgressRad + this.turnRadPerTick(dtSec),
    );
    const rawT = this.playbackTurnProgressRad / totalTurnRad;
    const easedT = easeInOut(rawT);
    const headingRad = normalizeAngleRad(this.playbackTurnFromHeadingRad + this.playbackTurnDeltaRad * easedT);

    this.robotPlaybackFrame = {
      polylineId: this.playingPolylineId,
      position: { ...this.playbackTurnPosition },
      headingRad,
    };
    this.options.requestRender();

    if (this.playbackTurnProgressRad >= totalTurnRad) {
      this.finishRobotTurn();
    }

    this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
  }

  private startRobotTurn(
    position: PointPx,
    fromHeadingRad: number,
    toHeadingRad: number,
  ): boolean {
    const turnDeltaRad = shortestAngleDeltaRad(fromHeadingRad, toHeadingRad);
    if (Math.abs(turnDeltaRad) < MIN_ROBOT_TURN_ANGLE_RAD) {
      return false;
    }

    this.playbackMode = "turn";
    this.playbackSegmentOffsetMm = 0;
    this.playbackTurnFromHeadingRad = fromHeadingRad;
    this.playbackTurnDeltaRad = turnDeltaRad;
    this.playbackTurnProgressRad = 0;
    this.playbackTurnPosition = { ...position };
    return true;
  }

  private finishRobotTurn(): void {
    this.playbackMode = "move";
    if (this.robotPlaybackFrame) {
      this.playbackHeadingRad = normalizeAngleRad(this.playbackTurnFromHeadingRad + this.playbackTurnDeltaRad);
      this.robotPlaybackFrame = {
        ...this.robotPlaybackFrame,
        headingRad: this.playbackHeadingRad,
      };
    }
    this.resetRobotTurnState();
  }

  private resetRobotTurnState(): void {
    this.playbackTurnFromHeadingRad = 0;
    this.playbackTurnDeltaRad = 0;
    this.playbackTurnProgressRad = 0;
    this.playbackTurnPosition = null;
  }

  private finishRobotPlayback(polyline: Polyline): void {
    const finalPoint = this.playbackCurrentPosition ?? polyline.points[polyline.points.length - 1];
    this.robotPlaybackFrame = {
      polylineId: polyline.id,
      position: { ...finalPoint },
      headingRad: this.playbackHeadingRad,
    };
    this.cancelPlaybackAnimationFrame();
    this.playingPolylineId = null;
    this.playbackMode = "move";
    this.resetRobotTurnState();
    this.playbackLastTimestampMs = 0;
    this.options.onPlaybackStateChange();
  }

  private segmentLengthMm(start: PointPx, end: PointPx, map: LoadedMap): number {
    const dxMm = (end.x - start.x) * mmPerPxX(map.spec);
    const dyMm = (end.y - start.y) * mmPerPxY(map.spec);
    return Math.hypot(dxMm, dyMm);
  }

  private headingRad(start: PointPx, end: PointPx): number {
    return Math.atan2(end.y - start.y, end.x - start.x);
  }

  private lerpPoint(start: PointPx, end: PointPx, t: number): PointPx {
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
  }

  private normalizeDriveSpeed(speed: number): number {
    return Math.max(0, Math.min(MAX_DRIVE_SPEED, Math.round(speed)));
  }

  private turnRadPerTick(dtSec: number): number {
    return ROBOT_TURN_SPEED_RAD_PER_SEC * Math.sqrt(this.options.getAnimationSpeedMultiplier()) * dtSec;
  }
}

function shortestAngleDeltaRad(fromRad: number, toRad: number): number {
  return normalizeAngleRad(toRad - fromRad);
}

function normalizeAngleRad(angleRad: number): number {
  let normalized = (angleRad + Math.PI) % (Math.PI * 2);
  if (normalized < 0) {
    normalized += Math.PI * 2;
  }
  return normalized - Math.PI;
}

function easeInOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5 ? 2 * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 2) * 0.5;
}
