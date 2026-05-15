import {
  clamp,
  clampWorldToMap,
  relativeMmToWorld,
  screenToWorld,
  worldToRelativeMm,
} from "../geometry/measure";
import type { LoadedMap } from "../io/mapConfig";
import { AppStore } from "../state/store";
import type { PointPx, PolylinePointTarget, PolylineSettings, ToolMode, ViewState } from "../state/types";

export interface InputControllerOptions {
  canvas: HTMLCanvasElement;
  store: AppStore;
  getActiveMap: () => LoadedMap | null;
  getToolMode: () => ToolMode;
  getPolylineSettings: () => PolylineSettings;
  getViewportSize: () => { width: number; height: number };
  requestRender: () => void;
  onResetView: () => void;
  onAddPolylinePoint: (point: PointPx) => void;
  onUndoPolylinePoint: () => void;
  onFinishPolyline: () => void;
  onCancelPolyline: () => void;
  onDeletePolylinePointAt: (point: PointPx) => boolean;
  onDeletePolylineAt: (point: PointPx) => boolean;
  onContinuePolylineAt: (point: PointPx) => boolean;
  onInsertPolylinePointAt: (point: PointPx) => boolean;
  onMovePolylinePoint: (target: PolylinePointTarget, point: PointPx) => boolean;
  onPolylineHitAt: (point: PointPx) => boolean;
  onTogglePolylineMode: () => void;
  onToggleOrthoVh: () => void;
  onToggleRound10mm: () => void;
}

