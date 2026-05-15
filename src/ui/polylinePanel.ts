import { worldToCoordinateModeMm } from "../geometry/measure";
import type { LoadedMap } from "../io/mapConfig";
import type { AnimationSpeedMultiplier, CoordinateMode, PointPx, Polyline, ToolMode } from "../state/types";

const MAX_DRIVE_SPEED = 100;
const ANIMATION_SPEED_MULTIPLIERS = [2, 4, 8, 16] as const;

export interface PolylinePanelState {
  map: LoadedMap | null;
  toolMode: ToolMode;
  polylines: Polyline[];
  draftPolyline: PointPx[];
  coordinateMode: CoordinateMode;
  driveSpeed: number;
  animationSpeedMultiplier: AnimationSpeedMultiplier;
  playingPolylineId: string | null;
}

export interface PolylinePanelActions {
  onSpeedChange: (speed: number) => void;
  onAnimationSpeedChange: (multiplier: AnimationSpeedMultiplier) => void;
  onPlayPolyline: (polylineId: string) => void;
}

export class PolylinePanelView {
  private readonly root: HTMLDivElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly speedInput: HTMLInputElement;
  private readonly animationSpeedButtons: HTMLButtonElement[] = [];
  private readonly body: HTMLDivElement;
  private readonly actions: PolylinePanelActions;
  private isOpen = false;
  private currentSpeed = 100;
  private dragStartX = 0;
  private dragStartWidth = 0;
  private activePointerId: number | null = null;

  constructor(host: HTMLElement, actions: PolylinePanelActions) {
    this.actions = actions;
    this.root = document.createElement("div");
    this.root.className = "polyline-panel collapsed";
    this.root.style.setProperty("--panel-width", "450px");

    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "polyline-panel-toggle";
    this.toggleButton.setAttribute("aria-label", "Show coordinates panel");
    this.toggleButton.textContent = "<";
    this.toggleButton.addEventListener("click", () => {
      this.setOpen(!this.isOpen);
    });

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "polyline-panel-resize";
    this.resizeHandle.addEventListener("pointerdown", this.onResizeStart);

    this.title = document.createElement("div");
    this.title.className = "polyline-panel-title";

    const speedControl = document.createElement("label");
    speedControl.className = "polyline-panel-speed";
    const speedLabel = document.createElement("span");
    speedLabel.textContent = "speed";
    this.speedInput = document.createElement("input");
    this.speedInput.type = "number";
    this.speedInput.min = "0";
    this.speedInput.max = String(MAX_DRIVE_SPEED);
    this.speedInput.step = "1";
    this.speedInput.value = String(this.currentSpeed);
    this.speedInput.setAttribute("aria-label", "Drive speed");
    this.speedInput.addEventListener("input", this.onSpeedInput);
    this.speedInput.addEventListener("blur", this.onSpeedBlur);
    speedControl.append(speedLabel, this.speedInput);

    const animationSpeedControl = document.createElement("div");
    animationSpeedControl.className = "polyline-panel-animation-speed";
    const animationSpeedLabel = document.createElement("span");
    animationSpeedLabel.textContent = "anim";
    animationSpeedControl.appendChild(animationSpeedLabel);
    for (const multiplier of ANIMATION_SPEED_MULTIPLIERS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `x${multiplier}`;
      button.title = `Animation speed x${multiplier}`;
      button.setAttribute("aria-label", `Animation speed x${multiplier}`);
      button.addEventListener("click", () => {
        this.actions.onAnimationSpeedChange(multiplier);
      });
      this.animationSpeedButtons.push(button);
      animationSpeedControl.appendChild(button);
    }

    this.body = document.createElement("div");
    this.body.className = "polyline-panel-body";

    const header = document.createElement("div");
    header.className = "polyline-panel-header";
    header.append(this.toggleButton, this.title, animationSpeedControl, speedControl);

    this.root.append(this.resizeHandle, header, this.body);
    host.appendChild(this.root);
    this.update({
      map: null,
      toolMode: "pan",
      polylines: [],
      draftPolyline: [],
      coordinateMode: "absolute",
      driveSpeed: this.currentSpeed,
      animationSpeedMultiplier: 2,
      playingPolylineId: null,
    });
  }

  private setOpen(isOpen: boolean): void {
    this.isOpen = isOpen;
    this.root.classList.toggle("collapsed", !isOpen);
    this.toggleButton.textContent = isOpen ? ">" : "<";
    this.toggleButton.setAttribute("aria-label", isOpen ? "Hide coordinates panel" : "Show coordinates panel");
  }

