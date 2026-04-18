use ignore::gitignore::Gitignore;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event as NotifyEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
}

/// 从 project_root 到 current 逐级收集 .gitignore，返回顺序为「根 → 当前」
///
/// 参考 git 的处理方式：每一层子目录都可以有自己的 .gitignore，
/// 子目录规则优先级高于父级（可通过 `!pattern` 取消父级的忽略）。
fn collect_gitignores(project_root: &Path, current: &Path) -> Vec<Gitignore> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut cur = current.to_path_buf();
    loop {
        dirs.push(cur.clone());
        if cur.as_path() == project_root {
            break;
        }
        match cur.parent() {
            Some(parent) if parent.starts_with(project_root) => {
                cur = parent.to_path_buf();
            }
            _ => break,
        }
    }
    dirs.reverse();

    dirs.iter()
        .filter_map(|dir| {
            let gi_path = dir.join(".gitignore");
            if !gi_path.exists() {
                return None;
            }
            let (gi, _err) = Gitignore::new(&gi_path);
            Some(gi)
        })
        .collect()
}

/// 按「根 → 当前」顺序合并 match 结果：后者覆盖前者，支持 `!pattern` 白名单
fn is_path_ignored(gitignores: &[Gitignore], full_path: &Path, is_dir: bool) -> bool {
    let mut ignored = false;
    for gi in gitignores {
        let m = gi.matched(full_path, is_dir);
        if m.is_whitelist() {
            ignored = false;
        } else if m.is_ignore() {
            ignored = true;
        }
    }
    ignored
}

const ALWAYS_IGNORE: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "__pycache__", ".superpowers"];

/// 过滤出有效的目录路径（用于拖拽添加项目时验证）
#[tauri::command]
pub fn filter_directories(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

#[tauri::command]
pub fn list_directory(project_root: String, path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let gitignores = collect_gitignores(Path::new(&project_root), dir);
    let mut entries: Vec<FileEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            let full_path = entry.path();
            // ALWAYS_IGNORE 目录仍然完全隐藏
            if is_dir && ALWAYS_IGNORE.contains(&name.as_str()) {
                return None;
            }
            let ignored = is_path_ignored(&gitignores, &full_path, is_dir);
            Some(FileEntry {
                name,
                path: full_path.to_string_lossy().to_string(),
                is_dir,
                ignored,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then_with(|| a.ignored.cmp(&b.ignored))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangePayload {
    project_path: String,
    path: String,
    kind: String,
}

pub struct FsWatcherManager {
    watchers: Arc<Mutex<HashMap<String, RecommendedWatcher>>>,
}

impl FsWatcherManager {
    pub fn new() -> Self {
        Self { watchers: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    state: tauri::State<'_, FsWatcherManager>,
    path: String,
    project_path: String,
) -> Result<(), String> {
    let watch_path = PathBuf::from(&path);
    let project_path_clone = project_path.clone();
    let app_clone = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<NotifyEvent, _>| {
        if let Ok(event) = res {
            for p in &event.paths {
                let _ = app_clone.emit("fs-change", FsChangePayload {
                    project_path: project_path_clone.clone(),
                    path: p.to_string_lossy().to_string(),
                    kind: format!("{:?}", event.kind),
                });
            }
        }
    }).map_err(|e| e.to_string())?;

    watcher.watch(&watch_path, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    let mut watchers = state.watchers.lock().unwrap();
    watchers.insert(path, watcher);
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResult {
    pub content: String,
    pub is_binary: bool,
    pub too_large: bool,
}

const MAX_FILE_VIEW_SIZE: u64 = 1_048_576; // 1MB

#[tauri::command]
pub fn read_file_content(path: String) -> Result<FileContentResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE_VIEW_SIZE {
        return Ok(FileContentResult { content: String::new(), is_binary: false, too_large: true });
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(FileContentResult { content: s, is_binary: false, too_large: false }),
        Err(_) => Ok(FileContentResult { content: String::new(), is_binary: true, too_large: false }),
    }
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("已存在: {}", path));
    }
    fs::write(p, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("已存在: {}", path));
    }
    fs::create_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_directory(state: tauri::State<'_, FsWatcherManager>, path: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&path);
    Ok(())
}

#[tauri::command]
pub fn rename_entry(old_path: String, new_name: String) -> Result<String, String> {
    let p = Path::new(&old_path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", old_path));
    }
    let parent = p.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err(format!("目标已存在: {}", new_path.display()));
    }
    fs::rename(p, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_ignore_contains_common_build_dirs() {
        assert!(ALWAYS_IGNORE.contains(&".git"));
        assert!(ALWAYS_IGNORE.contains(&"node_modules"));
        assert!(ALWAYS_IGNORE.contains(&"target"));
    }

    #[test]
    fn is_path_ignored_empty_returns_false() {
        assert!(!is_path_ignored(&[], Path::new("/any/path"), false));
    }
}
