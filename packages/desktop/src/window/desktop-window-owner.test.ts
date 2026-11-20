import { describe, expect, it, vi } from "vitest";
import {
  createDesktopWindowOwner,
  type DesktopWindowOwnerOptions,
  type OwnedDesktopWindow,
} from "./desktop-window-owner.js";

interface Target {
  id: string;
}

interface HarnessOptions extends DesktopWindowOwnerOptions {
  /** Deliver nothing immediately — every target is left queued. */
  queueDeliveries?: boolean;
  /** Hold window creation open until releaseCreate() is called. */
  deferCreate?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const windows: OwnedDesktopWindow<Target>[] = [];
  const launches: Array<{ initialRoute: string | null; restoreWindowState: boolean }> = [];
  const sent: Target[] = [];
  const expired: number[] = [];
  let nextId = 1;
  let focused: OwnedDesktopWindow<Target> | null = null;
  let closeWindow = (_id: number) => {};
  let releaseCreate: (() => void) | null = null;
  const createGate = options.deferCreate
    ? new Promise<void>((resolve) => {
        releaseCreate = resolve;
      })
    : null;
  const owner = createDesktopWindowOwner<Target>(
    {
      async create(input) {
        launches.push({
          initialRoute: input.initialRoute,
          restoreWindowState: input.restoreWindowState,
        });
        if (createGate) await createGate;
        const id = nextId++;
        closeWindow = input.onClosed;
        const window: OwnedDesktopWindow<Target> = {
          webContentsId: id,
          isDestroyed: () => false,
          isVisible: () => true,
          isMinimized: () => false,
          restore: () => {},
          show: () => {},
          focus: () => {},
          sendAgent: (target) => sent.push(target),
        };
        windows.push(window);
        input.onCreated(id);
        return window;
      },
      windows: () => windows,
      focusedWindow: () => focused,
      agentRoute: (target) => `/agent/${target.id}`,
      deliverAgent: (_id, target) => (options.queueDeliveries ? null : target),
      expireAgentDelivery: (webContentsId) => expired.push(webContentsId),
    },
    options,
  );
  return {
    owner,
    launches,
    sent,
    expired,
    windows,
    setFocused: (window: OwnedDesktopWindow<Target>) => {
      focused = window;
    },
    releaseCreate: () => releaseCreate?.(),
    close: (id: number) => closeWindow(id),
  };
}

describe("desktop window owner", () => {
  it("restores only primary launches and routes pending projects per window", async () => {
    const h = harness();
    await h.owner.openPrimary({ pendingProjectPath: " /project/a " });
    await h.owner.openAdditional({ pendingProjectPath: "/project/b" });
    expect(h.launches).toEqual([
      { initialRoute: null, restoreWindowState: true },
      { initialRoute: null, restoreWindowState: false },
    ]);
    expect(h.owner.takePendingProject(1)).toBe("/project/a");
    expect(h.owner.takePendingProject(2)).toBe("/project/b");
  });

  it("focuses an existing window and delivers agent routing through its inbox", async () => {
    const h = harness();
    await h.owner.openPrimary();
    h.setFocused(h.windows[0]);
    await h.owner.openOrFocusAgent({ id: "agent-7" });
    expect(h.launches).toHaveLength(1);
    expect(h.sent).toEqual([{ id: "agent-7" }]);
  });

  it("removes pending routing state when a window closes", async () => {
    const h = harness();
    await h.owner.openAdditional({ pendingProjectPath: "/project/a" });
    h.close(1);
    expect(h.owner.takePendingProject(1)).toBeNull();
  });

  it("opens an additional window at the agent route when delivery is never acknowledged", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ agentDeliveryFallbackTimeoutMs: 50 });
      await h.owner.openPrimary();
      const windowId = h.windows[0].webContentsId;
      await h.owner.openOrFocusAgent({ id: "agent-7" });
      expect(h.launches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.expired).toEqual([windowId]);
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1]).toEqual({
        initialRoute: "/agent/agent-7",
        restoreWindowState: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a queued delivery when the renderer never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ agentDeliveryFallbackTimeoutMs: 50, queueDeliveries: true });
      await h.owner.openPrimary();
      const windowId = h.windows[0].webContentsId;
      await h.owner.openOrFocusAgent({ id: "agent-7" });
      expect(h.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.expired).toEqual([windowId]);
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1].initialRoute).toBe("/agent/agent-7");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a fallback window once the renderer acknowledges the agent", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ agentDeliveryFallbackTimeoutMs: 50 });
      await h.owner.openPrimary();
      const windowId = h.windows[0].webContentsId;
      await h.owner.openOrFocusAgent({ id: "agent-7" });
      h.owner.acknowledgeAgentDelivery(windowId, { id: "agent-7" });
      await vi.advanceTimersByTimeAsync(500);
      expect(h.launches).toHaveLength(1);
      expect(h.expired).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the watchdog armed when the ack names a different agent", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ agentDeliveryFallbackTimeoutMs: 50 });
      await h.owner.openPrimary();
      const windowId = h.windows[0].webContentsId;
      await h.owner.openOrFocusAgent({ id: "agent-7" });
      h.owner.acknowledgeAgentDelivery(windowId, { id: "agent-9" });
      await vi.advanceTimersByTimeAsync(60);
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1].initialRoute).toBe("/agent/agent-7");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the watchdog when the delivery window closes before acking", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ agentDeliveryFallbackTimeoutMs: 50 });
      await h.owner.openPrimary();
      const windowId = h.windows[0].webContentsId;
      await h.owner.openOrFocusAgent({ id: "agent-7" });
      h.close(windowId);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.launches).toHaveLength(1);
      expect(h.expired).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watches a link that arrives while another window is still being created", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        agentDeliveryFallbackTimeoutMs: 50,
        queueDeliveries: true,
        deferCreate: true,
      });
      const first = h.owner.openOrFocusAgent({ id: "agent-1" });
      const second = h.owner.openOrFocusAgent({ id: "agent-2" });
      await Promise.resolve();
      expect(h.launches).toHaveLength(1);
      h.releaseCreate();
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.expired).toEqual([1]);
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1]).toEqual({
        initialRoute: "/agent/agent-2",
        restoreWindowState: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
