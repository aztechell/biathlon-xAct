import { clampWorldToMap, relativeMmToWorld, screenToWorld, worldToRelativeMm } from "../geometry/measure";
import { InputController } from "../input/controller";
import {
  findPolylineAt,
  findPolylineLastPointAt,
  findPolylinePointAt,
  findPolylineSegmentAt,
} from "./polylineHitTest";
import { RobotPlaybackController, type RobotPlaybackAction } from "./robotPlayback";
import {
  loadMapByEntry,
  loadMapManifest,
  type LoadedMap,
  type MapManifestEntry,
} from "../io/mapConfig";
import { parseAutosave, serializeAutosave } from "../io/autosave";
import {
  parseRobotCode,
  parseRobotCodeMissions,
  serializeRobotCodeMissionsPreservingActions,
  splitRobotCodeMissions,
  type ParsedRobotCode,
} from "../io/robotCode";
import { parseSession, serializeSession } from "../io/session";
import { CanvasRenderer } from "../render/canvasRenderer";
import { AppStore } from "../state/store";
import type {
  AnimationSpeedMultiplier,
  PointPx,
  PolylinePointTarget,
  RobotInitialHeadingMarker,
  RobotTurnMarker,
  ToolMode,
  ViewState,
} from "../state/types";
import { PolylinePanelView } from "../ui/polylinePanel";
import { ToolbarView } from "../ui/toolbar";

const INITIAL_FIT_FACTOR = 0.9;
const MIN_FIT_FACTOR = 0.5;
const POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX = 10;
const MAX_DRIVE_SPEED = 100;
const ANIMATION_SPEED_MULTIPLIERS = [2, 4, 8, 16] as const;
const LOCAL_AUTOSAVE_KEY = "biathlon-xact.autosave.v1";

export class App {
  private readonly root: HTMLElement;
  private readonly stage: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly loadingOverlay: HTMLDivElement;
  private readonly loadingText: HTMLDivElement;
  private readonly toolbar: ToolbarView;
  private readonly polylinePanel: PolylinePanelView;
  private readonly renderer: CanvasRenderer;
  private readonly store = new AppStore();
  private readonly robotPlayback: RobotPlaybackController;
  private readonly resizeObserver: ResizeObserver;
  private readonly configUrl: string;

  private activeLoadedMap: LoadedMap | null = null;
  private mapManifestOrder: MapManifestEntry[] = [];
  private inputController: InputController | null = null;
  private renderHandle: number | null = null;
  private autosaveHandle: number | null = null;
  private lastAutosaveJson = "";
  private isRestoringAutosave = false;
  private mapLoadRequestId = 0;
  private robotCodeOverride: string | null = null;
  private isSettingInitialHeading = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.className = "app-root";
    this.configUrl = `${import.meta.env.BASE_URL}maps/config.txt`;

    const toolbarHost = document.createElement("div");
    this.stage = document.createElement("div");
    this.stage.className = "stage";
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Biathlon map viewer");
    this.stage.appendChild(this.canvas);

    this.loadingOverlay = document.createElement("div");
    this.loadingOverlay.className = "stage-loading-overlay";
    this.loadingOverlay.setAttribute("aria-hidden", "true");
    const spinner = document.createElement("div");
    spinner.className = "stage-loading-spinner";
    this.loadingText = document.createElement("div");
    this.loadingText.className = "stage-loading-text";
    this.loadingText.textContent = "Loading map...";
    this.loadingOverlay.append(spinner, this.loadingText);
    this.stage.appendChild(this.loadingOverlay);

    this.root.append(toolbarHost, this.stage);

    this.renderer = new CanvasRenderer(this.canvas);
    this.robotPlayback = new RobotPlaybackController({
      getActiveMap: () => this.getActiveMap(),
      getPolylines: () => this.store.getState().polylines,
      getPlaybackActions: (polylineId) => this.getRobotPlaybackActions(polylineId),
      getInitialHeadingRad: () => this.getInitialHeadingRad(),
      getDriveSpeed: () => this.store.getState().polylineSettings.driveSpeed,
      getAnimationSpeedMultiplier: () => this.getAnimationSpeedMultiplier(),
      requestRender: () => this.scheduleRender(),
      onPlaybackStateChange: () => this.syncStateToViews(),
    });
    this.polylinePanel = new PolylinePanelView(this.stage, {
      onSpeedChange: (speed) => this.setDriveSpeed(speed),
      onAnimationSpeedChange: (multiplier) => this.setAnimationSpeedMultiplier(multiplier),
      onPlayPolyline: (polylineId, code) => this.playRobotCode(polylineId, code),
      onApplyRobotCode: (code) => this.applyRobotCode(code),
      onRobotCodeChange: (code) => this.updateRobotCodeDraft(code),
    });
    this.toolbar = new ToolbarView(toolbarHost, {
      onTogglePolylineMode: () => this.togglePolylineMode(),
      onToggleOrthoVh: () => this.toggleOrthoVh(),
      onToggleRound10mm: () => this.toggleRound10mm(),
      onToggleRobot: () => this.toggleRobot(),
      onRobotSizeChange: (widthMm, heightMm) => this.setRobotSize(widthMm, heightMm),
      onTogglePointCoordinates: () => this.togglePointCoordinates(),
      onToggleCoordinateMode: () => this.toggleCoordinateMode(),
      onUndoPolylinePoint: () => this.undoPolylinePoint(),
      onFinishPolyline: () => this.finishPolyline(),
      onClearPolylines: () => this.clearPolylines(),
      onExportSession: () => this.exportSession(),
      onImportSessionFile: (file) => void this.importSessionFile(file),
    });

