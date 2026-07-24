#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local;
mod remote;

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
/// 临时诊断：直接测试 ssh 连接，返回完整 stdout + stderr
#[tauri::command]
async fn ssh_diag(
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<String, String> {
    let ssh_bin = remote::find_ssh_diag()?;
    let destination = format!("{}@{}", user, host);
    let pid = std::process::id();

    // 创建 ASKPASS
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pw_name = format!("dulog-diag-pw-{}-{}.txt", pid, timestamp);
    let bat_name = format!("dulog-diag-askpass-{}-{}.bat", pid, timestamp);

    let mut pw_file = std::env::temp_dir();
    pw_file.push(&pw_name);
    std::fs::write(&pw_file, password.as_bytes()).map_err(|e| format!("写入密码: {e}"))?;

    let mut bat_file = std::env::temp_dir();
    bat_file.push(&bat_name);
    let bat_content = format!("@echo off\r\ntype \"{}\"\r\n", pw_file.display());
    std::fs::write(&bat_file, &bat_content).map_err(|e| format!("写入 askpass: {e}"))?;

    let mut empty_cfg = std::env::temp_dir();
    empty_cfg.push(format!("dulog-diag-cfg-{}-{}.empty", pid, timestamp));
    std::fs::write(&empty_cfg, "").map_err(|e| format!("写入空配置: {e}"))?;

    let mut cmd = tokio::process::Command::new(&ssh_bin);
    cmd.arg("-F").arg(empty_cfg.display().to_string().replace('\\', "/"))
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("UserKnownHostsFile=NUL")
        .arg("-o").arg("ConnectTimeout=10")
        .arg("-o").arg("BatchMode=no")
        .arg("-o").arg("PubkeyAuthentication=no")
        .arg("-o").arg("PreferredAuthentications=password")
        .arg("-p").arg(port.to_string())
        .arg("-v")  // debug 模式
        .env("SSH_ASKPASS", bat_file.display().to_string().replace('\\', "/"))
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", ":0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    cmd.arg(&destination);
    cmd.arg("echo");
    cmd.arg("DIAG_OK");

    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        cmd.output(),
    ).await;

    // 清理
    let _ = std::fs::remove_file(&pw_file);
    let _ = std::fs::remove_file(&bat_file);
    let _ = std::fs::remove_file(&empty_cfg);

    match out {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(format!(
                "Exit: {}\n--- STDOUT ---\n{}\n--- STDERR ---\n{}\n--- END ---",
                output.status.code().unwrap_or(-1),
                stdout,
                stderr,
            ))
        }
        Ok(Err(e)) => Err(format!("spawn 失败: {e}")),
        Err(_) => Err("命令超时（15 秒）".into()),
    }
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
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running DuLog");
}
