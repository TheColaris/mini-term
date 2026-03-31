# Git 集成功能设计

## 概述

为 mini-term 的文件树集成只读 Git 状态显示和 diff 查看功能。用户可在文件树中直观看到哪些文件被修改，点击后通过 Modal 弹窗查看变更对比。

## 需求

- 文件树中显示 Git 变更状态标记（M/A/D/R/?）
- 点击变更文件或右键菜单"查看变更"打开 Diff Modal
- Diff 支持并排（Side-by-side）和内联（Unified）两种视图，可切换
- 显示范围：工作区变更（unstaged + staged），即 `git status` 可见内容
- 只读查看，不提供 stage/commit 等操作
- 支持多仓库发现：项目根目录非 git 仓库时，自动扫描直接子目录

## 技术方案

使用 Rust `git2` crate（libgit2 绑定）在后端读取 Git 数据，前端渲染状态和 diff。

## 后端设计（Rust）

### 新增文件：`src-tauri/src/git.rs`

**依赖：** `git2` crate

### 数据结构

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,         // 相对于项目根目录
    pub status: GitStatus,
    pub status_label: String, // "M", "A", "D", "R", "?"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,     // "add", "delete", "context"
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub old_content: String,
    pub new_content: String,
    pub hunks: Vec<DiffHunk>,
}
```

### Tauri 命令

**`get_git_status(project_path: String) -> Vec<GitFileStatus>`**

1. 尝试以 `project_path` 打开 git 仓库
2. 若失败，扫描 `project_path` 的直接子目录（1 层深），收集所有含 `.git` 的子目录
3. 对每个发现的仓库，调用 `repo.statuses()` 获取变更文件列表
4. 将所有文件路径统一转为相对于 `project_path` 的路径
5. 返回合并后的 `Vec<GitFileStatus>`

**`get_git_diff(project_path: String, file_path: String) -> GitDiffResult`**

1. 根据 `file_path` 定位其所属 git 仓库（根目录仓库或子目录仓库）
2. 使用 `git2` 获取文件的 HEAD 版本（旧内容）和工作区版本（新内容）
3. 使用 `git2::Diff` 生成 hunk 信息
4. 对于新增/未跟踪文件，旧内容为空；对于删除文件，新内容为空
5. 返回 `GitDiffResult`

### 仓库发现逻辑

```
get_git_status(project_path):
  if project_path 是 git 仓库:
    返回该仓库的 status
  else:
    repos = []
    for dir in project_path 的直接子目录:
      if dir 包含 .git:
        repos.push(dir)
    for repo in repos:
      收集 status，路径前缀加上子目录名
    返回合并结果
```

## 前端设计

### 文件树增强（修改 `FileTree.tsx`）

**状态获取：**
- 项目切换或文件树首次加载时调用 `get_git_status`
- 用 `Map<filePath, GitFileStatus>` 缓存结果
- 收到 `fs-change` 事件后 500ms 防抖刷新

**TreeNode 渲染：**
- 文件名右侧追加状态字母标记（M/A/D/R/?），小字号灰色
- 父文件夹聚合子文件状态，显示最高优先级标记

**交互入口：**
- 点击有变更标记的文件 → 打开 DiffModal
- 右键菜单新增"查看变更"选项（仅对有变更的文件显示）

**无 Git 仓库：**
- `get_git_status` 返回空数组 → 文件树正常显示，无额外标记

### 新增组件：`DiffModal.tsx`

**布局：**
- 全屏 Modal（90vw x 80vh），居中显示
- ESC 或点击背景关闭
- 配色沿用项目 Warm Carbon 主题

**顶部工具栏：**
- 左侧：文件名 + 状态标记（M/A/D/R/?）
- 右侧：并排/内联切换按钮

**并排视图（Side-by-side）：**
- 左右两栏，左旧右新
- 删除行：红色背景高亮
- 新增行：绿色背景高亮
- 行号显示

**内联视图（Unified）：**
- 单栏显示
- 删除行以 `-` 标记 + 红色高亮
- 新增行以 `+` 标记 + 绿色高亮
- 上下文行显示行号

### 类型定义（修改 `types.ts`）

新增前端类型，与后端 `serde(rename_all = "camelCase")` 对齐：
- `GitStatus`
- `GitFileStatus`
- `DiffHunk`
- `DiffLine`
- `GitDiffResult`

## 数据流

```
项目切换 / 文件树加载
  → invoke('get_git_status', projectPath)
  → 返回 Vec<GitFileStatus>
  → FileTree 用 Map<path, status> 缓存，TreeNode 渲染标记

文件变更 (fs-change 事件)
  → 500ms 防抖
  → 重新调用 get_git_status 刷新

点击变更文件 / 右键"查看变更"
  → invoke('get_git_diff', projectPath, filePath)
  → 返回 GitDiffResult
  → 打开 DiffModal，渲染并排或内联视图
```

## 文件变更清单

### 新增文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src-tauri/src/git.rs` | Rust | git2 仓库发现、status、diff |
| `src/components/DiffModal.tsx` | React | Diff 弹窗组件（并排+内联切换） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/lib.rs` | 注册 `get_git_status`、`get_git_diff` 命令 |
| `src-tauri/Cargo.toml` | 添加 `git2` 依赖 |
| `src/components/FileTree.tsx` | 加载 git status、传递给 TreeNode、右键菜单增加"查看变更"、点击打开 DiffModal |
| `src/types.ts` | 新增 Git 相关类型定义 |