    this.store.subscribe((state) => {
      this.syncStateToViews(state);
      this.scheduleAutosave();
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
  }

  async start(): Promise<void> {
    this.resizeObserver.observe(this.stage);
    this.handleResize();

    this.inputController = new InputController({
      canvas: this.canvas,
      store: this.store,
      getActiveMap: () => this.getActiveMap(),
      getToolMode: () => this.store.getState().toolMode,
      getPolylineSettings: () => this.store.getState().polylineSettings,
      isSettingInitialHeading: () => this.isSettingInitialHeading,
      getViewportSize: () => this.renderer.getViewportSize(),
      requestRender: () => this.scheduleRender(),
      onResetView: () => this.resetViewToActiveMap(),
      onAddPolylinePoint: (point) => this.addPolylinePoint(point),
      onUndoPolylinePoint: () => this.undoPolylinePoint(),
      onFinishPolyline: () => this.finishPolyline(),
      onCancelPolyline: () => this.cancelPolyline(),
      onDeletePolylinePointAt: (point) => this.deletePolylinePointAt(point),
      onDeletePolylineAt: (point) => this.deletePolylineAt(point),
      onContinuePolylineAt: (point) => this.continuePolylineAt(point),
      onInsertPolylinePointAt: (point) => this.insertPolylinePointAt(point),
      onMovePolylinePoint: (target, point) => this.movePolylinePoint(target, point),
      onPolylineHitAt: (point) => this.hasPolylineAt(point),
      onTogglePolylineMode: () => this.togglePolylineMode(),
      onToggleOrthoVh: () => this.toggleOrthoVh(),
      onToggleRound10mm: () => this.toggleRound10mm(),
    });

    await this.loadManifestAndActivateMap();
    this.scheduleRender();
  }

  private syncStateToViews(state = this.store.getState()): void {
    const map = this.getActiveMap();
    this.canvas.classList.toggle("polyline-cursor", state.toolMode === "polyline");
    this.toolbar.setToolMode(state.toolMode);
    this.toolbar.setPolylineSettings(state.polylineSettings);
    this.toolbar.setRobotEnabled(state.robotEnabled);
    this.toolbar.setRobotSize(state.robotWidthMm, state.robotHeightMm);
    this.toolbar.setPolylineActionsEnabled(
      state.draftPolyline.length > 0 || this.store.hasRestorablePolyline(),
      state.draftPolyline.length > 0,
      state.polylines.length > 0 || state.draftPolyline.length > 0,
    );
    this.polylinePanel.update({
      map,
      toolMode: state.toolMode,
      polylines: state.polylines,
      draftPolyline: state.draftPolyline,
      coordinateMode: state.polylineSettings.coordinateMode,
      driveSpeed: state.polylineSettings.driveSpeed,
      animationSpeedMultiplier: state.polylineSettings.animationSpeedMultiplier,
      playingPolylineId: this.robotPlayback.getPlayingPolylineId(),
      robotCodeOverride: this.robotCodeOverride,
    });
    this.scheduleRender();
  }

  private scheduleAutosave(): void {
    if (this.isRestoringAutosave || !this.getActiveMap()) {
      return;
    }
    if (this.autosaveHandle !== null) {
      window.clearTimeout(this.autosaveHandle);
    }
    this.autosaveHandle = window.setTimeout(() => {
      this.autosaveHandle = null;
      this.saveAutosave();
    }, 250);
  }

  private saveAutosave(): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      return;
    }

