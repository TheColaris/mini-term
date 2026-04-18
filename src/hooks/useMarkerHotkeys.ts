import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { scrollToMarker } from '../utils/terminalCache';
import type { SplitNode } from '../types';

function findActivePaneId(node: SplitNode): string | null {
  if (node.type === 'leaf') return node.activePaneId || null;
  for (const child of node.children) {
    const id = findActivePaneId(child);
    if (id) return id;
  }
  return null;
}

function findPtyIdByPaneId(node: SplitNode, paneId: string): number | null {
  if (node.type === 'leaf') {
    const pane = node.panes.find((p) => p.id === paneId);
    return pane?.ptyId ?? null;
  }
  for (const child of node.children) {
    const id = findPtyIdByPaneId(child, paneId);
    if (id != null) return id;
  }
  return null;
}

export function useMarkerHotkeys() {
  const lastJumpRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const state = useAppStore.getState();
      const activeProjectId = state.activeProjectId;
      if (!activeProjectId) return;
      const ps = state.projectStates.get(activeProjectId);
      if (!ps) return;
      const tab = ps.tabs.find((t) => t.id === ps.activeTabId);
      if (!tab) return;
      const paneId = findActivePaneId(tab.splitLayout);
      if (!paneId) return;
      const ptyId = findPtyIdByPaneId(tab.splitLayout, paneId);
      if (ptyId == null) return;

      const markers = state.getMarkersForPty(ptyId);
      if (markers.length === 0) return;

      const lastId = lastJumpRef.current.get(ptyId);
      const lastIdx = lastId ? markers.findIndex((m) => m.id === lastId) : markers.length;
      const dir = e.key === 'ArrowUp' ? -1 : +1;

      let nextIdx: number;
      if (lastId && lastIdx >= 0) {
        nextIdx = lastIdx + dir;
      } else {
        nextIdx = dir === -1 ? markers.length - 1 : 0;
      }
      if (nextIdx < 0 || nextIdx >= markers.length) return;

      e.preventDefault();
      e.stopPropagation();
      const target = markers[nextIdx];
      lastJumpRef.current.set(ptyId, target.id);
      scrollToMarker(ptyId, target.xtermMarkerId);
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);
}