  update(state: PolylinePanelState): void {
    this.currentSpeed = normalizeSpeed(state.driveSpeed);
    if (document.activeElement !== this.speedInput) {
      this.speedInput.value = String(this.currentSpeed);
    }
    this.setAnimationSpeedMultiplier(state.animationSpeedMultiplier);

    const sections = [
      ...state.polylines.map((polyline, index) => ({
        id: polyline.id,
        isDraft: false,
        title: `Polyline ${index + 1}, ${polyline.points.length} point${polyline.points.length === 1 ? "" : "s"}`,
        points: polyline.points,
      })),
      ...(state.draftPolyline.length > 0
        ? [
            {
              id: null,
              isDraft: true,
              title: `Polyline draft, ${state.draftPolyline.length} point${state.draftPolyline.length === 1 ? "" : "s"}`,
              points: state.draftPolyline,
            },
          ]
        : []),
    ];
    const shouldShow = sections.length > 0;
    this.root.classList.toggle("visible", shouldShow);

    if (!shouldShow) {
      return;
    }

    this.title.textContent = `${sections.length} polyline${sections.length === 1 ? "" : "s"}`;

    this.body.replaceChildren();
    if (!state.map) {
      this.body.textContent = "No map";
      return;
    }
    const map = state.map;

    for (const section of sections) {
      const sectionElement = document.createElement("section");
      sectionElement.className = "polyline-code-section";

      const sectionHeader = document.createElement("div");
      sectionHeader.className = "polyline-code-header";

      if (!section.isDraft && section.id) {
        const isPlaying = state.playingPolylineId === section.id;
        const playButton = document.createElement("button");
        playButton.type = "button";
        playButton.className = "polyline-play-button";
        playButton.classList.toggle("playing", isPlaying);
        playButton.title = isPlaying ? "Stop robot playback" : "Play robot movement";
        playButton.setAttribute("aria-label", isPlaying ? "Stop robot playback" : `Play ${section.title}`);
        const playIcon = document.createElement("span");
        playIcon.className = "polyline-play-icon";
        playIcon.setAttribute("aria-hidden", "true");
        playButton.appendChild(playIcon);
        playButton.addEventListener("click", () => {
          if (section.id) {
            this.actions.onPlayPolyline(section.id);
          }
        });
        sectionHeader.appendChild(playButton);
      }

      const sectionTitle = document.createElement("div");
      sectionTitle.className = "polyline-code-title";
      sectionTitle.textContent = section.title;
      sectionHeader.appendChild(sectionTitle);

      const code = document.createElement("pre");
      code.className = "polyline-point-code";
      const originPoint = state.coordinateMode === "relative" ? section.points[0] : null;
      const speed = normalizeSpeed(state.driveSpeed);
      const lines = section.points.map((point) => {
        const coordinate = worldToCoordinateModeMm(point, map.spec, state.coordinateMode, originPoint);
        return `robot.drive_to_point_action(_X = ${Math.round(coordinate.xMm)}, _Y = ${Math.round(coordinate.yMm)}, speed = ${speed}),`;
      });
      code.textContent = lines.join("\n");

      sectionElement.append(sectionHeader, code);
      this.body.appendChild(sectionElement);
    }
  }

  private readonly onResizeStart = (event: PointerEvent): void => {
    event.preventDefault();
    this.activePointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.root.getBoundingClientRect().width;
    this.resizeHandle.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", this.onResizeMove);
    window.addEventListener("pointerup", this.onResizeEnd);
    window.addEventListener("pointercancel", this.onResizeEnd);
  };

  private readonly onResizeMove = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) {
      return;
    }
    const nextWidth = Math.max(280, Math.min(window.innerWidth - 48, this.dragStartWidth + this.dragStartX - event.clientX));
    this.root.style.setProperty("--panel-width", `${Math.round(nextWidth)}px`);
  };

  private readonly onResizeEnd = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) {
      return;
    }
    this.activePointerId = null;
    window.removeEventListener("pointermove", this.onResizeMove);
    window.removeEventListener("pointerup", this.onResizeEnd);
    window.removeEventListener("pointercancel", this.onResizeEnd);
  };

  private readonly onSpeedInput = (): void => {
    const parsedSpeed = Number(this.speedInput.value);
    if (!Number.isFinite(parsedSpeed)) {
      return;
    }
    const speed = normalizeSpeed(parsedSpeed);
    this.speedInput.value = String(speed);
    this.actions.onSpeedChange(speed);
  };

  private readonly onSpeedBlur = (): void => {
    if (this.speedInput.value.trim() === "") {
      this.speedInput.value = String(this.currentSpeed);
    }
  };

  private setAnimationSpeedMultiplier(multiplier: AnimationSpeedMultiplier): void {
    for (const button of this.animationSpeedButtons) {
      const isActive = button.textContent === `x${multiplier}`;
      button.setAttribute("aria-pressed", String(isActive));
    }
  }
}

function normalizeSpeed(speed: number): number {
  return Math.max(0, Math.min(MAX_DRIVE_SPEED, Math.round(speed)));
}
