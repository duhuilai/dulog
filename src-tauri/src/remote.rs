use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use regex::Regex;
use russh::client::{Config, Handle, Handler};
use russh::ChannelMsg;

use crate::{FileEntry, LogLine, MatchRange, SearchMatch, SearchResult};

/// 已建立的 SSH 会话。底层为 russh 客户端句柄，命令通过独立 Channel 执行。
pub struct SshSession {
    handle: Arc<tokio::sync::Mutex<Handle<Client>>>,
}

impl Clone for SshSession {
    fn clone(&self) -> Self {
        Self {
            handle: self.handle.clone(),
        }
    }
}

/// russh Handler 实现：接受任意主机密钥（类似 StrictHostKeyChecking=accept-new）。
/// 生产环境可在此实现 known_hosts 校验。
#[derive(Clone)]
struct Client;

#[async_trait]
impl Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 建立 SSH 连接：支持密码认证或私钥认证，完全内嵌，无需外部 ssh 客户端。
pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    key_path: Option<&str>,
) -> Result<SshSession, String> {
    let config = Arc::new(Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(60)),
        ..Default::default()
    });

    let addr = format!("{}:{}", host, port);
    let mut handle = russh::client::connect(config, &addr, Client)
        .await
        .map_err(|e| format!("SSH 连接失败: {e}"))?;

    let auth_ok = if let Some(pw) = password {
        handle
            .authenticate_password(user, pw)
            .await
            .map_err(|e| format!("密码认证失败: {e}"))?
    } else if let Some(key) = key_path {
        let key_path = Path::new(key);
        let key = russh_keys::load_secret_key(key_path, None)
            .map_err(|e| format!("读取私钥失败: {e}"))?;
        let key_arc = Arc::new(key);
        handle
            .authenticate_publickey(user, key_arc)
            .await
            .map_err(|e| format!("公钥认证失败: {e}"))?
    } else {
        return Err("请提供密码或私钥路径".into());
    };

    if !auth_ok {
        return Err("认证被拒绝：用户名/密码/密钥不匹配".into());
    }

    Ok(SshSession {
        handle: Arc::new(tokio::sync::Mutex::new(handle)),
    })
}

/// 在已建立的会话上执行单条远程 shell 命令，返回 stdout。
async fn ssh_run(session: &SshSession, command: &str) -> Result<String, String> {
    let mut channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SSH 通道失败: {e}"))?
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("执行远程命令失败: {e}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, ext } if ext == 1 => {
                stderr.extend_from_slice(data);
            }
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            _ => {}
        }
    }

    if let Some(code) = exit_code {
        if code != 0 {
            let err = String::from_utf8_lossy(&stderr);
            return Err(format!("远程命令退出码 {}: {}", code, err));
        }
    }

    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// 诊断用：执行远程 echo 测试。
pub async fn ssh_run_test(session: &SshSession) -> Result<String, String> {
    ssh_run(session, "echo DIAG_OK").await
}

fn sh_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

/// 列举远程目录下的文件/子目录（不含隐藏项），限制 5000 条。
pub async fn remote_list(session: &SshSession, path: &str) -> Result<Vec<FileEntry>, String> {
    let path_q = sh_quote(path);
    let remote = format!(
        "cd {p} && {{ for f in *; do [ -e \"$f\" ] || continue; if [ -d \"$f\" ]; then t=d; else t=f; fi; s=$(stat -c%s \"$f\" 2>/dev/null || echo 0); printf '%s\\t%s\\t%s\\n' \"$t\" \"$s\" \"$f\"; done; }} | head -n 5000",
        p = path_q
    );
    let out = ssh_run(session, &remote).await?;
    let mut entries: Vec<FileEntry> = Vec::new();
    for line in out.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let t = parts.next().unwrap_or("");
        let s = parts.next().unwrap_or("0");
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let size: u64 = s.parse().unwrap_or(0);
        let is_dir = t == "d";
        let full = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };
        entries.push(FileEntry {
            name,
            path: full,
            is_dir,
            size,
        });
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

