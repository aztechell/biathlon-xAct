import { mmPerPxX, mmPerPxY } from "../geometry/measure";
import type { LoadedMap } from "../io/mapConfig";
import type { AnimationSpeedMultiplier, PointPx, Polyline, RobotPlaybackFrame } from "../state/types";

const MAX_DRIVE_SPEED = 100;
const ROBOT_TURN_SPEED_RAD_PER_SEC = Math.PI;
const MIN_ROBOT_TURN_ANGLE_RAD = 0.02;

type RobotPlaybackMode = "move" | "turn";

export interface RobotPlaybackControllerOptions {
  getActiveMap: () => LoadedMap | null;
  getPolylines: () => Polyline[];
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

    const firstSegmentIndex = this.findNextPlayableSegment(polyline.points, 0, activeMap);
    if (firstSegmentIndex === null) {
      return false;
    }

    this.resetPlayback(false);
    this.playingPolylineId = polylineId;
    this.playbackMode = "move";
    this.playbackSegmentIndex = firstSegmentIndex;
    this.playbackSegmentOffsetMm = 0;
    this.resetRobotTurnState();
    this.playbackLastTimestampMs = performance.now();
    this.robotPlaybackFrame = {
      polylineId,
      position: { ...polyline.points[firstSegmentIndex] },
      headingRad: this.headingRad(polyline.points[firstSegmentIndex], polyline.points[firstSegmentIndex + 1]),
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

    let remainingDistanceMm =
      Math.max(1, this.normalizeDriveSpeed(this.options.getDriveSpeed())) *
      this.options.getAnimationSpeedMultiplier() *
      dtSec;

    while (remainingDistanceMm >= 0) {
      if (this.playbackSegmentIndex >= polyline.points.length - 1) {
        this.finishRobotPlayback(polyline);
        return;
      }

      const start = polyline.points[this.playbackSegmentIndex];
      const end = polyline.points[this.playbackSegmentIndex + 1];
      const segmentLengthMm = this.segmentLengthMm(start, end, activeMap);
      if (segmentLengthMm <= 0.0001) {
        this.playbackSegmentIndex += 1;
        this.playbackSegmentOffsetMm = 0;
        continue;
      }

      const availableDistanceMm = segmentLengthMm - this.playbackSegmentOffsetMm;
      if (remainingDistanceMm >= availableDistanceMm) {
        remainingDistanceMm -= availableDistanceMm;
        const nextSegmentIndex = this.findNextPlayableSegment(polyline.points, this.playbackSegmentIndex + 1, activeMap);
        if (nextSegmentIndex === null) {
          this.finishRobotPlayback(polyline);
          return;
        }

        const currentHeading = this.headingRad(start, end);
        const nextStart = polyline.points[nextSegmentIndex];
        const nextEnd = polyline.points[nextSegmentIndex + 1];
        const nextHeading = this.headingRad(nextStart, nextEnd);
        const turnPosition = { ...nextStart };
        this.robotPlaybackFrame = {
          polylineId: this.playingPolylineId,
          position: turnPosition,
          headingRad: currentHeading,
        };

        if (this.startRobotTurn(turnPosition, currentHeading, nextHeading, nextSegmentIndex)) {
          this.options.requestRender();
          this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
          return;
        }

        this.playbackSegmentIndex = nextSegmentIndex;
        this.playbackSegmentOffsetMm = 0;
        continue;
      }

      this.playbackSegmentOffsetMm += remainingDistanceMm;
      const t = this.playbackSegmentOffsetMm / segmentLengthMm;
      this.robotPlaybackFrame = {
        polylineId: this.playingPolylineId,
        position: this.lerpPoint(start, end, t),
        headingRad: this.headingRad(start, end),
      };
      this.options.requestRender();
      this.playbackAnimationHandle = window.requestAnimationFrame(this.robotPlaybackTick);
      return;
    }
  };

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
      this.playbackTurnProgressRad + ROBOT_TURN_SPEED_RAD_PER_SEC * this.options.getAnimationSpeedMultiplier() * dtSec,
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
    nextSegmentIndex: number,
  ): boolean {
    const turnDeltaRad = shortestAngleDeltaRad(fromHeadingRad, toHeadingRad);
    if (Math.abs(turnDeltaRad) < MIN_ROBOT_TURN_ANGLE_RAD) {
      return false;
    }

    this.playbackMode = "turn";
    this.playbackSegmentIndex = nextSegmentIndex;
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
      this.robotPlaybackFrame = {
        ...this.robotPlaybackFrame,
        headingRad: normalizeAngleRad(this.playbackTurnFromHeadingRad + this.playbackTurnDeltaRad),
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
    const finalPoint = polyline.points[polyline.points.length - 1];
    this.robotPlaybackFrame = {
      polylineId: polyline.id,
      position: { ...finalPoint },
      headingRad: this.lastHeadingRad(polyline.points),
    };
    this.cancelPlaybackAnimationFrame();
    this.playingPolylineId = null;
    this.playbackMode = "move";
    this.resetRobotTurnState();
    this.playbackLastTimestampMs = 0;
    this.options.onPlaybackStateChange();
  }

  private findNextPlayableSegment(points: PointPx[], startIndex: number, map: LoadedMap): number | null {
    for (let index = startIndex; index < points.length - 1; index += 1) {
      if (this.segmentLengthMm(points[index], points[index + 1], map) > 0.0001) {
        return index;
      }
    }
    return null;
  }

  private segmentLengthMm(start: PointPx, end: PointPx, map: LoadedMap): number {
    const dxMm = (end.x - start.x) * mmPerPxX(map.spec);
    const dyMm = (end.y - start.y) * mmPerPxY(map.spec);
    return Math.hypot(dxMm, dyMm);
  }

  private headingRad(start: PointPx, end: PointPx): number {
    return Math.atan2(end.y - start.y, end.x - start.x);
  }

  private lastHeadingRad(points: PointPx[]): number {
    for (let index = points.length - 2; index >= 0; index -= 1) {
      const start = points[index];
      const end = points[index + 1];
      if (Math.hypot(end.x - start.x, end.y - start.y) > 0.0001) {
        return this.headingRad(start, end);
      }
    }
    return 0;
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
