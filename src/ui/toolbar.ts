import type { CoordinateMode, ToolMode } from "../state/types";

export type StatusKind = "info" | "warn" | "error";

export interface ToolbarActions {
  onTogglePolylineMode: () => void;
  onToggleOrthoVh: () => void;
  onToggleRound10mm: () => void;
  onToggleRobot: () => void;
  onRobotSizeChange: (widthMm: number, heightMm: number) => void;
  onTogglePointCoordinates: () => void;
  onToggleCoordinateMode: () => void;
  onUndoPolylinePoint: () => void;
  onFinishPolyline: () => void;
  onClearPolylines: () => void;
  onExportSession: () => void;
  onImportSessionFile: (file: File) => void;
}

export class ToolbarView {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly polylineButton: HTMLButtonElement;
  private readonly orthoButton: HTMLButtonElement;
  private readonly roundButton: HTMLButtonElement;
  private readonly robotButton: HTMLButtonElement;
  private readonly robotWidthInput: HTMLInputElement;
  private readonly robotHeightInput: HTMLInputElement;
  private readonly coordinatesButton: HTMLButtonElement;
  private readonly coordinateModeButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly finishButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly importButton: HTMLButtonElement;
  private readonly importInput: HTMLInputElement;

  constructor(host: HTMLElement, actions: ToolbarActions) {
    this.root = document.createElement("div");
    this.root.className = "toolbar";
    host.appendChild(this.root);

    const tools = document.createElement("div");
    tools.className = "toolbar-tools";
    this.polylineButton = this.createButton("Polyline", "Add polyline points");
    this.orthoButton = this.createButton("Ortho VH", "Lock the next segment to vertical or horizontal");
    this.roundButton = this.createButton("Round 10 mm", "Round point coordinates to 10 mm");
    this.robotButton = this.createButton("Robot", "Show robot footprint around cursor");
    this.robotWidthInput = this.createRobotSizeInput("Robot width (mm)");
    this.robotHeightInput = this.createRobotSizeInput("Robot height (mm)");
    const robotSizeUnit = document.createElement("span");
    robotSizeUnit.className = "toolbar-unit";
    robotSizeUnit.textContent = "mm";
    const robotSizeGroup = document.createElement("span");
    robotSizeGroup.className = "toolbar-robot-size";
    robotSizeGroup.append(this.robotWidthInput, this.robotHeightInput, robotSizeUnit);
    this.coordinatesButton = this.createButton("Hide coordinates", "Show or hide point coordinates on the map");
    this.coordinateModeButton = this.createButton("Absolute", "Switch between absolute and relative point coordinates");
    this.undoButton = this.createButton("Undo", "Remove last polyline point");
    this.finishButton = this.createButton("Finish", "Finish current polyline");
    this.clearButton = this.createButton("Clear", "Clear polylines");
    this.exportButton = this.createButton("Export", "Export JSON session");
    this.importButton = this.createButton("Import", "Import JSON session");
    this.importInput = document.createElement("input");
    this.importInput.type = "file";
    this.importInput.accept = "application/json,.json";
    this.importInput.style.display = "none";
    this.importInput.setAttribute("aria-hidden", "true");
    this.polylineButton.addEventListener("click", () => actions.onTogglePolylineMode());
    this.orthoButton.addEventListener("click", () => actions.onToggleOrthoVh());
    this.roundButton.addEventListener("click", () => actions.onToggleRound10mm());
    this.robotButton.addEventListener("click", () => actions.onToggleRobot());
    const emitRobotSize = (): void => {
      const width = this.readRobotSize(this.robotWidthInput.value, 250);
      const height = this.readRobotSize(this.robotHeightInput.value, 250);
      this.setRobotSize(width, height);
      actions.onRobotSizeChange(width, height);
    };
    this.robotWidthInput.addEventListener("change", emitRobotSize);
    this.robotHeightInput.addEventListener("change", emitRobotSize);
    this.coordinatesButton.addEventListener("click", () => actions.onTogglePointCoordinates());
    this.coordinateModeButton.addEventListener("click", () => actions.onToggleCoordinateMode());
    this.undoButton.addEventListener("click", () => actions.onUndoPolylinePoint());
    this.finishButton.addEventListener("click", () => actions.onFinishPolyline());
    this.clearButton.addEventListener("click", () => actions.onClearPolylines());
    this.exportButton.addEventListener("click", () => actions.onExportSession());
    this.importButton.addEventListener("click", () => {
      this.importInput.value = "";
      this.importInput.click();
    });
    this.importInput.addEventListener("change", () => {
      const file = this.importInput.files?.[0] ?? null;
      if (file) {
        actions.onImportSessionFile(file);
      }
      this.importInput.value = "";
    });
    tools.append(
      this.polylineButton,
      this.orthoButton,
      this.roundButton,
      this.robotButton,
      robotSizeGroup,
      this.coordinatesButton,
      this.coordinateModeButton,
      this.undoButton,
      this.finishButton,
      this.clearButton,
      this.exportButton,
      this.importButton,
      this.importInput,
    );

    this.status = document.createElement("div");
    this.status.className = "toolbar-status";

    const help = document.createElement("div");
    help.className = "toolbar-help";
    const helpButton = document.createElement("button");
    helpButton.type = "button";
    helpButton.className = "toolbar-help-button";
    helpButton.textContent = "?";
    helpButton.setAttribute("aria-label", "Controls help");
    const helpText = document.createElement("div");
    helpText.className = "toolbar-help-popover";
    helpText.textContent =
      "Wheel zoom, drag pan, P polyline, O ortho, R round, Robot shows cursor footprint, double click last point to continue, double click line to add point, RMB point deletes point, RMB line deletes polyline, Export/Import saves JSON session, Absolute/Relative switches point origin, Hide coordinates toggles point labels, Enter finish, Backspace undo, Esc cancel, Space reset";
    help.append(helpButton, helpText);

    this.root.append(tools, this.status, help);
    this.setToolMode("pan");
    this.setPolylineActionsEnabled(false, false, false);
  }

