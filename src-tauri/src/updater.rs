use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::{AppHandle, Emitter};

// ===================== 数据结构 =====================

#[derive(Debug, Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub body: String,
    pub download_url: String,
    pub file_size: u64,
    pub published_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: String,
    published_at: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

// ===================== 辅助函数 =====================

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let latest = latest.strip_prefix('v').unwrap_or(latest);
    let current = current.strip_prefix('v').unwrap_or(current);
    compare_semver(latest, current)
}

/// 简单 semver 比较：按数字段逐段比较。
/// 返回 true 表示 latest > current。
fn compare_semver(latest: &str, current: &str) -> bool {
    let l_parts: Vec<u32> = latest
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    let c_parts: Vec<u32> = current
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    for i in 0..3 {
        let l = l_parts.get(i).copied().unwrap_or(0);
        let c = c_parts.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    false
}

fn platform_asset_name_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        ".msi"
    } else if cfg!(target_os = "macos") {
        ".dmg"
    } else {
        // Linux: .deb or .AppImage
        ".deb"
    }
}

// ===================== Tauri 命令 =====================

const GITHUB_API: &str =
    "https://api.github.com/repos/duhuilai/dulog/releases/latest";

#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("DuLog-Updater/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .get(GITHUB_API)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "网络连接失败，请检查网络设置".to_string()
            } else if e.is_timeout() {
                "请求超时，请稍后重试".to_string()
            } else {
                format!("请求失败: {e}")
            }
        })?;

    if resp.status().as_u16() == 403 {
        // 检查是否被限流
        if let Some(remaining) = resp.headers().get("x-ratelimit-remaining") {
            if remaining == "0" {
                return Err("GitHub API 请求次数已达上限，请 1 小时后重试".to_string());
            }
        }
        return Err("访问 GitHub API 被拒绝（403），请检查网络或使用代理".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误: HTTP {}", resp.status()));
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 响应失败: {e}"))?;

    let cur = current_version();
    let has_update = is_newer(&release.tag_name, &cur);

    // 匹配当前平台的资源
    let hint = platform_asset_name_hint();
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.contains(hint))
        .ok_or_else(|| format!("未找到适用于当前平台的安装包（查找包含 \"{}\" 的资源）", hint))?;

    Ok(UpdateInfo {
        current_version: cur,
        latest_version: release.tag_name,
        has_update,
        body: release.body,
        download_url: asset.browser_download_url.clone(),
        file_size: asset.size,
        published_at: release.published_at,
    })
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    download_url: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("DuLog-Updater/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    // 从 URL 提取文件名
    let filename = download_url
        .split('/')
        .last()
        .unwrap_or("DuLog_update")
        .to_string();

    // 保存到下载目录
    let download_dir = dirs_next::download_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let save_path = download_dir.join(&filename);

    let total = resp.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(&save_path)
        .map_err(|e| format!("创建文件失败: {e}"))?;

    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("下载数据错误: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败: {e}"))?;
        received += chunk.len() as u64;

        // 发送进度事件到前端
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                received,
                total,
            },
        );
    }

    file.flush().map_err(|e| format!("刷新文件失败: {e}"))?;

    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn install_update(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 start 命令打开 .msi 安装包
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("打开安装包失败: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        return Err(
            "Linux 暂不支持自动安装，请手动安装下载的包".to_string()
        );
    }

    Ok(())
}
