import type { CoordinateMode, MapSpec, PointPx, RelativePointMm, ViewState } from "../state/types";

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function mmPerPxX(map: MapSpec): number {
  return map.realWidthMm / map.imgWidthPx;
}

export function mmPerPxY(map: MapSpec): number {
  return map.realHeightMm / map.imgHeightPx;
}

export function worldToScreen(point: PointPx, view: ViewState): PointPx {
  return {
    x: point.x * view.zoom + view.panX,
    y: point.y * view.zoom + view.panY,
  };
}

export function screenToWorld(point: PointPx, view: ViewState): PointPx {
  return {
    x: (point.x - view.panX) / view.zoom,
    y: (point.y - view.panY) / view.zoom,
  };
}

export function worldToRelativeMm(point: PointPx, map: MapSpec): RelativePointMm {
  // Robot coordinates use X for vertical map position and Y for horizontal map position.
  return {
    xMm: map.realHeightMm - point.y * mmPerPxY(map),
    yMm: point.x * mmPerPxX(map),
  };
}

export function worldToCoordinateModeMm(
  point: PointPx,
  map: MapSpec,
  coordinateMode: CoordinateMode,
  originPoint: PointPx | null,
): RelativePointMm {
  const absolute = worldToRelativeMm(point, map);
  if (coordinateMode !== "relative" || !originPoint) {
    return absolute;
  }

  const origin = worldToRelativeMm(originPoint, map);
  return {
    xMm: absolute.xMm - origin.xMm,
    yMm: absolute.yMm - origin.yMm,
  };
}

export function relativeMmToWorld(point: RelativePointMm, map: MapSpec): PointPx {
  return {
    x: point.yMm / mmPerPxX(map),
    y: (map.realHeightMm - point.xMm) / mmPerPxY(map),
  };
}

export function isInsideMap(point: PointPx, map: MapSpec): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= map.imgWidthPx && point.y <= map.imgHeightPx;
}

export function clampWorldToMap(point: PointPx, map: MapSpec): PointPx {
  return {
    x: clamp(point.x, 0, map.imgWidthPx),
    y: clamp(point.y, 0, map.imgHeightPx),
  };
}