const PAN_VISIBLE_MARGIN_PX = 64;
const MAX_ZOOM_MULTIPLIER_FROM_MIN = 18;
const ARROW_PAN_SPEED_PX_PER_SEC = 520;
const POINT_HIT_RADIUS_SCREEN_PX = 12;

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: AppStore;
  private readonly getActiveMap: () => LoadedMap | null;
  private readonly getToolMode: () => ToolMode;
  private readonly getPolylineSettings: () => PolylineSettings;
  private readonly getViewportSize: () => { width: number; height: number };
  private readonly requestRender: () => void;
  private readonly onResetView: () => void;
  private readonly onAddPolylinePoint: (point: PointPx) => void;
  private readonly onUndoPolylinePoint: () => void;
  private readonly onFinishPolyline: () => void;
  private readonly onCancelPolyline: () => void;
  private readonly onDeletePolylinePointAt: (point: PointPx) => boolean;
  private readonly onDeletePolylineAt: (point: PointPx) => boolean;
  private readonly onContinuePolylineAt: (point: PointPx) => boolean;
  private readonly onInsertPolylinePointAt: (point: PointPx) => boolean;
  private readonly onMovePolylinePoint: (target: PolylinePointTarget, point: PointPx) => boolean;
  private readonly onPolylineHitAt: (point: PointPx) => boolean;
  private readonly onTogglePolylineMode: () => void;
  private readonly onToggleOrthoVh: () => void;
  private readonly onToggleRound10mm: () => void;

  private isPanning = false;
  private movingPointTarget: PolylinePointTarget | null = null;
  private lastPanScreenPoint: PointPx | null = null;
  private readonly pressedArrowKeys = new Set<string>();
  private keyboardPanHandle: number | null = null;
  private lastKeyboardPanTimeMs = 0;

  constructor(options: InputControllerOptions) {
    this.canvas = options.canvas;
    this.store = options.store;
    this.getActiveMap = options.getActiveMap;
    this.getToolMode = options.getToolMode;
    this.getPolylineSettings = options.getPolylineSettings;
    this.getViewportSize = options.getViewportSize;
    this.requestRender = options.requestRender;
    this.onResetView = options.onResetView;
    this.onAddPolylinePoint = options.onAddPolylinePoint;
    this.onUndoPolylinePoint = options.onUndoPolylinePoint;
    this.onFinishPolyline = options.onFinishPolyline;
    this.onCancelPolyline = options.onCancelPolyline;
    this.onDeletePolylinePointAt = options.onDeletePolylinePointAt;
    this.onDeletePolylineAt = options.onDeletePolylineAt;
    this.onContinuePolylineAt = options.onContinuePolylineAt;
    this.onInsertPolylinePointAt = options.onInsertPolylinePointAt;
    this.onMovePolylinePoint = options.onMovePolylinePoint;
    this.onPolylineHitAt = options.onPolylineHitAt;
    this.onTogglePolylineMode = options.onTogglePolylineMode;
    this.onToggleOrthoVh = options.onToggleOrthoVh;
    this.onToggleRound10mm = options.onToggleRound10mm;

    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
  }

  dispose(): void {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    this.stopKeyboardPanLoop();
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onMouseLeave = (): void => {
    if (!this.isPanning) {
      this.store.setPointer(null);
      this.store.setPolylinePreview(null);
      this.requestRender();
    }
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    const toolMode = this.getToolMode();
    if (event.button === 2) {
      event.preventDefault();
      this.canvas.focus();
      const activeMap = this.getActiveMap();
      if (!activeMap) {
        return;
      }
      const point = this.getCanvasPoint(event);
      this.updatePointer(point);
      const world = screenToWorld(point, this.store.getState().view);
      if (this.onDeletePolylinePointAt(world)) {
        return;
      }
      if (this.onDeletePolylineAt(world)) {
        return;
      }
      if (toolMode === "polyline") {
        this.onFinishPolyline();
      }
      return;
    }

    if (toolMode === "polyline" && event.button === 0) {
      event.preventDefault();
      this.canvas.focus();
      const point = this.getCanvasPoint(event);
      this.updatePointer(point);
      const activeMap = this.getActiveMap();
      if (!activeMap) {
        return;
      }
      const world = screenToWorld(point, this.store.getState().view);
      const pointTarget = this.findPointTargetAt(world);
      if (pointTarget) {
        this.movingPointTarget = pointTarget;
        this.onMovePolylinePoint(pointTarget, this.applyPointMoveConstraints(world, activeMap));
        this.requestRender();
        return;
      }
      if (this.store.getState().draftPolyline.length === 0 && this.onPolylineHitAt(world)) {
        return;
      }
      this.onAddPolylinePoint(this.applyPolylineConstraints(clampWorldToMap(world, activeMap.spec), activeMap));
      return;
    }

    if (event.button === 0 && toolMode === "pan") {
      const activeMap = this.getActiveMap();
      if (activeMap) {
        const point = this.getCanvasPoint(event);
        const world = screenToWorld(point, this.store.getState().view);
        const pointTarget = this.findPointTargetAt(world);
        if (pointTarget) {
          event.preventDefault();
          this.canvas.focus();
          this.movingPointTarget = pointTarget;
          this.updatePointer(point);
          this.onMovePolylinePoint(pointTarget, this.applyPointMoveConstraints(world, activeMap));
          this.requestRender();
          return;
        }
      }
    }

    const canStartPan = event.button === 1 || (event.button === 0 && toolMode === "pan");
    if (!canStartPan) {
      return;
    }
    event.preventDefault();
    this.canvas.focus();
    this.isPanning = true;
    this.lastPanScreenPoint = this.getCanvasPoint(event);
    this.updatePointer(this.lastPanScreenPoint);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.canvas.focus();
    const activeMap = this.getActiveMap();
    if (!activeMap || this.store.getState().draftPolyline.length > 0) {
      return;
    }

    const point = this.getCanvasPoint(event);
    this.updatePointer(point);
    const world = screenToWorld(point, this.store.getState().view);
    if (this.onContinuePolylineAt(world)) {
      this.requestRender();
      return;
    }
    if (this.onInsertPolylinePointAt(world)) {
      this.requestRender();
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    this.movingPointTarget = null;
    this.isPanning = false;
    this.lastPanScreenPoint = null;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    const point = this.getCanvasPoint(event);
    if (this.movingPointTarget) {
      const activeMap = this.getActiveMap();
      if (activeMap) {
        const world = screenToWorld(point, this.store.getState().view);
        this.onMovePolylinePoint(this.movingPointTarget, this.applyPointMoveConstraints(world, activeMap));
      }
      this.updatePointer(point);
      this.requestRender();
      return;
    }
    if (this.isPanning && this.lastPanScreenPoint) {
      const dx = point.x - this.lastPanScreenPoint.x;
      const dy = point.y - this.lastPanScreenPoint.y;
      this.lastPanScreenPoint = point;
      this.panBy(dx, dy);
    }
    this.updatePointer(point);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      return;
    }
    event.preventDefault();

    const state = this.store.getState();
    const view = state.view;
    const cursor = this.getCanvasPoint(event);
    const worldAtCursor = screenToWorld(cursor, view);
    const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const maxZoom = view.minZoom * MAX_ZOOM_MULTIPLIER_FROM_MIN;
    const nextZoom = clamp(view.zoom * zoomFactor, view.minZoom, maxZoom);
    if (nextZoom === view.zoom) {
      return;
    }

    let panX = cursor.x - worldAtCursor.x * nextZoom;
    let panY = cursor.y - worldAtCursor.y * nextZoom;
    ({ panX, panY } = this.clampPan(activeMap, nextZoom, panX, panY));

    this.store.setView({
      zoom: nextZoom,
      minZoom: view.minZoom,
      panX,
      panY,
    });
    this.updatePointer(cursor);
    this.requestRender();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.shouldCapturePolylineShortcut(event)) {
      event.preventDefault();
      this.handlePolylineShortcut(event);
      return;
    }

    if (this.shouldCaptureSpaceKey(event)) {
      event.preventDefault();
      this.onResetView();
      return;
    }

    if (!this.shouldCaptureArrowKey(event)) {
      return;
    }
    event.preventDefault();
    this.pressedArrowKeys.add(event.key);
    this.startKeyboardPanLoop();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!this.isArrowKey(event.key)) {
      return;
    }
    this.pressedArrowKeys.delete(event.key);
    if (this.pressedArrowKeys.size === 0) {
      this.stopKeyboardPanLoop();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.pressedArrowKeys.clear();
    this.stopKeyboardPanLoop();
  };

  private updatePointer(screenPoint: PointPx): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      this.store.setPointer(null);
      this.store.setPolylinePreview(null);
      return;
    }
    const pointer = screenToWorld(screenPoint, this.store.getState().view);
    this.store.setPointer(pointer);
    this.store.setPolylinePreview(
      this.getToolMode() === "polyline" ? this.applyPolylineConstraints(pointer, activeMap) : null,
    );
    this.requestRender();
  }

  private applyPolylineConstraints(point: PointPx, map: LoadedMap): PointPx {
    const settings = this.getPolylineSettings();
    const draftPolyline = this.store.getState().draftPolyline;
    let relative = worldToRelativeMm(point, map.spec);

    if (settings.orthoVh && draftPolyline.length > 0) {
      const previous = worldToRelativeMm(draftPolyline[draftPolyline.length - 1], map.spec);
      const dx = Math.abs(relative.xMm - previous.xMm);
      const dy = Math.abs(relative.yMm - previous.yMm);
      relative = dx >= dy ? { xMm: relative.xMm, yMm: previous.yMm } : { xMm: previous.xMm, yMm: relative.yMm };
    }

    if (settings.round10mm) {
      relative = {
        xMm: Math.round(relative.xMm / 10) * 10,
        yMm: Math.round(relative.yMm / 10) * 10,
      };
    }

    return clampWorldToMap(relativeMmToWorld(relative, map.spec), map.spec);
  }

  private applyPointMoveConstraints(point: PointPx, map: LoadedMap): PointPx {
    if (!this.getPolylineSettings().round10mm) {
      return clampWorldToMap(point, map.spec);
    }

    const relative = worldToRelativeMm(point, map.spec);
    return clampWorldToMap(
      relativeMmToWorld(
        {
          xMm: Math.round(relative.xMm / 10) * 10,
          yMm: Math.round(relative.yMm / 10) * 10,
        },
        map.spec,
      ),
      map.spec,
    );
  }

  private findPointTargetAt(point: PointPx): PolylinePointTarget | null {
    const state = this.store.getState();
    const hitRadiusWorldPx = POINT_HIT_RADIUS_SCREEN_PX / state.view.zoom;

    for (let i = state.draftPolyline.length - 1; i >= 0; i -= 1) {
      if (Math.hypot(point.x - state.draftPolyline[i].x, point.y - state.draftPolyline[i].y) <= hitRadiusWorldPx) {
        return { kind: "draft", pointIndex: i };
      }
    }

    for (let polylineIndex = state.polylines.length - 1; polylineIndex >= 0; polylineIndex -= 1) {
      const polyline = state.polylines[polylineIndex];
      for (let pointIndex = polyline.points.length - 1; pointIndex >= 0; pointIndex -= 1) {
        const polylinePoint = polyline.points[pointIndex];
        if (Math.hypot(point.x - polylinePoint.x, point.y - polylinePoint.y) <= hitRadiusWorldPx) {
          return { kind: "polyline", polylineId: polyline.id, pointIndex };
        }
      }
    }

    return null;
  }

  private panBy(dx: number, dy: number): void {
    const activeMap = this.getActiveMap();
    const view = this.store.getState().view;
    let panX = view.panX + dx;
    let panY = view.panY + dy;

    if (activeMap) {
      ({ panX, panY } = this.clampPan(activeMap, view.zoom, panX, panY));
    }

    this.store.patchView({ panX, panY });
    this.requestRender();
  }

  private getCanvasPoint(event: MouseEvent | WheelEvent): PointPx {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private clampPan(
    map: LoadedMap,
    zoom: number,
    panX: number,
    panY: number,
  ): { panX: number; panY: number } {
    const viewport = this.getViewportSize();
    const scaledWidth = map.spec.imgWidthPx * zoom;
    const scaledHeight = map.spec.imgHeightPx * zoom;

    const minPanX = PAN_VISIBLE_MARGIN_PX - scaledWidth;
    const maxPanX = viewport.width - PAN_VISIBLE_MARGIN_PX;
    const minPanY = PAN_VISIBLE_MARGIN_PX - scaledHeight;
    const maxPanY = viewport.height - PAN_VISIBLE_MARGIN_PX;

    const clampedX =
      minPanX > maxPanX ? (viewport.width - scaledWidth) * 0.5 : clamp(panX, minPanX, maxPanX);
    const clampedY =
      minPanY > maxPanY ? (viewport.height - scaledHeight) * 0.5 : clamp(panY, minPanY, maxPanY);

    return { panX: clampedX, panY: clampedY };
  }

  private isArrowKey(key: string): boolean {
    return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
  }

  private shouldCaptureArrowKey(event: KeyboardEvent): boolean {
    if (!this.isArrowKey(event.key)) {
      return false;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    return !this.isEditableEventTarget(event.target);
  }

  private shouldCaptureSpaceKey(event: KeyboardEvent): boolean {
    if (event.code !== "Space" && event.key !== " " && event.key !== "Spacebar") {
      return false;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    return !this.isEditableEventTarget(event.target);
  }

  private shouldCapturePolylineShortcut(event: KeyboardEvent): boolean {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    if (this.isEditableEventTarget(event.target)) {
      return false;
    }
    const key = event.key.toLowerCase();
    if (key === "p" || key === "o" || key === "r") {
      return true;
    }
    if (this.getToolMode() !== "polyline") {
      return false;
    }
    return key === "enter" || key === "escape" || key === "backspace" || key === "delete";
  }

  private handlePolylineShortcut(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === "p") {
      this.onTogglePolylineMode();
      return;
    }
    if (key === "o") {
      this.onToggleOrthoVh();
      return;
    }
    if (key === "r") {
      this.onToggleRound10mm();
      return;
    }

    if (this.getToolMode() !== "polyline") {
      return;
    }

    if (key === "enter") {
      this.onFinishPolyline();
      return;
    }
    if (key === "escape") {
      this.onCancelPolyline();
      return;
    }
    if (key === "backspace" || key === "delete") {
      this.onUndoPolylinePoint();
    }
  }

  private isEditableEventTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const tag = target.tagName;
    return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  private startKeyboardPanLoop(): void {
    if (this.keyboardPanHandle !== null) {
      return;
    }
    this.lastKeyboardPanTimeMs = performance.now();
    this.keyboardPanHandle = window.requestAnimationFrame(this.keyboardPanTick);
  }

  private stopKeyboardPanLoop(): void {
    if (this.keyboardPanHandle === null) {
      return;
    }
    window.cancelAnimationFrame(this.keyboardPanHandle);
    this.keyboardPanHandle = null;
    this.lastKeyboardPanTimeMs = 0;
  }

  private readonly keyboardPanTick = (timestampMs: number): void => {
    if (this.pressedArrowKeys.size === 0) {
      this.stopKeyboardPanLoop();
      return;
    }

    const dtSec = Math.max(0, (timestampMs - this.lastKeyboardPanTimeMs) / 1000);
    this.lastKeyboardPanTimeMs = timestampMs;

    const horizontal =
      (this.pressedArrowKeys.has("ArrowRight") ? 1 : 0) -
      (this.pressedArrowKeys.has("ArrowLeft") ? 1 : 0);
    const vertical =
      (this.pressedArrowKeys.has("ArrowDown") ? 1 : 0) -
      (this.pressedArrowKeys.has("ArrowUp") ? 1 : 0);

    if (horizontal !== 0 || vertical !== 0) {
      const length = Math.hypot(horizontal, vertical);
      const speed = (ARROW_PAN_SPEED_PX_PER_SEC * dtSec) / length;
      this.panBy(-horizontal * speed, -vertical * speed);
    }

    this.keyboardPanHandle = window.requestAnimationFrame(this.keyboardPanTick);
  };
}