    try {
      const json = serializeAutosave(
        this.store.getState(),
        activeMap.spec,
        this.robotCodeOverride,
        this.isSettingInitialHeading,
      );
      if (json === this.lastAutosaveJson) {
        return;
      }
      window.localStorage.setItem(LOCAL_AUTOSAVE_KEY, json);
      this.lastAutosaveJson = json;
    } catch (error) {
      console.warn("[Biathlon xAct] Autosave failed", error);
    }
  }

  private restoreAutosaveForMap(activeMap: LoadedMap): void {
    let json: string | null = null;
    try {
      json = window.localStorage.getItem(LOCAL_AUTOSAVE_KEY);
    } catch (error) {
      console.warn("[Biathlon xAct] Autosave read failed", error);
      return;
    }

    if (!json) {
      this.lastAutosaveJson = "";
      return;
    }

    try {
      const restored = parseAutosave(json, activeMap.spec);
      this.robotCodeOverride = restored.robotCodeOverride;
      this.isSettingInitialHeading = restored.isSettingInitialHeading;
      this.store.replaceAutosaveData(restored);
      this.lastAutosaveJson = serializeAutosave(
        this.store.getState(),
        activeMap.spec,
        this.robotCodeOverride,
        this.isSettingInitialHeading,
      );
      for (const warning of restored.warnings) {
        console.warn(`[Biathlon xAct] ${warning}`);
      }
    } catch (error) {
      console.warn("[Biathlon xAct] Autosave restore failed", error);
      this.lastAutosaveJson = "";
    }
  }

  private async loadManifestAndActivateMap(): Promise<void> {
    const requestId = this.mapLoadRequestId + 1;
    this.mapLoadRequestId = requestId;
    this.setLoadingState(true, "Loading map...");

    try {
      const manifest = await loadMapManifest(this.configUrl);
      if (requestId !== this.mapLoadRequestId) {
        return;
      }

      this.mapManifestOrder = manifest.maps;
      for (const warning of manifest.warnings) {
        console.warn(`[Biathlon xAct] ${warning}`);
      }

      const targetMap = this.pickStartupMap(manifest.defaultMapId);
      if (!targetMap) {
        this.activeLoadedMap = null;
        this.store.setActiveMap(null);
        this.toolbar.setStatus("No valid maps loaded", "error");
        return;
      }

      const loaded = await this.loadActiveMap(targetMap, requestId);
      if (requestId !== this.mapLoadRequestId) {
        return;
      }

      for (const warning of loaded.warnings) {
        console.warn(`[Biathlon xAct] ${warning}`);
      }

      if (!loaded.map) {
        this.toolbar.setStatus(`Failed to load ${targetMap.filename}`, "error");
        return;
      }

      if (manifest.warnings.length > 0 || loaded.warnings.length > 0) {
        this.toolbar.setStatus("Map loaded with warnings", "warn");
      } else {
        this.toolbar.setStatus("Map loaded", "info");
      }
    } catch (error) {
      if (requestId !== this.mapLoadRequestId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.toolbar.setStatus(`Map load failed: ${message}`, "error");
    } finally {
      if (requestId === this.mapLoadRequestId) {
        this.setLoadingState(false);
      }
    }
  }

  private pickStartupMap(defaultMapId: string | null): MapManifestEntry | null {
    if (defaultMapId) {
      const defaultMap = this.mapManifestOrder.find((map) => map.id === defaultMapId);
      if (defaultMap) {
        return defaultMap;
      }
    }
    return this.mapManifestOrder[0] ?? null;
  }

  private async loadActiveMap(
    entry: MapManifestEntry,
    requestId: number,
  ): Promise<{ map: LoadedMap | null; warnings: string[] }> {
    const loaded = await loadMapByEntry(entry, this.configUrl);
    if (requestId !== this.mapLoadRequestId) {
      return {
        map: null,
        warnings: loaded.warnings,
      };
    }

    this.robotPlayback.stop(true);
    this.robotCodeOverride = null;
    this.isSettingInitialHeading = false;
    this.activeLoadedMap = loaded.map;
    this.isRestoringAutosave = true;
    try {
      this.store.setActiveMap(entry.id);

      if (loaded.map) {
        this.ensureRendererViewportSize();
        this.fitViewToMap(loaded.map);
        this.restoreAutosaveForMap(loaded.map);
        this.canvas.focus();
      }
    } finally {
      this.isRestoringAutosave = false;
    }

    return loaded;
  }

  private getActiveMap(): LoadedMap | null {
    return this.activeLoadedMap;
  }

  private resetViewToActiveMap(): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      return;
    }
    this.fitViewToMap(activeMap);
    this.toolbar.setStatus("View reset", "info");
    this.canvas.focus();
  }

  private setToolMode(toolMode: ToolMode): void {
    this.store.setToolMode(toolMode);
    this.toolbar.setStatus(toolMode === "polyline" ? "Polyline mode" : "Polyline off", "info");
    this.canvas.focus();
  }

  private togglePolylineMode(): void {
    this.setToolMode(this.store.getState().toolMode === "polyline" ? "pan" : "polyline");
  }

  private toggleOrthoVh(): void {
    const next = !this.store.getState().polylineSettings.orthoVh;
    this.store.setPolylineSettings({ orthoVh: next });
    this.toolbar.setStatus(next ? "Ortho VH on" : "Ortho VH off", "info");
    this.canvas.focus();
  }

  private toggleRound10mm(): void {
    const next = !this.store.getState().polylineSettings.round10mm;
    this.store.setPolylineSettings({ round10mm: next });
    this.toolbar.setStatus(next ? "Round 10 mm on" : "Round 10 mm off", "info");
    this.canvas.focus();
  }

  private toggleRobot(): void {
    const next = !this.store.getState().robotEnabled;
    this.store.setRobotEnabled(next);
    this.toolbar.setStatus(next ? "Robot assist on" : "Robot assist off", "info");
    this.canvas.focus();
  }

  private setRobotSize(widthMm: number, heightMm: number): void {
    this.store.setRobotSize(widthMm, heightMm);
    this.toolbar.setStatus(`Robot size ${Math.round(widthMm)} x ${Math.round(heightMm)} mm`, "info");
  }

  private togglePointCoordinates(): void {
    const next = !this.store.getState().polylineSettings.showPointCoordinates;
    this.store.setPolylineSettings({ showPointCoordinates: next });
    this.toolbar.setStatus(next ? "Point coordinates shown" : "Point coordinates hidden", "info");
    this.canvas.focus();
  }

  private toggleCoordinateMode(): void {
    const next = this.store.getState().polylineSettings.coordinateMode === "absolute" ? "relative" : "absolute";
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    this.store.setPolylineSettings({ coordinateMode: next });
    this.syncRobotCodeAfterRouteEdit(previousCode);
    this.toolbar.setStatus(next === "relative" ? "Relative coordinates on" : "Absolute coordinates on", "info");
    this.canvas.focus();
  }

  private setDriveSpeed(speed: number): void {
    this.store.setPolylineSettings({ driveSpeed: this.normalizeDriveSpeed(speed) });
  }

  private setInitialHeading(headingDeg: number): void {
    this.store.setPolylineSettings({ initialHeadingDeg: normalizeHeadingDeg(headingDeg) });
  }

  private setInitialHeadingFromPoint(startPoint: PointPx, headingPoint: PointPx): boolean {
    const dx = headingPoint.x - startPoint.x;
    const dy = headingPoint.y - startPoint.y;
    if (Math.hypot(dx, dy) < 0.0001) {
      return false;
    }
    this.setInitialHeading(canvasRadToRobotHeadingDeg(Math.atan2(dy, dx)));
    return true;
  }

  private setAnimationSpeedMultiplier(multiplier: AnimationSpeedMultiplier): void {
    this.store.setPolylineSettings({ animationSpeedMultiplier: this.normalizeAnimationSpeedMultiplier(multiplier) });
  }

  private normalizeDriveSpeed(speed: number): number {
    return Math.max(0, Math.min(MAX_DRIVE_SPEED, Math.round(speed)));
  }

  private getAnimationSpeedMultiplier(): AnimationSpeedMultiplier {
    return this.normalizeAnimationSpeedMultiplier(this.store.getState().polylineSettings.animationSpeedMultiplier);
  }

  private normalizeAnimationSpeedMultiplier(multiplier: number): AnimationSpeedMultiplier {
    const rounded = Math.round(multiplier);
    return ANIMATION_SPEED_MULTIPLIERS.includes(rounded as AnimationSpeedMultiplier)
      ? (rounded as AnimationSpeedMultiplier)
      : 2;
  }

  private addPolylinePoint(point: PointPx): void {
    const stateBefore = this.store.getState();
    if (this.isSettingInitialHeading && stateBefore.draftPolyline.length === 1) {
      if (!this.setInitialHeadingFromPoint(stateBefore.draftPolyline[0], point)) {
        this.toolbar.setStatus("Pick a direction away from the first point", "warn");
        this.canvas.focus();
        return;
      }
      this.isSettingInitialHeading = false;
      this.scheduleAutosave();
      this.toolbar.setStatus("Initial heading set", "info");
      this.canvas.focus();
      return;
    }

    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const wasEmptyDraft = stateBefore.draftPolyline.length === 0;
    this.store.addDraftPolylinePoint(point);
    if (wasEmptyDraft) {
      this.isSettingInitialHeading = true;
      this.scheduleAutosave();
      this.toolbar.setStatus("Set robot heading", "info");
      this.canvas.focus();
      return;
    }
    this.isSettingInitialHeading = false;
    this.syncRobotCodeAfterRouteEdit(previousCode);
    const count = this.store.getState().draftPolyline.length;
    this.toolbar.setStatus(`Point ${count} added`, "info");
  }

  private undoPolylinePoint(): void {
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const changed = this.store.undoDraftPolylinePoint();
    if (changed) {
      if (this.store.getState().draftPolyline.length === 0) {
        this.isSettingInitialHeading = false;
        this.scheduleAutosave();
      }
      this.syncRobotCodeAfterRouteEdit(previousCode);
      this.toolbar.setStatus("Last point removed", "info");
      this.canvas.focus();
      return;
    }

    const restoredPolyline = this.store.restoreLastRemovedPolyline();
    if (restoredPolyline) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
    }
    this.toolbar.setStatus(
      restoredPolyline ? `Polyline restored: ${restoredPolyline.points.length} points` : "No draft points",
      "info",
    );
    this.canvas.focus();
  }

  private finishPolyline(): void {
    const draftPointCount = this.store.getState().draftPolyline.length;
    if (draftPointCount === 1) {
      this.toolbar.setStatus(this.isSettingInitialHeading ? "Set robot heading first" : "Need at least 2 points", "warn");
      this.canvas.focus();
      return;
    }

    const continuingPolylineId = this.store.getContinuingPolylineId();
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    this.isSettingInitialHeading = false;
    const polyline = this.store.finishDraftPolyline();
    if (polyline) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
    }
    this.toolbar.setStatus(
      polyline
        ? continuingPolylineId
          ? `Polyline continued: ${polyline.points.length} points`
          : `Polyline saved: ${polyline.points.length} points`
        : "No draft polyline",
      polyline ? "info" : "warn",
    );
    this.canvas.focus();
  }

  private cancelPolyline(): void {
    this.robotCodeOverride = null;
    this.isSettingInitialHeading = false;
    const changed = this.store.cancelDraftPolyline();
    if (!changed) {
      this.scheduleAutosave();
    }
    this.toolbar.setStatus(changed ? "Draft cancelled" : "No draft polyline", "info");
    this.canvas.focus();
  }

  private clearPolylines(): void {
    this.robotPlayback.stop(true);
    this.robotCodeOverride = null;
    this.isSettingInitialHeading = false;
    const changed = this.store.clearPolylines();
    if (!changed) {
      this.scheduleAutosave();
    }
    this.toolbar.setStatus(changed ? "Polylines cleared" : "No polylines", "info");
    this.canvas.focus();
  }

  private exportSession(): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      this.toolbar.setStatus("No map to export", "warn");
      return;
    }

    const json = serializeSession(this.store.getState(), activeMap.spec, this.robotCodeOverride);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `biathlon-xact-session-${formatFileTimestamp(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    this.toolbar.setStatus(`Session exported: ${this.store.getState().polylines.length} polylines`, "info");
    this.canvas.focus();
  }

  private async importSessionFile(file: File): Promise<void> {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      this.toolbar.setStatus("Load map before import", "warn");
      return;
    }

    try {
      const json = await file.text();
      const imported = parseSession(json, activeMap.spec);
      this.robotPlayback.stop(true);
      this.robotCodeOverride = imported.robotCodeOverride;
      this.isSettingInitialHeading = false;
      this.store.replaceSessionData(imported);
      for (const warning of imported.warnings) {
        console.warn(`[Biathlon xAct] ${warning}`);
      }
      this.toolbar.setStatus(
        `Session imported: ${imported.polylines.length} polylines`,
        imported.warnings.length > 0 ? "warn" : "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.toolbar.setStatus(`Session import failed: ${message}`, "error");
    } finally {
      this.canvas.focus();
    }
  }

  private applyRobotCode(code: string): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      this.toolbar.setStatus("Load map before applying code", "warn");
      return;
    }

    const missionTexts = splitRobotCodeMissions(code);
    const parsedMissions = missionTexts.map(parseRobotCode);
    const validMissions = parsedMissions
      .map((mission, index) => ({ mission, index }))
      .filter((item) => item.mission.drives.length >= 2);
    if (validMissions.length === 0) {
      this.toolbar.setStatus("Need at least 2 drive_to_point_action calls", "warn");
      this.canvas.focus();
      return;
    }

    const state = this.store.getState();
    const pointGroups = validMissions.map(({ mission, index }) =>
      this.robotCommandsToWorldPoints(mission, state.polylines[index]?.points[0] ?? null, activeMap),
    );
    const speedCommand = validMissions.flatMap((item) => item.mission.drives).find((command) => command.speed !== null);

    this.robotPlayback.stop(true);
    this.robotCodeOverride = normalizeMissionCode(validMissions.map((item) => missionTexts[item.index]));
    this.isSettingInitialHeading = false;
    const polylines = this.store.replaceWithPolylines(pointGroups);
    if (speedCommand?.speed !== null && speedCommand?.speed !== undefined) {
      this.store.setPolylineSettings({ driveSpeed: this.normalizeDriveSpeed(speedCommand.speed) });
    }
    this.toolbar.setStatus(
      polylines.length > 0 ? `Code applied: ${polylines.length} mission${polylines.length === 1 ? "" : "s"}` : "Need at least 2 points",
      polylines.length > 0 ? "info" : "warn",
    );
    this.canvas.focus();
  }

  private playRobotCode(polylineId: string, code: string): void {
    this.robotCodeOverride = code;
    this.scheduleAutosave();
    this.robotPlayback.toggle(polylineId);
  }

  private updateRobotCodeDraft(code: string): void {
    this.robotCodeOverride = code;
    this.scheduleAutosave();
  }

  private captureRobotCodeForRouteEdit(): string | null {
    const panelCode = this.polylinePanel.getCurrentCode();
    if (this.hasTimelineRobotActions(panelCode)) {
      return panelCode;
    }
    if (this.hasTimelineRobotActions(this.robotCodeOverride)) {
      return this.robotCodeOverride;
    }
    return null;
  }

  private syncRobotCodeAfterRouteEdit(previousCode: string | null): void {
    if (!previousCode) {
      this.robotCodeOverride = null;
      this.scheduleAutosave();
      return;
    }

    const activeMap = this.getActiveMap();
    if (!activeMap) {
      this.robotCodeOverride = previousCode;
      this.scheduleAutosave();
      return;
    }

    const state = this.store.getState();
    const missions = this.getMissionSourcesFromState(state);
    if (missions.length === 0) {
      this.robotCodeOverride = null;
      this.syncStateToViews(state);
      this.scheduleAutosave();
      return;
    }

    this.robotCodeOverride = serializeRobotCodeMissionsPreservingActions(
      missions,
      activeMap.spec,
      state.polylineSettings.coordinateMode,
      this.normalizeDriveSpeed(state.polylineSettings.driveSpeed),
      previousCode,
    );
    this.syncStateToViews(state);
    this.scheduleAutosave();
  }

  private hasTimelineRobotActions(code: string | null): code is string {
    return Boolean(code && parseRobotCode(code).actions.some((action) => action.kind !== "drive"));
  }

  private getMissionSourcesFromState(state = this.store.getState()): Array<{ title: string; points: PointPx[] }> {
    return [
      ...state.polylines.map((polyline, index) => ({
        title: `Mission ${index + 1}`,
        points: polyline.points,
      })),
      ...(state.draftPolyline.length > 0
        ? [
            {
              title: "Mission draft",
              points: state.draftPolyline,
            },
          ]
        : []),
    ];
  }

  private robotCommandsToWorldPoints(
    parsedRobotCode: ParsedRobotCode,
    originPoint: PointPx | null,
    activeMap: LoadedMap,
  ): PointPx[] {
    const state = this.store.getState();
    const originMm =
      state.polylineSettings.coordinateMode === "relative" && originPoint
        ? worldToRelativeMm(originPoint, activeMap.spec)
        : null;
    const resetMm = parsedRobotCode.reset ?? { xMm: 0, yMm: 0 };
    return parsedRobotCode.drives.map((command) => {
      const pointMm = originMm
        ? {
            xMm: originMm.xMm + command.xMm - resetMm.xMm,
            yMm: originMm.yMm + command.yMm - resetMm.yMm,
          }
        : {
            xMm: command.xMm,
            yMm: command.yMm,
          };
      return clampWorldToMap(relativeMmToWorld(pointMm, activeMap.spec), activeMap.spec);
    });
  }

  private getInitialHeadingRad(): number {
    return robotHeadingDegToCanvasRad(this.store.getState().polylineSettings.initialHeadingDeg);
  }

  private getRobotInitialHeadingMarker(): RobotInitialHeadingMarker | null {
    const state = this.store.getState();
    const startPoint = state.draftPolyline[0] ?? state.polylines[0]?.points[0] ?? null;
    if (!startPoint) {
      return null;
    }

    if (this.isSettingInitialHeading && state.polylinePreviewWorld) {
      const dx = state.polylinePreviewWorld.x - startPoint.x;
      const dy = state.polylinePreviewWorld.y - startPoint.y;
      if (Math.hypot(dx, dy) >= 0.0001) {
        return {
          position: { ...startPoint },
          headingRad: Math.atan2(dy, dx),
          isPreview: true,
        };
      }
    }

    return {
      position: { ...startPoint },
      headingRad: this.getInitialHeadingRad(),
      isPreview: false,
    };
  }

  private robotCommandHeadingDegToCanvasRad(commandHeadingDeg: number, resetHeadingDeg: number | null): number {
    const state = this.store.getState();
    const absoluteHeadingDeg =
      state.polylineSettings.coordinateMode === "relative"
        ? state.polylineSettings.initialHeadingDeg + commandHeadingDeg - (resetHeadingDeg ?? 0)
        : commandHeadingDeg;
    return robotHeadingDegToCanvasRad(absoluteHeadingDeg);
  }

  private getRobotPlaybackActions(polylineId: string): RobotPlaybackAction[] | null {
    const activeMap = this.getActiveMap();
    const state = this.store.getState();
    const polylineIndex = state.polylines.findIndex((polyline) => polyline.id === polylineId);
    if (!activeMap || !this.robotCodeOverride || polylineIndex < 0) {
      return null;
    }

    const parsedMissions = parseRobotCodeMissions(this.robotCodeOverride);
    const parsedRobotCode =
      parsedMissions.length > 1
        ? parsedMissions[polylineIndex]
        : state.polylines.length === 1
          ? parsedMissions[0] ?? parseRobotCode(this.robotCodeOverride)
          : null;
    if (!parsedRobotCode) {
      return null;
    }
    if (parsedRobotCode.drives.length < 2) {
      return null;
    }

    const originPoint = state.polylines[polylineIndex]?.points[0] ?? null;
    const originMm =
      state.polylineSettings.coordinateMode === "relative" && originPoint
        ? worldToRelativeMm(originPoint, activeMap.spec)
        : null;
    const resetMm = parsedRobotCode.reset ?? { xMm: 0, yMm: 0 };
    const actions: RobotPlaybackAction[] = [];

    for (const action of parsedRobotCode.actions) {
      if (action.kind === "turn") {
        actions.push({
          kind: "turn",
          headingRad: this.robotCommandHeadingDegToCanvasRad(action.turn.headingDeg, parsedRobotCode.reset?.heading ?? 0),
        });
        continue;
      }
      if (action.kind !== "drive") {
        continue;
      }

      const pointMm = originMm
        ? {
            xMm: originMm.xMm + action.command.xMm - resetMm.xMm,
            yMm: originMm.yMm + action.command.yMm - resetMm.yMm,
          }
        : {
            xMm: action.command.xMm,
            yMm: action.command.yMm,
          };
      actions.push({
        kind: "drive",
        point: clampWorldToMap(relativeMmToWorld(pointMm, activeMap.spec), activeMap.spec),
      });
    }

    return actions.filter((action) => action.kind === "drive").length >= 2 ? actions : null;
  }

  private getRobotTurnMarkers(): RobotTurnMarker[] {
    const activeMap = this.getActiveMap();
    const state = this.store.getState();
    if (!activeMap || !this.robotCodeOverride || state.polylines.length === 0) {
      return [];
    }

    const parsedMissions = parseRobotCodeMissions(this.robotCodeOverride);
    const markers: RobotTurnMarker[] = [];
    state.polylines.forEach((polyline, polylineIndex) => {
      const parsedRobotCode = parsedMissions[polylineIndex];
      if (!parsedRobotCode || parsedRobotCode.turns.length === 0 || parsedRobotCode.drives.length < 1) {
        return;
      }

      const originPoint = polyline.points[0] ?? null;
      const originMm =
        state.polylineSettings.coordinateMode === "relative" && originPoint
          ? worldToRelativeMm(originPoint, activeMap.spec)
          : null;
      const resetMm = parsedRobotCode.reset ?? { xMm: 0, yMm: 0 };
      let currentPosition: PointPx | null = null;

      for (const action of parsedRobotCode.actions) {
        if (action.kind === "drive") {
          const pointMm = originMm
            ? {
                xMm: originMm.xMm + action.command.xMm - resetMm.xMm,
                yMm: originMm.yMm + action.command.yMm - resetMm.yMm,
              }
            : {
                xMm: action.command.xMm,
                yMm: action.command.yMm,
              };
          currentPosition = clampWorldToMap(relativeMmToWorld(pointMm, activeMap.spec), activeMap.spec);
          continue;
        }

        if (action.kind === "turn" && currentPosition) {
          markers.push({
            position: { ...currentPosition },
            headingDeg: action.turn.headingDeg,
            headingRad: this.robotCommandHeadingDegToCanvasRad(action.turn.headingDeg, parsedRobotCode.reset?.heading ?? 0),
          });
        }
      }
    });

    return markers;
  }

  private deletePolylinePointAt(point: PointPx): boolean {
    const state = this.store.getState();
    const target = findPolylinePointAt(
      point,
      state.polylines,
      state.draftPolyline,
      POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX / state.view.zoom,
    );
    if (!target) {
      return false;
    }

    if (target.kind === "polyline") {
      this.robotPlayback.stopIfPolylineAffected(target.polylineId);
    }
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const deleted = this.store.deletePolylinePoint(target);
    if (deleted) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
      this.toolbar.setStatus("Polyline point deleted", "info");
      this.canvas.focus();
    }
    return deleted;
  }

  private deletePolylineAt(point: PointPx): boolean {
    const state = this.store.getState();
    const hitPolyline = findPolylineAt(point, state.polylines, POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX / state.view.zoom);
    if (!hitPolyline) {
      return false;
    }
    this.robotPlayback.stopIfPolylineAffected(hitPolyline.id);
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const deleted = this.store.removePolyline(hitPolyline.id);
    if (deleted) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
      this.toolbar.setStatus("Polyline deleted", "info");
      this.canvas.focus();
    }
    return deleted;
  }

  private continuePolylineAt(point: PointPx): boolean {
    const state = this.store.getState();
    if (state.draftPolyline.length > 0) {
      return false;
    }

    const hitPolyline = findPolylineLastPointAt(
      point,
      state.polylines,
      POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX / state.view.zoom,
    );
    if (!hitPolyline) {
      return false;
    }

    this.robotPlayback.stop(true);
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const started = this.store.startContinuingPolyline(hitPolyline.id);
    if (started) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
      this.toolbar.setStatus("Polyline continue mode", "info");
      this.canvas.focus();
    }
    return started;
  }

  private insertPolylinePointAt(point: PointPx): boolean {
    const state = this.store.getState();
    if (state.draftPolyline.length > 0) {
      return false;
    }

    const hitRadiusWorldPx = POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX / state.view.zoom;
    const pointTarget = findPolylinePointAt(point, state.polylines, [], hitRadiusWorldPx);
    if (pointTarget) {
      return false;
    }

    const segmentTarget = findPolylineSegmentAt(point, state.polylines, hitRadiusWorldPx);
    if (!segmentTarget) {
      return false;
    }

    this.robotPlayback.stopIfPolylineAffected(segmentTarget.polyline.id);
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const inserted = this.store.insertPolylinePoint(
      segmentTarget.polyline.id,
      segmentTarget.insertIndex,
      segmentTarget.point,
    );
    if (inserted) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
      this.toolbar.setStatus("Polyline point inserted", "info");
      this.canvas.focus();
    }
    return inserted;
  }

  private movePolylinePoint(target: PolylinePointTarget, point: PointPx): boolean {
    if (target.kind === "polyline") {
      this.robotPlayback.stopIfPolylineAffected(target.polylineId);
    }
    const previousCode = this.captureRobotCodeForRouteEdit();
    this.robotCodeOverride = previousCode;
    const moved = this.store.movePolylinePoint(target, point);
    if (moved) {
      this.syncRobotCodeAfterRouteEdit(previousCode);
    }
    return moved;
  }

  private hasPolylineAt(point: PointPx): boolean {
    const state = this.store.getState();
    return findPolylineAt(point, state.polylines, POLYLINE_DELETE_HIT_RADIUS_SCREEN_PX / state.view.zoom) !== null;
  }

  private setLoadingState(isLoading: boolean, message = "Loading map..."): void {
    this.loadingText.textContent = message;
    this.loadingOverlay.classList.toggle("visible", isLoading);
    this.loadingOverlay.setAttribute("aria-hidden", String(!isLoading));
  }

  private handleResize(): void {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.renderer.resize(width, height, window.devicePixelRatio || 1);
    this.updateViewAfterResize();
    this.scheduleRender();
  }

  private ensureRendererViewportSize(): void {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    const viewport = this.renderer.getViewportSize();
    const widthDiff = Math.abs(viewport.width - width);
    const heightDiff = Math.abs(viewport.height - height);
    if (widthDiff < 1 && heightDiff < 1) {
      return;
    }

    this.renderer.resize(width, height, window.devicePixelRatio || 1);
  }

  private updateViewAfterResize(): void {
    const activeMap = this.getActiveMap();
    if (!activeMap) {
      return;
    }

    const targets = this.computeZoomTargets(activeMap);
    const view = this.store.getState().view;
    if (!targets) {
      return;
    }
    if (view.minZoom === targets.minZoom && view.zoom >= targets.minZoom) {
      return;
    }

    const viewport = this.renderer.getViewportSize();
    const centerScreen = {
      x: viewport.width * 0.5,
      y: viewport.height * 0.5,
    };
    const centerWorld = screenToWorld(centerScreen, view);
    const nextZoom = Math.max(view.zoom, targets.minZoom);
    const nextView: ViewState = {
      zoom: nextZoom,
      minZoom: targets.minZoom,
      panX: centerScreen.x - centerWorld.x * nextZoom,
      panY: centerScreen.y - centerWorld.y * nextZoom,
    };
    this.store.setView(nextView);
  }

  private fitViewToMap(map: LoadedMap): void {
    const targets = this.computeZoomTargets(map);
    if (!targets) {
      return;
    }
    const viewport = this.renderer.getViewportSize();
    const view: ViewState = {
      zoom: targets.initialZoom,
      minZoom: targets.minZoom,
      panX: (viewport.width - map.spec.imgWidthPx * targets.initialZoom) * 0.5,
      panY: (viewport.height - map.spec.imgHeightPx * targets.initialZoom) * 0.5,
    };
    this.store.setView(view);
  }

  private computeFitZoom(map: LoadedMap): number {
    const viewport = this.renderer.getViewportSize();
    const zoom = Math.min(viewport.width / map.spec.imgWidthPx, viewport.height / map.spec.imgHeightPx);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  private computeZoomTargets(map: LoadedMap): { initialZoom: number; minZoom: number } | null {
    const fitZoom = this.computeFitZoom(map);
    if (!Number.isFinite(fitZoom) || fitZoom <= 0) {
      return null;
    }

    return {
      initialZoom: fitZoom * INITIAL_FIT_FACTOR,
      minZoom: fitZoom * MIN_FIT_FACTOR,
    };
  }

  private scheduleRender(): void {
    if (this.renderHandle !== null) {
      return;
    }
    this.renderHandle = window.requestAnimationFrame(() => {
      this.renderHandle = null;
      this.render();
    });
  }

  private render(): void {
    const state = this.store.getState();
    this.renderer.render({
      map: this.getActiveMap(),
      view: state.view,
      pointerWorld: state.pointerWorld,
      polylinePreviewWorld: state.polylinePreviewWorld,
      polylines: state.polylines,
      draftPolyline: state.draftPolyline,
      showPointCoordinates: state.polylineSettings.showPointCoordinates,
      coordinateMode: state.polylineSettings.coordinateMode,
      showPointer: state.toolMode === "polyline",
      robotEnabled: state.robotEnabled,
      robotWidthMm: state.robotWidthMm,
      robotHeightMm: state.robotHeightMm,
      robotPlayback: this.robotPlayback.getFrame(),
      robotInitialHeading: this.getRobotInitialHeadingMarker(),
      robotTurnMarkers: this.getRobotTurnMarkers(),
    });
  }
}

function formatFileTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

function robotHeadingDegToCanvasRad(headingDeg: number): number {
  return ((headingDeg - 90) * Math.PI) / 180;
}

function canvasRadToRobotHeadingDeg(headingRad: number): number {
  return normalizeHeadingDeg((headingRad * 180) / Math.PI + 90);
}

function normalizeHeadingDeg(value: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return ((rounded % 360) + 360) % 360;
}

function normalizeMissionCode(missionTexts: string[]): string | null {
  const nonEmpty = missionTexts.map((text) => text.trim()).filter(Boolean);
  if (nonEmpty.length === 0) {
    return null;
  }
  if (nonEmpty.length === 1) {
    return nonEmpty[0];
  }
  return nonEmpty.map((text, index) => `# Mission ${index + 1}\n${text}`).join("\n\n");
}
