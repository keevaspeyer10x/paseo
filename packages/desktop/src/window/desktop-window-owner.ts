import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface OwnedDesktopWindow<TAgentTarget> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  sendAgent(target: TAgentTarget): void;
}

interface DesktopWindowOwnerPort<TAgentTarget> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TAgentTarget>>;
  windows(): OwnedDesktopWindow<TAgentTarget>[];
  focusedWindow(): OwnedDesktopWindow<TAgentTarget> | null;
  agentRoute(target: TAgentTarget): string;
  deliverAgent(webContentsId: number, target: TAgentTarget): TAgentTarget | null;
  sameAgentTarget?(a: TAgentTarget, b: TAgentTarget): boolean;
  /**
   * Called when the delivery watchdog gives up on a window so the delivery
   * layer can discard any queued target and stale readiness for it.
   */
  expireAgentDelivery?(webContentsId: number): void;
  /** Called when a watchdog-triggered fallback window fails to open. */
  reportAgentDeliveryError?(error: unknown, target: TAgentTarget): void;
}

export interface DesktopWindowOwnerOptions {
  /**
   * How long an agent deep-link delivery may go unacknowledged before a
   * dedicated window is opened at the agent route as a fallback. Defaults to
   * 4000ms.
   */
  agentDeliveryFallbackTimeoutMs?: number;
}

export interface DesktopWindowOwner<TAgentTarget> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openAdditional(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openOrFocusAgent(target: TAgentTarget): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  takePendingProject(webContentsId: number): string | null;
  /**
   * Renderer confirmation that an agent navigation was handled. Disarms the
   * delivery watchdog so no fallback window is spawned.
   */
  acknowledgeAgentDelivery(webContentsId: number, target: TAgentTarget): void;
}

export function createDesktopWindowOwner<TAgentTarget>(
  port: DesktopWindowOwnerPort<TAgentTarget>,
  options: DesktopWindowOwnerOptions = {},
): DesktopWindowOwner<TAgentTarget> {
  const pendingProjects = new PendingOpenProjectStore();
  const fallbackTimeoutMs = options.agentDeliveryFallbackTimeoutMs ?? 4000;
  const sameTarget =
    port.sameAgentTarget ??
    ((a: TAgentTarget, b: TAgentTarget) => a === b || JSON.stringify(a) === JSON.stringify(b));
  const deliveryGuards = new Map<number, { target: TAgentTarget; timer: NodeJS.Timeout }>();
  let agentWindowCreation: Promise<void> | null = null;

  const open = async (input: {
    initialRoute: string | null;
    pendingProjectPath: string | null;
    restoreWindowState: boolean;
  }): Promise<void> => {
    await port.create({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: (webContentsId) => pendingProjects.set(webContentsId, input.pendingProjectPath),
      onClosed: (webContentsId) => {
        pendingProjects.delete(webContentsId);
        cancelDeliveryGuard(webContentsId);
      },
    });
  };

  const cancelDeliveryGuard = (webContentsId: number): void => {
    const guard = deliveryGuards.get(webContentsId);
    if (!guard) return;
    clearTimeout(guard.timer);
    deliveryGuards.delete(webContentsId);
  };

  // sendAgent is fire-and-forget: a stale "ready" flag or a dead renderer
  // listener drops the link silently. Arm a watchdog — if the renderer does not
  // acknowledge the navigation, expire any queued delivery for the window and
  // open a dedicated window at the agent route so the link always lands.
  const armDeliveryGuard = (webContentsId: number, target: TAgentTarget): void => {
    cancelDeliveryGuard(webContentsId);
    const timer = setTimeout(() => {
      deliveryGuards.delete(webContentsId);
      port.expireAgentDelivery?.(webContentsId);
      void owner
        .openAdditional({ initialRoute: port.agentRoute(target) })
        .catch((error) => port.reportAgentDeliveryError?.(error, target));
    }, fallbackTimeoutMs);
    deliveryGuards.set(webContentsId, { target, timer });
  };

  // A window created for this target already loads the agent route, so its
  // delivery is guaranteed — every other delivery path needs the watchdog.
  const deliverToWindow = async (target: TAgentTarget): Promise<void> => {
    const windows = port.windows();
    const window =
      port.focusedWindow() ?? windows.find((candidate) => candidate.isVisible()) ?? windows[0];
    if (!window || window.isDestroyed()) {
      if (!agentWindowCreation) {
        agentWindowCreation = owner
          .openPrimary({ initialRoute: port.agentRoute(target) })
          .finally(() => {
            agentWindowCreation = null;
          });
        await agentWindowCreation;
        return;
      }
      await agentWindowCreation;
      await deliverToWindow(target);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const deliverable = port.deliverAgent(window.webContentsId, target);
    if (deliverable) window.sendAgent(deliverable);
    armDeliveryGuard(window.webContentsId, target);
  };

  const owner: DesktopWindowOwner<TAgentTarget> = {
    openPrimary: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
      }),
    openAdditional: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocusAgent(target) {
      await deliverToWindow(target);
    },
    acknowledgeAgentDelivery(webContentsId, target) {
      const guard = deliveryGuards.get(webContentsId);
      if (guard && sameTarget(guard.target, target)) cancelDeliveryGuard(webContentsId);
    },
    async restoreWhenActivated() {
      if (port.windows().length === 0) await owner.openPrimary();
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
