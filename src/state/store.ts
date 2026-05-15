import type {
  AppState,
  PointPx,
  Polyline,
  PolylinePointTarget,
  PolylineSettings,
  ToolMode,
  ViewState,
} from "./types";

type StateListener = (state: AppState) => void;

export interface SessionReplacement {
  polylines: Polyline[];
  polylineSettings: PolylineSettings;
  robotEnabled: boolean;
  robotWidthMm: number;
  robotHeightMm: number;
}

const DEFAULT_VIEW: ViewState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  minZoom: 1,
};

function clonePoint(point: PointPx): PointPx {
  return { x: point.x, y: point.y };
}

function clonePoints(points: PointPx[]): PointPx[] {
  return points.map(clonePoint);
}

function clonePolylines(polylines: Polyline[]): Polyline[] {
  return polylines.map((polyline) => ({
    id: polyline.id,
    points: clonePoints(polyline.points),
  }));
}

function cloneState(state: AppState): AppState {
  return {
    ...state,
    view: { ...state.view },
    pointerWorld: state.pointerWorld ? clonePoint(state.pointerWorld) : null,
    polylinePreviewWorld: state.polylinePreviewWorld ? clonePoint(state.polylinePreviewWorld) : null,
    polylineSettings: { ...state.polylineSettings },
    polylines: clonePolylines(state.polylines),
    draftPolyline: clonePoints(state.draftPolyline),
  };
}

export class AppStore {
  private continuingPolylineId: string | null = null;
  private continuingOriginalPolyline: Polyline | null = null;
  private continuingOriginalIndex = -1;
  private lastRemovedPolyline: { polyline: Polyline; index: number } | null = null;

  private state: AppState = {
    activeMapId: null,
    view: { ...DEFAULT_VIEW },
    pointerWorld: null,
    polylinePreviewWorld: null,
    toolMode: "pan",
    polylineSettings: {
      orthoVh: false,
      round10mm: true,
      showPointCoordinates: false,
      coordinateMode: "absolute",
      driveSpeed: 100,
      animationSpeedMultiplier: 2,
    },
    robotEnabled: false,
    robotWidthMm: 250,
    robotHeightMm: 250,
    polylines: [],
    draftPolyline: [],
  };

  private readonly listeners = new Set<StateListener>();

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AppState {
    return cloneState(this.state);
  }

  getContinuingPolylineId(): string | null {
    return this.continuingPolylineId;
  }

  hasRestorablePolyline(): boolean {
    return this.lastRemovedPolyline !== null;
  }

  setActiveMap(mapId: string | null): void {
    if (this.state.activeMapId === mapId) {
      return;
    }
    this.state.activeMapId = mapId;
    this.state.pointerWorld = null;
    this.state.polylinePreviewWorld = null;
    this.state.polylines = [];
    this.state.draftPolyline = [];
    this.clearContinuationState();
    this.lastRemovedPolyline = null;
    this.emit();
  }

  setView(view: ViewState): void {
    this.state.view = { ...view };
    this.emit();
  }

  patchView(viewPatch: Partial<ViewState>): void {
    this.state.view = {
      ...this.state.view,
      ...viewPatch,
    };
    this.emit();
  }

  setPointer(pointerWorld: PointPx | null): void {
    this.state.pointerWorld = pointerWorld ? clonePoint(pointerWorld) : null;
    this.emit();
  }

  setPolylinePreview(pointerWorld: PointPx | null): void {
    this.state.polylinePreviewWorld = pointerWorld ? clonePoint(pointerWorld) : null;
    this.emit();
  }

  setToolMode(toolMode: ToolMode): void {
    if (this.state.toolMode === toolMode) {
      return;
    }
    this.state.toolMode = toolMode;
    this.emit();
  }

  setPolylineSettings(settingsPatch: Partial<PolylineSettings>): void {
    this.state.polylineSettings = {
      ...this.state.polylineSettings,
      ...settingsPatch,
    };
    this.emit();
  }

  setRobotEnabled(enabled: boolean): void {
    if (this.state.robotEnabled === enabled) {
      return;
    }
    this.state.robotEnabled = enabled;
    this.emit();
  }

  setRobotSize(widthMm: number, heightMm: number): void {
    const nextWidth = Number.isFinite(widthMm) && widthMm > 0 ? widthMm : this.state.robotWidthMm;
    const nextHeight = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : this.state.robotHeightMm;
    if (nextWidth === this.state.robotWidthMm && nextHeight === this.state.robotHeightMm) {
      return;
    }
    this.state.robotWidthMm = nextWidth;
    this.state.robotHeightMm = nextHeight;
    this.emit();
  }