  setToolMode(toolMode: ToolMode): void {
    this.polylineButton.setAttribute("aria-pressed", String(toolMode === "polyline"));
  }

  setPolylineSettings(settings: {
    orthoVh: boolean;
    round10mm: boolean;
    showPointCoordinates: boolean;
    coordinateMode: CoordinateMode;
  }): void {
    this.orthoButton.setAttribute("aria-pressed", String(settings.orthoVh));
    this.roundButton.setAttribute("aria-pressed", String(settings.round10mm));
    this.coordinatesButton.setAttribute("aria-pressed", String(settings.showPointCoordinates));
    this.coordinatesButton.textContent = settings.showPointCoordinates ? "Hide coordinates" : "Show coordinates";
    this.coordinateModeButton.setAttribute("aria-pressed", String(settings.coordinateMode === "relative"));
    this.coordinateModeButton.textContent = settings.coordinateMode === "relative" ? "Relative" : "Absolute";
  }

  setRobotEnabled(enabled: boolean): void {
    this.robotButton.setAttribute("aria-pressed", String(enabled));
  }

  setRobotSize(widthMm: number, heightMm: number): void {
    this.robotWidthInput.value = String(this.readRobotSize(String(widthMm), 250));
    this.robotHeightInput.value = String(this.readRobotSize(String(heightMm), 250));
  }

  setPolylineActionsEnabled(canUndo: boolean, canFinish: boolean, hasAnyPolyline: boolean): void {
    this.undoButton.disabled = !canUndo;
    this.finishButton.disabled = !canFinish;
    this.clearButton.disabled = !canFinish && !hasAnyPolyline;
  }

  setStatus(message: string, kind: StatusKind = "info"): void {
    this.status.textContent = "";
    this.status.dataset.kind = kind;
    if (kind === "error") {
      console.error(`[Biathlon xAct] ${message}`);
      return;
    }
    if (kind === "warn") {
      console.warn(`[Biathlon xAct] ${message}`);
      return;
    }
    console.info(`[Biathlon xAct] ${message}`);
  }

  private createButton(label: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.textContent = label;
    button.title = title;
    return button;
  }

  private createRobotSizeInput(title: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = "250";
    input.className = "toolbar-robot-size-input";
    input.title = title;
    input.setAttribute("aria-label", title);
    return input;
  }

  private readRobotSize(value: string, fallback: number): number {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.round(parsed);
  }
}
