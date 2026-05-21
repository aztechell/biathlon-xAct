import { serializeRobotCodeMissions } from "../io/robotCode";
import type { LoadedMap } from "../io/mapConfig";
import type { AnimationSpeedMultiplier, CoordinateMode, PointPx, Polyline, ToolMode } from "../state/types";

const MAX_DRIVE_SPEED = 100;
const DEFAULT_DRIVE_SPEED = 90;
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
  robotCodeOverride: string | null;
}

export interface PolylinePanelActions {
  onSpeedChange: (speed: number) => void;
  onAnimationSpeedChange: (multiplier: AnimationSpeedMultiplier) => void;
  onPlayPolyline: (polylineId: string, code: string) => void;
  onApplyRobotCode: (code: string) => void;
  onRobotCodeChange: (code: string) => void;
}

export class PolylinePanelView {
  private readonly root: HTMLDivElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly playButtonsHost: HTMLDivElement;
  private readonly speedInput: HTMLInputElement;
  private readonly animationSpeedButtons: HTMLButtonElement[] = [];
  private readonly applyButton: HTMLButtonElement;
  private readonly codeEditor: HTMLTextAreaElement;
  private readonly snippetBar: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly actions: PolylinePanelActions;
  private isOpen = false;
  private currentSpeed = DEFAULT_DRIVE_SPEED;
  private dragStartX = 0;
  private dragStartWidth = 0;
  private activePointerId: number | null = null;
  private isEditorDirty = false;

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
    this.title.setAttribute("aria-hidden", "true");

    this.playButtonsHost = document.createElement("div");
    this.playButtonsHost.className = "polyline-play-buttons";

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
    this.applyButton = document.createElement("button");
    this.applyButton.type = "button";
    this.applyButton.className = "polyline-apply-button";
    this.applyButton.textContent = "Apply";
    this.applyButton.title = "Apply robot code to map";
    this.applyButton.addEventListener("click", () => {
      this.applyCurrentCode();
    });
    this.codeEditor = document.createElement("textarea");
    this.codeEditor.className = "polyline-code-editor";
    this.codeEditor.spellcheck = false;
    this.codeEditor.wrap = "off";
    this.codeEditor.setAttribute("aria-label", "Robot code editor");
    this.codeEditor.addEventListener("input", () => {
      this.isEditorDirty = true;
      this.actions.onRobotCodeChange(this.codeEditor.value);
    });
    this.codeEditor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        this.applyCurrentCode();
      }
    });
    this.snippetBar = document.createElement("div");
    this.snippetBar.className = "polyline-snippet-bar";
    this.snippetBar.append(
      this.createSnippetButton("Drive", () => `robot.drive_to_point_action(0, 0, ${this.currentSpeed}),`),
      this.createSnippetButton("Turn", () => "robot.turn_to_heading_action(0),"),
      this.createSnippetButton("Reset", () => "robot.reset_odometry_action(0, 0, 0),"),
    );

    const header = document.createElement("div");
    header.className = "polyline-panel-header";
    header.append(
      this.toggleButton,
      this.playButtonsHost,
      this.title,
      animationSpeedControl,
      speedControl,
      this.applyButton,
    );

    this.body.append(this.codeEditor, this.snippetBar);
    this.root.append(this.resizeHandle, header, this.body);
    host.appendChild(this.root);
    this.update({
      map: null,
      toolMode: "polyline",
      polylines: [],
      draftPolyline: [],
      coordinateMode: "relative",
      driveSpeed: this.currentSpeed,
      animationSpeedMultiplier: 2,
      playingPolylineId: null,
      robotCodeOverride: null,
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
    const shouldShow = state.map !== null || sections.length > 0;
    this.root.classList.toggle("visible", shouldShow);

    if (!shouldShow) {
      return;
    }

    this.updatePlayButtons(state);
    if (!state.map) {
      if (document.activeElement !== this.codeEditor) {
        this.codeEditor.value = "";
        this.codeEditor.placeholder = "No map";
      }
      return;
    }
    const map = state.map;
    const isEditorFocused = document.activeElement === this.codeEditor;
    const code =
      state.robotCodeOverride ??
      (this.isEditorDirty && isEditorFocused ? this.codeEditor.value : null) ??
      serializeRobotCodeMissions(
        sections.map((section, index) => ({
          title: section.isDraft ? "Mission draft" : `Mission ${index + 1}`,
          points: section.points,
        })),
        map.spec,
        state.coordinateMode,
        normalizeSpeed(state.driveSpeed),
      );
    if (!isEditorFocused) {
      this.codeEditor.value = code;
      this.isEditorDirty = false;
    }
  }

  getCurrentCode(): string {
    return this.codeEditor.value;
  }

  private applyCurrentCode(): void {
    const code = this.codeEditor.value;
    this.actions.onApplyRobotCode(code);
    this.isEditorDirty = false;
    this.codeEditor.value = code;
  }

  private createSnippetButton(label: string, createSnippet: () => string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "polyline-snippet-button";
    button.textContent = label;
    button.addEventListener("click", () => {
      this.insertSnippet(createSnippet());
    });
    return button;
  }

  private insertSnippet(snippet: string): void {
    const value = this.codeEditor.value;
    const start = this.codeEditor.selectionStart ?? value.length;
    const end = this.codeEditor.selectionEnd ?? start;
    const prefix = start > 0 && !value.slice(0, start).endsWith("\n") ? "\n" : "";
    const suffix = end < value.length && !value.slice(end).startsWith("\n") ? "\n" : "";
    const nextValue = `${value.slice(0, start)}${prefix}${snippet}${suffix}${value.slice(end)}`;
    const nextCursor = start + prefix.length + snippet.length;
    this.codeEditor.value = nextValue;
    this.isEditorDirty = true;
    this.actions.onRobotCodeChange(nextValue);
    this.codeEditor.focus();
    this.codeEditor.setSelectionRange(nextCursor, nextCursor);
  }

  private updatePlayButtons(state: PolylinePanelState): void {
    this.root.classList.toggle("has-playback-control", state.polylines.length > 0);
    this.playButtonsHost.replaceChildren(
      ...state.polylines.map((polyline, index) => {
        const isPlaying = state.playingPolylineId === polyline.id;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "polyline-play-button";
        button.classList.toggle("playing", isPlaying);
        button.title = isPlaying ? `Stop mission ${index + 1}` : `Play mission ${index + 1}`;
        button.setAttribute("aria-label", isPlaying ? `Stop mission ${index + 1}` : `Play mission ${index + 1}`);
        const playIcon = document.createElement("span");
        playIcon.className = "polyline-play-icon";
        playIcon.setAttribute("aria-hidden", "true");
        button.appendChild(playIcon);
        if (state.polylines.length > 1) {
          const indexBadge = document.createElement("span");
          indexBadge.className = "polyline-play-index";
          indexBadge.textContent = String(index + 1);
          button.appendChild(indexBadge);
        }
        button.addEventListener("click", () => {
          this.actions.onPlayPolyline(polyline.id, this.codeEditor.value);
        });
        return button;
      }),
    );
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
