#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local;
mod remote;
mod updater;

use std::sync::{Arc, Mutex};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

// ===================== 共享数据结构 =====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct FileMeta {
    pub size: u64,
    pub total_lines: u64,
}

#[derive(Debug, Serialize)]
pub struct LogLine {
    pub line: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub line: u64,
    pub text: String,
    pub ranges: Vec<MatchRange>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub scanned_lines: u64,
}

#[derive(Debug, Deserialize)]
pub struct FileTarget {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
}

// ===================== 状态 =====================

struct RemoteFile {
    path: String,
    total_lines: u64,
    size: u64,
}

enum ActiveSource {
    Local(local::LocalFile),
    Remote(RemoteFile),
}

struct AppState {
    active: Mutex<Option<ActiveSource>>,
    session: Mutex<Option<Arc<remote::SshSession>>>,
}

// ===================== 辅助函数 =====================

/// 根据用户输入编译正则：非正则模式先转义；icase 控制大小写。
fn compile_regex(pattern: &str, icase: bool, is_regex: bool) -> Result<Regex, String> {
    let effective = if is_regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    regex::RegexBuilder::new(&effective)
        .case_insensitive(icase)
        .build()
        .map_err(|e| format!("正则编译失败: {e}"))
}

/// 本地目录遍历：递归收集 .log/.txt/.out 文件，目录优先排序，限制条目数防止卡死。
fn list_local(dir: &str, recursive: bool) -> Result<Vec<FileEntry>, String> {
    use std::path::Path;
    let root = Path::new(dir);
    if !root.exists() {
        return Err(format!("目录不存在: {dir}"));
    }
    let mut entries: Vec<FileEntry> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    let mut count: usize = 0;
    const LIMIT: usize = 5000;

    while let Some(d) = stack.pop() {
        let rd = std::fs::read_dir(&d).map_err(|e| format!("读取目录失败: {e}"))?;
        for entry in rd {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let name = entry.file_name().to_string_lossy().to_string();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let path = p.to_string_lossy().to_string();

            if name == "." || name == ".." {
                continue;
            }
            if is_dir {
                entries.push(FileEntry {
                    name,
                    path,
                    is_dir: true,
                    size,
                });
                if recursive && count < LIMIT {
                    stack.push(p);
                }
            } else if name.ends_with(".log")
                || name.ends_with(".txt")
                || name.ends_with(".out")
            {
                entries.push(FileEntry {
                    name,
                    path,
                    is_dir: false,
                    size,
                });
            }
            count += 1;
            if count > LIMIT {
                break;
            }
        }
        if count > LIMIT {
            break;
        }
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.cmp(&b.name)
        }
    });
    Ok(entries)
}

// ===================== Tauri 命令 =====================

#[tauri::command]
fn list_local_cmd(dir: String, recursive: bool) -> Result<Vec<FileEntry>, String> {
    list_local(&dir, recursive)
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<(), String> {
    let session = remote::connect(
        &host,
        port,
        &user,
        password.as_deref(),
        key_path.as_deref(),
    )
    .await?;
    *state.session.lock().unwrap() = Some(Arc::new(session));
    Ok(())
}

#[tauri::command]
async fn remote_list(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let session = state
        .session
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "未连接服务器，请先建立 SSH 连接".to_string())?;
    remote::remote_list(&session, &path).await
}

#[tauri::command]
async fn open_file(
    state: State<'_, AppState>,
    target: FileTarget,
) -> Result<FileMeta, String> {
    match target.kind.as_str() {
        "local" => {
            let f = local::open_local(&target.path)?;
            let meta = FileMeta {
                size: f.mmap.len() as u64,
                total_lines: f.total_lines,
            };
            *state.active.lock().unwrap() = Some(ActiveSource::Local(f));
            Ok(meta)
        }
        "remote" => {
            let session = state
                .session
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "未连接服务器，请先建立 SSH 连接".to_string())?;
            let (total, size) = remote::remote_open(&session, &target.path).await?;
            *state.active.lock().unwrap() = Some(ActiveSource::Remote(RemoteFile {
                path: target.path.clone(),
                total_lines: total,
                size,
            }));
            Ok(FileMeta {
                size,
                total_lines: total,
            })
        }
        _ => Err(format!("未知文件类型: {}", target.kind)),
    }
}

