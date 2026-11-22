import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

export function parseAgentDeepLinkFromArgv(argv: string[]): AgentDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseAgentDeepLink(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

export class AgentNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, AgentDeepLinkTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): AgentDeepLinkTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(webContentsId: number, target: AgentDeepLinkTarget): AgentDeepLinkTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  /**
   * Discard a queued target for a window, e.g. after a delivery watchdog falls
   * back to opening a dedicated window. Readiness is preserved — a live
   * listener only calls ready() once per mount, and a stale-ready window is
   * still covered by the watchdog on the next delivery.
   */
  discardPending(webContentsId: number): void {
    this.pendingByWindow.delete(webContentsId);
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