  replaceSessionData(data: SessionReplacement): void {
    this.state.polylines = clonePolylines(data.polylines.filter((polyline) => polyline.points.length >= 2));
    this.state.draftPolyline = [];
    this.state.polylinePreviewWorld = null;
    this.state.polylineSettings = { ...data.polylineSettings };
    this.state.robotEnabled = data.robotEnabled;
    this.state.robotWidthMm = data.robotWidthMm;
    this.state.robotHeightMm = data.robotHeightMm;
    this.clearContinuationState();
    this.lastRemovedPolyline = null;
    this.emit();
  }

  addDraftPolylinePoint(point: PointPx): void {
    this.lastRemovedPolyline = null;
    this.state.draftPolyline = [...this.state.draftPolyline, clonePoint(point)];
    this.emit();
  }

  undoDraftPolylinePoint(): boolean {
    if (this.state.draftPolyline.length === 0) {
      return false;
    }
    const minPointCount = this.continuingOriginalPolyline?.points.length ?? 0;
    if (this.continuingPolylineId && this.state.draftPolyline.length <= minPointCount) {
      return false;
    }
    this.state.draftPolyline = this.state.draftPolyline.slice(0, -1);
    this.emit();
    return true;
  }

  cancelDraftPolyline(): boolean {
    if (this.state.draftPolyline.length === 0 && !this.continuingPolylineId) {
      return false;
    }
    this.restoreContinuingPolyline();
    this.state.draftPolyline = [];
    this.clearContinuationState();
    this.emit();
    return true;
  }

  finishDraftPolyline(): Polyline | null {
    if (this.state.draftPolyline.length < 2) {
      return null;
    }

    const polyline: Polyline = {
      id: this.continuingPolylineId ?? `polyline-${Date.now()}-${this.state.polylines.length + 1}`,
      points: clonePoints(this.state.draftPolyline),
    };
    if (this.continuingPolylineId) {
      const insertIndex = Math.max(0, Math.min(this.continuingOriginalIndex, this.state.polylines.length));
      this.state.polylines = [
        ...this.state.polylines.slice(0, insertIndex),
        polyline,
        ...this.state.polylines.slice(insertIndex),
      ];
      this.clearContinuationState();
    } else {
      this.state.polylines = [...this.state.polylines, polyline];
    }
    this.lastRemovedPolyline = null;
    this.state.draftPolyline = [];
    this.emit();
    return polyline;
  }

  clearPolylines(): boolean {
    if (this.state.polylines.length === 0 && this.state.draftPolyline.length === 0) {
      return false;
    }
    this.state.polylines = [];
    this.state.draftPolyline = [];
    this.clearContinuationState();
    this.lastRemovedPolyline = null;
    this.emit();
    return true;
  }

  removePolyline(polylineId: string): boolean {
    const polylineIndex = this.state.polylines.findIndex((polyline) => polyline.id === polylineId);
    if (polylineIndex < 0) {
      return false;
    }
    const removedPolyline = this.state.polylines[polylineIndex];
    this.lastRemovedPolyline = {
      polyline: {
        id: removedPolyline.id,
        points: clonePoints(removedPolyline.points),
      },
      index: polylineIndex,
    };
    const nextPolylines = [
      ...this.state.polylines.slice(0, polylineIndex),
      ...this.state.polylines.slice(polylineIndex + 1),
    ];
    this.state.polylines = nextPolylines;
    this.emit();
    return true;
  }

  restoreLastRemovedPolyline(): Polyline | null {
    if (!this.lastRemovedPolyline) {
      return null;
    }
    const { polyline, index } = this.lastRemovedPolyline;
    if (this.state.polylines.some((item) => item.id === polyline.id)) {
      this.lastRemovedPolyline = null;
      return null;
    }

    const restoredPolyline = {
      id: polyline.id,
      points: clonePoints(polyline.points),
    };
    const insertIndex = Math.max(0, Math.min(index, this.state.polylines.length));
    this.state.polylines = [
      ...this.state.polylines.slice(0, insertIndex),
      restoredPolyline,
      ...this.state.polylines.slice(insertIndex),
    ];
    this.lastRemovedPolyline = null;
    this.emit();
    return {
      id: restoredPolyline.id,
      points: clonePoints(restoredPolyline.points),
    };
  }

  insertPolylinePoint(polylineId: string, pointIndex: number, point: PointPx): boolean {
    let changed = false;
    this.lastRemovedPolyline = null;
    this.state.polylines = this.state.polylines.map((polyline) => {
      if (polyline.id !== polylineId) {
        return polyline;
      }

      const insertIndex = Math.max(1, Math.min(pointIndex, polyline.points.length));
      changed = true;
      return {
        id: polyline.id,
        points: [
          ...polyline.points.slice(0, insertIndex),
          clonePoint(point),
          ...polyline.points.slice(insertIndex),
        ],
      };
    });

    if (!changed) {
      return false;
    }
    this.emit();
    return true;
  }

