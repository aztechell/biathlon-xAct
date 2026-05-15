import type { PointPx, Polyline, PolylinePointTarget } from "../state/types";

export interface PolylineSegmentHit {
  polyline: Polyline;
  insertIndex: number;
  point: PointPx;
}

export function findPolylinePointAt(
  point: PointPx,
  polylines: Polyline[],
  draftPolyline: PointPx[],
  hitRadiusWorldPx: number,
): PolylinePointTarget | null {
  let bestTarget: PolylinePointTarget | null = null;
  let bestDistance = hitRadiusWorldPx;

  for (let index = draftPolyline.length - 1; index >= 0; index -= 1) {
    const candidate = draftPolyline[index];
    const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestTarget = { kind: "draft", pointIndex: index };
    }
  }

  for (let polylineIndex = polylines.length - 1; polylineIndex >= 0; polylineIndex -= 1) {
    const polyline = polylines[polylineIndex];
    for (let pointIndex = polyline.points.length - 1; pointIndex >= 0; pointIndex -= 1) {
      const candidate = polyline.points[pointIndex];
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestTarget = { kind: "polyline", polylineId: polyline.id, pointIndex };
      }
    }
  }

  return bestTarget;
}

export function findPolylineSegmentAt(
  point: PointPx,
  polylines: Polyline[],
  hitRadiusWorldPx: number,
): PolylineSegmentHit | null {
  let bestTarget: PolylineSegmentHit | null = null;
  let bestDistance = hitRadiusWorldPx;

  for (const polyline of polylines) {
    for (let index = 1; index < polyline.points.length; index += 1) {
      const projection = projectPointToSegment(point, polyline.points[index - 1], polyline.points[index]);
      if (projection.distance <= bestDistance) {
        bestDistance = projection.distance;
        bestTarget = {
          polyline,
          insertIndex: index,
          point: projection.point,
        };
      }
    }
  }

  return bestTarget;
}

export function findPolylineLastPointAt(
  point: PointPx,
  polylines: Polyline[],
  hitRadiusWorldPx: number,
): Polyline | null {
  let bestPolyline: Polyline | null = null;
  let bestDistance = hitRadiusWorldPx;

  for (const polyline of polylines) {
    const lastPoint = polyline.points[polyline.points.length - 1];
    if (!lastPoint) {
      continue;
    }
    const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestPolyline = polyline;
    }
  }

  return bestPolyline;
}

export function findPolylineAt(point: PointPx, polylines: Polyline[], hitRadiusWorldPx: number): Polyline | null {
  let bestPolyline: Polyline | null = null;
  let bestDistance = hitRadiusWorldPx;

  for (const polyline of polylines) {
    const points = polyline.points;
    for (const polylinePoint of points) {
      const distance = Math.hypot(point.x - polylinePoint.x, point.y - polylinePoint.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestPolyline = polyline;
      }
    }

    for (let i = 1; i < points.length; i += 1) {
      const distance = distanceToSegment(point, points[i - 1], points[i]);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestPolyline = polyline;
      }
    }
  }

  return bestPolyline;
}

export function distanceToSegment(point: PointPx, start: PointPx, end: PointPx): number {
  return projectPointToSegment(point, start, end).distance;
}

export function projectPointToSegment(point: PointPx, start: PointPx, end: PointPx): { point: PointPx; distance: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return {
      point: { ...start },
      distance: Math.hypot(point.x - start.x, point.y - start.y),
    };
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projection = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
  return {
    point: projection,
    distance: Math.hypot(point.x - projection.x, point.y - projection.y),
  };
}
