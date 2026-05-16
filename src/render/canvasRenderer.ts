import { mmPerPxX, mmPerPxY, worldToCoordinateModeMm, worldToScreen } from "../geometry/measure";
import type { LoadedMap } from "../io/mapConfig";
import type { CoordinateMode, MapSpec, PointPx, Polyline, RobotPlaybackFrame, ViewState } from "../state/types";

export interface RenderScene {
  map: LoadedMap | null;
  view: ViewState;
  pointerWorld: PointPx | null;
  polylinePreviewWorld: PointPx | null;
  polylines: Polyline[];
  draftPolyline: PointPx[];
  showPointCoordinates: boolean;
  coordinateMode: CoordinateMode;
  showPointer: boolean;
  robotEnabled: boolean;
  robotWidthMm: number;
  robotHeightMm: number;
  robotPlayback: RobotPlaybackFrame | null;
}

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2D canvas context is unavailable");
    }
    this.ctx = context;
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.dpr = Math.max(1, dpr);

    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
  }

  getViewportSize(): { width: number; height: number } {
    return {
      width: this.cssWidth,
      height: this.cssHeight,
    };
  }

  render(scene: RenderScene): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.drawBackground();

    if (!scene.map) {
      this.drawCenteredMessage("No valid map loaded");
      return;
    }

    const { map, view } = scene;
    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(map.image, 0, 0, map.spec.imgWidthPx, map.spec.imgHeightPx);
    this.drawPolylines(
      scene.polylines,
      scene.draftPolyline,
      scene.polylinePreviewWorld,
      map,
      view.zoom,
      scene.showPointCoordinates,
      scene.coordinateMode,
    );
    this.drawMapBorder(view.zoom, map.spec.imgWidthPx, map.spec.imgHeightPx);
    this.drawRobotOverlay(
      scene.pointerWorld,
      map.spec,
      view.zoom,
      scene.robotEnabled,
      scene.robotWidthMm,
      scene.robotHeightMm,
    );
    this.drawPlaybackRobot(scene.robotPlayback, map.spec, view.zoom, scene.robotWidthMm, scene.robotHeightMm);
    ctx.restore();

    if (scene.showPointer && scene.pointerWorld) {
      this.drawPointerCrosshair(scene.pointerWorld, view);
      if (this.isInsideMap(scene.pointerWorld, map)) {
        const originPoint = scene.coordinateMode === "relative" ? scene.draftPolyline[0] ?? null : null;
        this.drawPointerBadge(scene.pointerWorld, map, view, scene.coordinateMode, originPoint);
      }
    }
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  private isInsideMap(point: PointPx, map: LoadedMap): boolean {
    return point.x >= 0 && point.y >= 0 && point.x <= map.spec.imgWidthPx && point.y <= map.spec.imgHeightPx;
  }

  private drawPolylines(
    polylines: Polyline[],
    draftPolyline: PointPx[],
    pointerWorld: PointPx | null,
    map: LoadedMap,
    zoom: number,
    showPointCoordinates: boolean,
    coordinateMode: CoordinateMode,
  ): void {
    for (const polyline of polylines) {
      this.drawPolyline(polyline.points, map, zoom, false, showPointCoordinates, coordinateMode);
    }

    if (draftPolyline.length > 0) {
      this.drawPolyline(draftPolyline, map, zoom, true, showPointCoordinates, coordinateMode);
      if (pointerWorld) {
        this.drawDraftPreview(draftPolyline[draftPolyline.length - 1], pointerWorld, zoom);
      }
    }
  }

  private drawPolyline(
    points: PointPx[],
    map: LoadedMap,
    zoom: number,
    isDraft: boolean,
    showPointCoordinates: boolean,
    coordinateMode: CoordinateMode,
  ): void {
    if (points.length === 0) {
      return;
    }

    const ctx = this.ctx;
    const stroke = isDraft ? "#dc2626" : "#0284c7";
    const fill = isDraft ? "#fee2e2" : "#e0f2fe";
    const radius = 5 / zoom;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.5 / zoom;

    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 / zoom;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (showPointCoordinates) {
      const originPoint = coordinateMode === "relative" ? points[0] : null;
      points.forEach((point, index) => {
        this.drawPointCoordinateLabel(point, map, zoom, isDraft, index, coordinateMode, originPoint);
      });
    }
    ctx.restore();
  }

  private drawPointCoordinateLabel(
    point: PointPx,
    map: LoadedMap,
    zoom: number,
    isDraft: boolean,
    index: number,
    coordinateMode: CoordinateMode,
    originPoint: PointPx | null,
  ): void {
    const ctx = this.ctx;
    const coordinate = worldToCoordinateModeMm(point, map.spec, coordinateMode, originPoint);
    const text = `X ${Math.round(coordinate.xMm)} Y ${Math.round(coordinate.yMm)}`;
    const paddingX = 5 / zoom;
    const paddingY = 3 / zoom;
    const labelOffsetX = 8 / zoom;
    const labelOffsetY = (index % 2 === 0 ? -24 : 12) / zoom;

    ctx.save();
    ctx.font = `${12 / zoom}px 'Segoe UI', sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(text);
    const width = metrics.width + paddingX * 2;
    const height = 20 / zoom;
    const x = point.x + labelOffsetX;
    const y = point.y + labelOffsetY;

    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.strokeStyle = isDraft ? "rgba(220, 38, 38, 0.75)" : "rgba(2, 132, 199, 0.75)";
    ctx.lineWidth = 1 / zoom;
    this.addRoundedRectPath(x, y, width, height, 5 / zoom);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0f172a";
    ctx.fillText(text, x + paddingX, y + height * 0.5 + paddingY * 0.1);
    ctx.restore();
  }

  private drawDraftPreview(from: PointPx, to: PointPx, zoom: number): void {
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = "rgba(220, 38, 38, 0.55)";
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([8 / zoom, 6 / zoom]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawMapBorder(zoom: number, width: number, height: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(15, 23, 42, 0.75)";
    ctx.lineWidth = 1.25 / zoom;
    ctx.strokeRect(0, 0, width, height);
  }

  private drawRobotOverlay(
    pointerWorld: PointPx | null,
    map: MapSpec,
    zoom: number,
    enabled: boolean,
    robotWidthMm: number,
    robotHeightMm: number,
  ): void {
    if (!enabled || !pointerWorld) {
      return;
    }

    const xMmPerPx = mmPerPxX(map);
    const yMmPerPx = mmPerPxY(map);
    if (!Number.isFinite(xMmPerPx) || !Number.isFinite(yMmPerPx) || xMmPerPx <= 0 || yMmPerPx <= 0) {
      return;
    }
    if (!Number.isFinite(robotWidthMm) || !Number.isFinite(robotHeightMm) || robotWidthMm <= 0 || robotHeightMm <= 0) {
      return;
    }

    const widthPx = robotWidthMm / xMmPerPx;
    const heightPx = robotHeightMm / yMmPerPx;
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
      return;
    }

    const left = pointerWorld.x - widthPx * 0.5;
    const top = pointerWorld.y - heightPx * 0.5;
    const ctx = this.ctx;

    ctx.save();
    ctx.setLineDash([8 / zoom, 6 / zoom]);
    ctx.fillStyle = "rgba(250, 204, 21, 0.18)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
    ctx.lineWidth = 1.4 / zoom;
    ctx.fillRect(left, top, widthPx, heightPx);
    ctx.strokeRect(left, top, widthPx, heightPx);

    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(202, 138, 4, 0.95)";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(left, top, widthPx, heightPx);
    ctx.fillStyle = "rgba(202, 138, 4, 0.95)";
    ctx.beginPath();
    ctx.arc(pointerWorld.x, pointerWorld.y, 3.5 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPlaybackRobot(
    playback: RobotPlaybackFrame | null,
    map: MapSpec,
    zoom: number,
    robotWidthMm: number,
    robotHeightMm: number,
  ): void {
    if (!playback) {
      return;
    }

    const xMmPerPx = mmPerPxX(map);
    const yMmPerPx = mmPerPxY(map);
    if (!Number.isFinite(xMmPerPx) || !Number.isFinite(yMmPerPx) || xMmPerPx <= 0 || yMmPerPx <= 0) {
      return;
    }

    const widthPx = robotWidthMm / xMmPerPx;
    const heightPx = robotHeightMm / yMmPerPx;
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
      return;
    }

    const ctx = this.ctx;
    const noseSize = Math.min(widthPx, heightPx) * 0.18;
    ctx.save();
    ctx.translate(playback.position.x, playback.position.y);
    ctx.rotate(playback.headingRad);

    ctx.fillStyle = "rgba(250, 204, 21, 0.24)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([8 / zoom, 6 / zoom]);
    ctx.fillRect(-widthPx * 0.5, -heightPx * 0.5, widthPx, heightPx);
    ctx.strokeRect(-widthPx * 0.5, -heightPx * 0.5, widthPx, heightPx);

    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(220, 38, 38, 0.95)";
    ctx.fillStyle = "rgba(220, 38, 38, 0.95)";
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(widthPx * 0.42, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(widthPx * 0.5, 0);
    ctx.lineTo(widthPx * 0.5 - noseSize, -noseSize * 0.62);
    ctx.lineTo(widthPx * 0.5 - noseSize, noseSize * 0.62);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(202, 138, 4, 0.95)";
    ctx.beginPath();
    ctx.arc(0, 0, 3.5 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPointerCrosshair(pointerWorld: PointPx, view: ViewState): void {
    const ctx = this.ctx;
    const screen = worldToScreen(pointerWorld, view);

    ctx.save();
    ctx.strokeStyle = "rgba(220, 38, 38, 0.92)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(screen.x - 9, screen.y);
    ctx.lineTo(screen.x + 9, screen.y);
    ctx.moveTo(screen.x, screen.y - 9);
    ctx.lineTo(screen.x, screen.y + 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawPointerBadge(
    pointerWorld: PointPx,
    map: LoadedMap,
    view: ViewState,
    coordinateMode: CoordinateMode,
    originPoint: PointPx | null,
  ): void {
    const ctx = this.ctx;
    const screen = worldToScreen(pointerWorld, view);
    const coordinate = worldToCoordinateModeMm(pointerWorld, map.spec, coordinateMode, originPoint);
    const text = `X ${Math.round(coordinate.xMm)}  Y ${Math.round(coordinate.yMm)}`;

    ctx.save();
    ctx.font = "12px 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(text);
    const width = Math.ceil(metrics.width) + 16;
    const height = 24;
    const x = Math.min(this.cssWidth - width - 8, screen.x + 12);
    const y = Math.max(8, Math.min(this.cssHeight - height - 8, screen.y - height - 8));

    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.strokeStyle = "rgba(100, 116, 139, 0.85)";
    ctx.lineWidth = 1;
    this.addRoundedRectPath(x, y, width, height, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0f172a";
    ctx.fillText(text, x + 8, y + height * 0.5);
    ctx.restore();
  }

  private addRoundedRectPath(x: number, y: number, width: number, height: number, radius: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, width, height, radius);
      return;
    }

    const r = Math.max(0, Math.min(radius, Math.min(width, height) * 0.5));
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private drawCenteredMessage(text: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#334155";
    ctx.font = "14px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.cssWidth / 2, this.cssHeight / 2);
    ctx.restore();
  }
}
