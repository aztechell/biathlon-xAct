export interface MapSpec {
  id: string;
  filename: string;
  realWidthMm: number;
  realHeightMm: number;
  imgWidthPx: number;
  imgHeightPx: number;
}

export interface PointPx {
  x: number;
  y: number;
}

export interface RelativePointMm {
  xMm: number;
  yMm: number;
}

export type ToolMode = "pan" | "polyline";
export type CoordinateMode = "absolute" | "relative";
export type AnimationSpeedMultiplier = 2 | 4 | 8 | 16;

export interface Polyline {
  id: string;
  points: PointPx[];
}

export interface RobotPlaybackFrame {
  polylineId: string;
  position: PointPx;
  headingRad: number;
}

export type PolylinePointTarget =
  | {
      kind: "draft";
      pointIndex: number;
    }
  | {
      kind: "polyline";
      polylineId: string;
      pointIndex: number;
    };

export interface PolylineSettings {
  orthoVh: boolean;
  round10mm: boolean;
  showPointCoordinates: boolean;
  coordinateMode: CoordinateMode;
  driveSpeed: number;
  animationSpeedMultiplier: AnimationSpeedMultiplier;
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  minZoom: number;
}

export interface AppState {
  activeMapId: string | null;
  view: ViewState;
  pointerWorld: PointPx | null;
  polylinePreviewWorld: PointPx | null;
  toolMode: ToolMode;
  polylineSettings: PolylineSettings;
  robotEnabled: boolean;
  robotWidthMm: number;
  robotHeightMm: number;
  polylines: Polyline[];
  draftPolyline: PointPx[];
}
