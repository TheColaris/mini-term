import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId, collectPtyIds } from '../store';
import { TabBar } from './TabBar';
import { SplitLayout } from './SplitLayout';
import type { TerminalTab, PaneState, SplitNode, ShellConfig } from '../types';

interface Props {
  projectId: string;
  projectPath: string;
}

function removePane(node: SplitNode, targetPaneId: string): SplitNode | null {
  if (node.type === 'leaf') {
    return node.pane.id === targetPaneId ? null : node;
  }
  const remaining = node.children
    .map((c) => removePane(c, targetPaneId))
    .filter((c): c is SplitNode => c !== null);
  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];
  return { ...node, children: remaining, sizes: remaining.map(() => 100 / remaining.length) };
}

function insertSplit(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newPane: PaneState
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id === targetPaneId) {
      return {
        type: 'split',
        direction,
        children: [node, { type: 'leaf', pane: newPane }],
        sizes: [50, 50],
      };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((c) => insertSplit(c, targetPaneId, direction, newPane)),
  };
}

export function TerminalArea({ projectId, projectPath }: Props) {
  const config = useAppStore((s) => s.config);
  const projectStates = useAppStore((s) => s.projectStates);
  const addTab = useAppStore((s) => s.addTab);
  const updateTabLayout = useAppStore((s) => s.updateTabLayout);
  const removeTab = useAppStore((s) => s.removeTab);
  const ps = projectStates.get(projectId);
  const activeTab = ps?.tabs.find((t) => t.id === ps.activeTabId);

  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = ps?.tabs.find(t => t.id === tabId);
    if (tab) {
      const ptyIds = collectPtyIds(tab.splitLayout);
      for (const id of ptyIds) {
        await invoke('kill_pty', { ptyId: id });
      }
    }
    removeTab(projectId, tabId);
  }, [ps, projectId, removeTab]);

  const handleNewTab = useCallback(async (selectedShell?: ShellConfig) => {
    const shell = selectedShell
      ?? config.availableShells.find((s) => s.name === config.defaultShell)
      ?? config.availableShells[0];
    if (!shell) return;

    const ptyId = await invoke<number>('create_pty', {
      shell: shell.command,
      args: shell.args ?? [],
      cwd: projectPath,
    });

    const paneId = genId();
    const tabId = genId();

    const tab: TerminalTab = {
      id: tabId,
      status: 'idle',
      splitLayout: {
        type: 'leaf',
        pane: {
          id: paneId,
          shellName: shell.name,
          status: 'idle',
          ptyId,
        },
      },
    };

    addTab(projectId, tab);
  }, [projectId, projectPath, config, addTab]);

  const handleNewTabClick = useCallback((e: React.MouseEvent) => {
    const menu = document.createElement('div');
    menu.className = 'fixed bg-[#1a1a2e] border border-[#333] rounded shadow-lg py-1 z-50 text-xs';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    config.availableShells.forEach((shell) => {
      const item = document.createElement('div');
      item.className = 'px-3 py-1.5 cursor-pointer hover:bg-[#7c83ff33] text-gray-300';
      item.textContent = shell.name;
      item.onclick = () => {
        handleNewTab(shell);
        menu.remove();
      };
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }, [config.availableShells, handleNewTab]);

  const handleSplitPane = useCallback(
    async (paneId: string, direction: 'horizontal' | 'vertical') => {
      if (!ps || !activeTab) return;
      const shell = config.availableShells.find((s) => s.name === config.defaultShell)
        ?? config.availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });

      const newPane: PaneState = {
        id: genId(),
        shellName: shell.name,
        status: 'idle',
        ptyId,
      };

      const newLayout = insertSplit(activeTab.splitLayout, paneId, direction, newPane);
      updateTabLayout(projectId, activeTab.id, newLayout);
    },
    [ps, activeTab, config, projectId, projectPath, updateTabLayout]
  );

  const handleClosePane = useCallback(async (paneId: string) => {
    if (!ps || !activeTab) return;

    const findPty = (node: SplitNode): number | null => {
      if (node.type === 'leaf') return node.pane.id === paneId ? node.pane.ptyId : null;
      for (const c of node.children) {
        const found = findPty(c);
        if (found !== null) return found;
      }
      return null;
    };

    const ptyId = findPty(activeTab.splitLayout);
    if (ptyId !== null) {
      await invoke('kill_pty', { ptyId });
    }

    const newLayout = removePane(activeTab.splitLayout, paneId);
    if (newLayout) {
      updateTabLayout(projectId, activeTab.id, newLayout);
    } else {
      handleCloseTab(activeTab.id);
    }
  }, [ps, activeTab, projectId, updateTabLayout, handleCloseTab]);

  return (
    <div className="flex flex-col h-full bg-[#0d0d1a]">
      <TabBar projectId={projectId} onNewTab={handleNewTabClick} onCloseTab={handleCloseTab} />

      <div className="flex-1 overflow-hidden relative">
        {ps?.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === ps.activeTabId ? 'block' : 'none' }}
          >
            <SplitLayout node={tab.splitLayout} onSplit={handleSplitPane} onClose={handleClosePane} />
          </div>
        ))}

        {(!ps || ps.tabs.length === 0) && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            <button
              className="px-4 py-2 border border-dashed border-gray-600 rounded hover:border-[#7c83ff] hover:text-[#7c83ff]"
              onClick={handleNewTabClick}
            >
              + 新建终端
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
