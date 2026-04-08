# Git Pull/Push 按钮设计

## 概述

在 Git History 面板的每个仓库行右侧添加 pull (`↓`) 和 push (`↑`) 操作按钮，hover 时显示，点击后在后台静默执行 git 命令并通过按钮状态反馈结果。

## Rust 后端

在 `src-tauri/src/git.rs` 新增两个 Tauri command：

```rust
#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String>

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String>
```

- 通过 `std::process::Command` 在 `repo_path` 目录下执行 `git pull` / `git push`
- 成功返回 stdout，失败返回 stderr 作为 `Err(String)`
- 在 `lib.rs` 中注册这两个 command

## 前端 UI

### 仓库行布局（GitHistory.tsx）

```
默认：    ▾ repo-name [main]
hover 后：▾ repo-name [main]                    ↓ ↑
```

- 仓库行使用 `display: flex; justify-content: space-between`
- 右侧容器包含 `↓`（pull）和 `↑`（push）两个 Unicode 按钮
- 默认 `opacity: 0`，hover 仓库行时 `opacity: 1`，过渡 150ms
- 按钮颜色 `--text-muted`，hover 按钮时 `--text-primary`
- 点击 `e.stopPropagation()` 防止触发仓库展开/折叠
- 执行期间显示旋转的 `↻` 表示 loading，禁用点击

### 操作反馈（无 toast 组件）

- **执行中**：按钮变为旋转的 `↻`
- **成功**：按钮短暂变为 `✓`（绿色 `--color-success`），1.5 秒后恢复
- **失败**：按钮短暂变为 `✕`（红色 `--color-error`），`title` 属性显示错误信息，1.5 秒后恢复

## 数据流

```
用户 hover 仓库行 → 显示 ↓ ↑ 按钮
点击 ↓ → invoke('git_pull', { repoPath }) → loading
  → 成功：✓ 闪绿 + 自动刷新该仓库 commit 历史
  → 失败：✕ 闪红 + title 显示错误
点击 ↑ → invoke('git_push', { repoPath }) → loading
  → 成功：✓ 闪绿
  → 失败：✕ 闪红 + title 显示错误
```

## 状态管理

- loading 状态用组件内 `useState` 管理（不入全局 store）
- pull 成功后调用已有的 `loadCommits` 刷新该仓库提交历史
- push 成功后不刷新（本地历史未变）
- 两个按钮互不阻塞

## 技术决策

- **git CLI 而非 git2-rs**：项目已有模式（`git.rs` 全部使用 `std::process::Command`），复用用户的 SSH key / credential helper，实现简单
- **Unicode 字符而非 icon 库**：与项目现有风格一致（`▾` `↻` `✕`）
- **hover 显示而非始终显示**：保持界面简洁