#[tauri::command]
async fn read_lines(
    state: State<'_, AppState>,
    start: u64,
    count: u64,
) -> Result<Vec<LogLine>, String> {
    // 预先判定来源并取出远程所需的 path。注意：MutexGuard 必须在 await 之前
    // 完全释放，否则 std::sync::MutexGuard 不满足 Send，Tauri 命令 future
    // 无法通过 Send 约束（命令会被派发到线程池执行）。
    enum Source {
        Local,
        Remote { path: String },
    }
    let source = {
        let guard = state.active.lock().unwrap();
        match guard.as_ref() {
            Some(ActiveSource::Local(_)) => Source::Local,
            Some(ActiveSource::Remote(rf)) => Source::Remote {
                path: rf.path.clone(),
            },
            None => return Err("尚未打开任何文件".to_string()),
        }
    };

    match source {
        Source::Local => {
            let guard = state.active.lock().unwrap();
            match guard.as_ref().unwrap() {
                ActiveSource::Local(f) => Ok(local::read_local(f, start, count)),
                _ => Err("内部状态不一致".to_string()),
            }
        }
        Source::Remote { path } => {
            let session = state
                .session
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "未连接服务器，请先建立 SSH 连接".to_string())?;
            remote::remote_read(&session, &path, start, count).await
        }
    }
}

#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    pattern: String,
    icase: bool,
    is_regex: bool,
    max: u64,
) -> Result<SearchResult, String> {
    let effective = if is_regex {
        pattern.clone()
    } else {
        regex::escape(&pattern)
    };
    let re = compile_regex(&pattern, icase, is_regex)?;

    enum Source {
        Local,
        Remote { path: String },
    }
    let source = {
        let guard = state.active.lock().unwrap();
        match guard.as_ref() {
            Some(ActiveSource::Local(_)) => Source::Local,
            Some(ActiveSource::Remote(rf)) => Source::Remote {
                path: rf.path.clone(),
            },
            None => return Err("尚未打开任何文件".to_string()),
        }
    };

    match source {
        Source::Local => {
            let guard = state.active.lock().unwrap();
            match guard.as_ref().unwrap() {
                ActiveSource::Local(f) => Ok(local::search_local(f, &re, max)),
                _ => Err("内部状态不一致".to_string()),
            }
        }
        Source::Remote { path } => {
            let session = state
                .session
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "未连接服务器，请先建立 SSH 连接".to_string())?;
            remote::remote_search(&session, &path, &effective, &re, icase, max).await
        }
    }
}

// ===================== 诊断命令 =====================
/// 使用内置 russh 测试 SSH 连接与远程命令执行。
#[tauri::command]
async fn ssh_diag(
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<String, String> {
    let mut info = String::new();
    info.push_str("=== DuLog SSH 诊断 ===\n");
    info.push_str(&format!("目标: {}@{}:{}\n", user, host, port));
    info.push_str("使用内置 russh SSH 库（纯 Rust 实现），无需外部 ssh 客户端\n\n");

    match remote::connect(&host, port, &user, Some(&password), None).await {
        Ok(session) => {
            info.push_str("✓ SSH 连接成功\n");
            match remote::ssh_run_test(&session).await {
                Ok(out) => {
                    info.push_str("✓ 远程命令执行成功\n");
                    info.push_str(&format!("远程 echo 输出: {}", out.trim_end()));
                }
                Err(e) => {
                    info.push_str(&format!("✗ 远程命令执行失败: {e}"));
                }
            }
        }
        Err(e) => {
            info.push_str(&format!("✗ SSH 连接失败: {e}"));
        }
    }

    Ok(info)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("保存文件失败: {e}"))
}

// ===================== 入口 =====================

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            active: Mutex::new(None),
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            list_local_cmd,
            ssh_connect,
            ssh_diag,
            remote_list,
            open_file,
            read_lines,
            search,
            save_file,
            updater::check_update,
            updater::download_update,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running DuLog");
}