  deletePolylinePoint(target: PolylinePointTarget): boolean {
    if (target.kind === "draft") {
      if (target.pointIndex < 0 || target.pointIndex >= this.state.draftPolyline.length) {
        return false;
      }
      this.lastRemovedPolyline = null;
      this.state.draftPolyline = this.state.draftPolyline.filter((_, index) => index !== target.pointIndex);
      this.emit();
      return true;
    }

    const polylineIndex = this.state.polylines.findIndex((polyline) => polyline.id === target.polylineId);
    if (polylineIndex < 0) {
      return false;
    }
    const polyline = this.state.polylines[polylineIndex];
    if (target.pointIndex < 0 || target.pointIndex >= polyline.points.length) {
      return false;
    }

    const points = polyline.points.filter((_, index) => index !== target.pointIndex);
    if (points.length < 2) {
      this.lastRemovedPolyline = {
        polyline: {
          id: polyline.id,
          points: clonePoints(polyline.points),
        },
        index: polylineIndex,
      };
      this.state.polylines = [
        ...this.state.polylines.slice(0, polylineIndex),
        ...this.state.polylines.slice(polylineIndex + 1),
      ];
      this.emit();
      return true;
    }

    this.lastRemovedPolyline = null;
    this.state.polylines = this.state.polylines.map((item, index) =>
      index === polylineIndex
        ? {
            id: item.id,
            points,
          }
        : item,
    );
    this.emit();
    return true;
  }

  startContinuingPolyline(polylineId: string): boolean {
    if (this.state.draftPolyline.length > 0 || this.continuingPolylineId) {
      return false;
    }

    const polylineIndex = this.state.polylines.findIndex((polyline) => polyline.id === polylineId);
    if (polylineIndex < 0) {
      return false;
    }

    const polyline = this.state.polylines[polylineIndex];
    this.lastRemovedPolyline = null;
    this.continuingPolylineId = polyline.id;
    this.continuingOriginalPolyline = {
      id: polyline.id,
      points: clonePoints(polyline.points),
    };
    this.continuingOriginalIndex = polylineIndex;
    this.state.polylines = [
      ...this.state.polylines.slice(0, polylineIndex),
      ...this.state.polylines.slice(polylineIndex + 1),
    ];
    this.state.draftPolyline = clonePoints(polyline.points);
    this.state.toolMode = "polyline";
    this.emit();
    return true;
  }

  movePolylinePoint(target: PolylinePointTarget, point: PointPx): boolean {
    this.lastRemovedPolyline = null;
    if (target.kind === "draft") {
      if (target.pointIndex < 0 || target.pointIndex >= this.state.draftPolyline.length) {
        return false;
      }
      this.state.draftPolyline = this.state.draftPolyline.map((draftPoint, index) =>
        index === target.pointIndex ? clonePoint(point) : draftPoint,
      );
      this.emit();
      return true;
    }

    let changed = false;
    this.state.polylines = this.state.polylines.map((polyline) => {
      if (polyline.id !== target.polylineId) {
        return polyline;
      }
      if (target.pointIndex < 0 || target.pointIndex >= polyline.points.length) {
        return polyline;
      }
      changed = true;
      return {
        id: polyline.id,
        points: polyline.points.map((polylinePoint, index) =>
          index === target.pointIndex ? clonePoint(point) : polylinePoint,
        ),
      };
    });

    if (!changed) {
      return false;
    }
    this.emit();
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(cloneState(this.state));
    }
  }

  private restoreContinuingPolyline(): void {
    if (!this.continuingOriginalPolyline) {
      return;
    }
    const existingIndex = this.state.polylines.findIndex((polyline) => polyline.id === this.continuingOriginalPolyline?.id);
    if (existingIndex >= 0) {
      return;
    }
    const insertIndex = Math.max(0, Math.min(this.continuingOriginalIndex, this.state.polylines.length));
    const restoredPolyline = {
      id: this.continuingOriginalPolyline.id,
      points: clonePoints(this.continuingOriginalPolyline.points),
    };
    this.state.polylines = [
      ...this.state.polylines.slice(0, insertIndex),
      restoredPolyline,
      ...this.state.polylines.slice(insertIndex),
    ];
  }

  private clearContinuationState(): void {
    this.continuingPolylineId = null;
    this.continuingOriginalPolyline = null;
    this.continuingOriginalIndex = -1;
  }
}