/// 获取远程文件的行数（估算）与字节大小。
pub async fn remote_open(session: &SshSession, path: &str) -> Result<(u64, u64), String> {
    let path_q = sh_quote(path);
    let remote = format!(
        "bytes=$(stat -c%s {p} 2>/dev/null || echo 0); \
         sample=$(head -c 8192 {p} 2>/dev/null | wc -lc); \
         sample_lines=$(echo \"$sample\" | awk '{{print $1}}'); \
         sample_bytes=$(echo \"$sample\" | awk '{{print $2}}'); \
         if [ \"$sample_lines\" -gt 0 ] && [ \"$sample_bytes\" -gt 0 ]; then \
           estimated=$((bytes * sample_lines / sample_bytes)); \
         else \
           estimated=$((bytes / 200)); \
         fi; \
         if [ \"$estimated\" -lt 1 ] && [ \"$bytes\" -gt 0 ]; then estimated=1; fi; \
         echo \"$estimated $bytes\"",
        p = path_q
    );
    let out = ssh_run(session, &remote).await?;
    let mut it = out.split_whitespace();
    let lines = it.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let bytes = it.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    Ok((lines, bytes))
}

/// 读取远程文件第 [start, start+count) 行（1-based）。
pub async fn remote_read(
    session: &SshSession,
    path: &str,
    start: u64,
    count: u64,
) -> Result<Vec<LogLine>, String> {
    if start < 1 || count == 0 {
        return Ok(Vec::new());
    }
    let path_q = sh_quote(path);
    let remote = format!("tail -n +{} {} | head -n {}", start, path_q, count);
    let out = ssh_run(session, &remote).await?;
    let text = out.trim_end_matches('\n');
    let mut line_no = start;
    let mut out_vec: Vec<LogLine> = Vec::new();
    for ln in text.split('\n') {
        out_vec.push(LogLine {
            line: line_no,
            text: ln.trim_end_matches('\r').to_string(),
        });
        line_no += 1;
    }
    Ok(out_vec)
}

/// 在远程文件上用 grep 做候选行过滤，再用客户端 Rust 正则精确计算高亮区间。
pub async fn remote_search(
    session: &SshSession,
    path: &str,
    pattern: &str,
    re: &Regex,
    icase: bool,
    max: u64,
) -> Result<SearchResult, String> {
    let path_q = sh_quote(path);
    let pat_q = sh_quote(pattern);
    let flag_i = if icase { "-i" } else { "" };
    let remote = format!(
        "grep -n -E {} -- {} {} | head -n {}",
        flag_i, pat_q, path_q, max
    );
    let start = Instant::now();
    let out = ssh_run(session, &remote).await?;
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut truncated = false;
    let mut scanned: u64 = 0;

    for raw in out.split('\n') {
        if raw.is_empty() {
            continue;
        }
        scanned += 1;
        let idx = match raw.find(':') {
            Some(i) => i,
            None => continue,
        };
        let lineno_str = &raw[..idx];
        let content = &raw[idx + 1..];
        let line_no: u64 = match lineno_str.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let content_t = content.trim_end_matches('\r');
        let mut ranges: Vec<MatchRange> = Vec::new();
        for m in re.find_iter(content_t) {
            ranges.push(MatchRange {
                start: m.start() as u32,
                end: m.end() as u32,
            });
        }
        if ranges.is_empty() {
            continue;
        }
        matches.push(SearchMatch {
            line: line_no,
            text: content_t.to_string(),
            ranges,
        });
        if matches.len() as u64 >= max {
            truncated = true;
            break;
        }
    }

    Ok(SearchResult {
        matches,
        truncated,
        elapsed_ms: start.elapsed().as_millis() as u64,
        scanned_lines: scanned,
    })
}
