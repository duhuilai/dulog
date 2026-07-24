use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use regex::Regex;
use tokio::process::Command as TokioCommand;

use crate::{FileEntry, LogLine, MatchRange, SearchMatch, SearchResult};

/// SSH 认证方式（会话级别，连接期间持有 ASKPASS 文件）
enum SshAuth {
    /// 密码认证：持有 askpass 脚本和密码文件路径（Drop 时清理）
    Password {
        askpass: PathBuf,
        pw_file: PathBuf,
    },
    /// 指定私钥认证
    Key {
        key_path: PathBuf,
    },
    /// 默认认证（ssh-agent / 自动选择密钥）
    Agent,
}

/// 一个已建立的 SSH 会话。存储连接参数与认证信息，
/// 每次远程命令独立创建新的 SSH 连接执行。
///
/// 不再使用 ControlMaster 多路复用：在 tokio spawn 的 Windows 子进程环境中，
/// `-N -M -S` 模式不稳定（MSYS2 mount table 缺失导致 /dev/null 不可用，
/// 即使换用临时空文件，spawn 持进程 + 轮询 socket 方案仍会挂起）。
/// 改为每次命令独立连接，简单可靠。
///
/// 支持两种认证：
/// - 密码（通过 SSH_ASKPASS 双文件方案注入）
/// - 密钥 / ssh-agent
pub struct SshSession {
    ssh_bin: PathBuf,
    destination: String, // user@host
    port: u16,
    auth: SshAuth,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // 清理 askpass 临时文件（密码/密钥文件不需要特别清理）
        if let SshAuth::Password { ref askpass, ref pw_file } = self.auth {
            let _ = std::fs::remove_file(askpass);
            let _ = std::fs::remove_file(pw_file);
        }
    }
}

/// 在 PATH 与常见安装位置中定位 `ssh` 可执行文件。
/// 优先选择 Git/OpenSSH 移植版（支持 SSH_ASKPASS 密码注入），
/// 其次回退到 Windows 系统自带的 OpenSSH（仅密钥/agent 可靠）。
fn find_ssh() -> Result<PathBuf, String> {
    // 优先：Git 移植版（完整 Unix 行为，含 ASKPASS 支持）
    let git_candidates = [
        r"C:\Users\zkpd\.workbuddy\vendor\PortableGit\usr\bin\ssh.exe",
        r"C:\Program Files\Git\usr\bin\ssh.exe",
        r"C:\Program Files (x86)\Git\usr\bin\ssh.exe",
    ];
    for c in git_candidates {
        if Path::new(c).exists() {
            return Ok(PathBuf::from(c));
        }
    }
    // 回退：PATH 中的第一个 ssh
    if let Ok(out) = std::process::Command::new("where").arg("ssh").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = s.lines().next() {
                let p = PathBuf::from(first.trim());
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }
    // 最后：系统自带
    let sys = r"C:\Windows\System32\OpenSSH\ssh.exe";
    if Path::new(sys).exists() {
        return Ok(PathBuf::from(sys));
    }
    Err("未找到 ssh 客户端，请安装 Git for Windows 或确保 OpenSSH 在 PATH 中".into())
}

/// 诊断版本：仅定位可用 ssh，供 ssh_diag 使用
pub fn find_ssh_diag() -> Result<PathBuf, String> {
    find_ssh()
}

/// 生成临时 askpass 脚本（双文件方案）。
/// 返回 (askpass_path, pw_file_path)。
///
/// 方案：密码写入独立 .txt 二进制文件（无尾随换行），再生成 .bat 脚本
/// 用 Windows 原生 `type` 命令原样输出。`type` 不做任何文本转换，
/// 字节等同原始密码。完全避开 MSYS2/.sh 的环境依赖和 cmd.exe echo/set/p 的
/// CRLF/转义问题。
fn write_askpass(pw: &str) -> Result<(PathBuf, PathBuf), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let pw_name = format!("dulog-pw-{}-{}.txt", pid, timestamp);
    let bat_name = format!("dulog-askpass-{}-{}.bat", pid, timestamp);

    // 密码文件：纯二进制，无尾随换行
    let mut pw_file = std::env::temp_dir();
    pw_file.push(&pw_name);
    std::fs::write(&pw_file, pw.as_bytes())
        .map_err(|e| format!("写入密码文件失败: {e}"))?;

    // .bat ASKPASS：用 type 原样输出密码文件
    // 使用 %TEMP% 而非绝对路径——MSYS2 ssh exec .bat 时 cmd.exe
    // 的驱动器上下文可能不同，绝对路径（如 C:/Users/...）解析失败
    let mut bat = std::env::temp_dir();
    bat.push(&bat_name);
    let content = format!("@echo off\r\ntype \"%TEMP%\\{}\"\r\n", pw_name);
    std::fs::write(&bat, content).map_err(|e| format!("写入 askpass 失败: {e}"))?;

    Ok((bat, pw_file))
}

/// 建立 SSH 连接：通过直接执行 `echo PING` 验证认证是否成功。
/// 不再使用 ControlMaster 多路复用，改为保持认证参数供后续命令复用。
pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    key_path: Option<&str>,
) -> Result<SshSession, String> {
    let ssh_bin = find_ssh()?;
    let destination = format!("{}@{}", user, host);

    // Windows 子进程没有 MSYS2 mount table，/dev/null 不可用。
    // 创建临时空文件替代 -F /dev/null 跳过用户 ssh config。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut empty_config = std::env::temp_dir();
    empty_config.push(format!("dulog-sshcfg-{}-{}.empty", std::process::id(), stamp));
    std::fs::write(&empty_config, "").map_err(|e| format!("写入空 config: {e}"))?;

    let mut cmd = TokioCommand::new(&ssh_bin);
    cmd.arg("-F")
        .arg(empty_config.to_string_lossy().replace('\\', "/"))
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("UserKnownHostsFile=NUL")
        .arg("-o").arg("ConnectTimeout=15")
        .arg("-o").arg("BatchMode=no")
        .arg("-o").arg("ServerAliveInterval=30")
        .arg("-p").arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let auth: SshAuth;
    if let Some(pw) = password {
        let (askpass, pw_file) = write_askpass(pw)?;
        let askpass_path = askpass.to_string_lossy().replace('\\', "/");
        cmd.env("SSH_ASKPASS", &askpass_path)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", ":0");
        cmd.arg("-o").arg("PreferredAuthentications=password")
            .arg("-o").arg("PubkeyAuthentication=no");
        auth = SshAuth::Password { askpass, pw_file };
    } else {
        if let Some(k) = key_path {
            cmd.arg("-i").arg(k).arg("-o").arg("IdentitiesOnly=yes");
            auth = SshAuth::Key {
                key_path: PathBuf::from(k),
            };
        } else {
            cmd.arg("-o").arg("PreferredAuthentications=publickey");
            auth = SshAuth::Agent;
        }
    }

    // 直接执行 echo PING 验证连接（不用 ControlMaster spawn 模式）
    cmd.arg(&destination).arg("echo").arg("PING");

    let out = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        cmd.output(),
    )
    .await;

    // 无论成功失败，清理临时空 config
    let _ = std::fs::remove_file(&empty_config);

    match out {
        Ok(Ok(output)) if output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains("PING") =>
        {
            Ok(SshSession {
                ssh_bin,
                destination,
                port,
                auth,
            })
        }
        Ok(Ok(output)) => {
            // 认证失败或远程命令执行异常
            cleanup_auth(&auth);
            let err = String::from_utf8_lossy(&output.stderr);
            let detail = if err.trim().is_empty() {
                format!("退出码: {}", output.status.code().unwrap_or(-1))
            } else {
                err.trim().to_string()
            };
            Err(format!(
                "SSH 连接失败\n路径: {}\n目标: {}\n---\n{}",
                ssh_bin.display(),
                destination,
                detail
            ))
        }
        Ok(Err(e)) => {
            // spawn 进程失败
            cleanup_auth(&auth);
            Err(format!(
                "启动 ssh 失败\n路径: {}\n目标: {}\n错误: {e}",
                ssh_bin.display(),
                destination,
            ))
        }
        Err(_) => {
            // tokio::time::timeout 超时
            cleanup_auth(&auth);
            Err("SSH 连接超时（25 秒），请检查网络或防火墙".into())
        }
    }
}

/// 清理认证相关的临时文件（仅用于 connect 失败的清理路径）
fn cleanup_auth(auth: &SshAuth) {
    if let SshAuth::Password { ref askpass, ref pw_file } = auth {
        let _ = std::fs::remove_file(askpass);
        let _ = std::fs::remove_file(pw_file);
    }
}

/// 在已建立的会话上执行单条远程 shell 命令，返回 stdout。
/// 每次命令独立创建新的 SSH 连接（无 ControlMaster 复用），
/// 但 ASKPASS 文件由 SshSession 生命周期管理，无需每次重建。
async fn ssh_run(session: &SshSession, remote_cmd: &str) -> Result<String, String> {
    // 每次命令使用独立的空 config 文件（用完即清理）
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut empty_config = std::env::temp_dir();
    empty_config.push(format!(
        "dulog-sshcfg-{}-{}.empty",
        std::process::id(),
        stamp
    ));
    std::fs::write(&empty_config, "").map_err(|e| format!("写入空 config: {e}"))?;

    let mut cmd = TokioCommand::new(&session.ssh_bin);
    cmd.arg("-F")
        .arg(empty_config.to_string_lossy().replace('\\', "/"))
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("UserKnownHostsFile=NUL")
        .arg("-o").arg("ConnectTimeout=15")
        .arg("-o").arg("BatchMode=no")
        .arg("-p").arg(session.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 根据会话认证方式配置本次命令
    match &session.auth {
        SshAuth::Password { askpass, .. } => {
            let askpass_path = askpass.to_string_lossy().replace('\\', "/");
            cmd.env("SSH_ASKPASS", &askpass_path)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env("DISPLAY", ":0");
            cmd.arg("-o").arg("PreferredAuthentications=password")
                .arg("-o").arg("PubkeyAuthentication=no");
        }
        SshAuth::Key { key_path } => {
            let kp = key_path.to_string_lossy().replace('\\', "/");
            cmd.arg("-i").arg(&kp).arg("-o").arg("IdentitiesOnly=yes")
                .arg("-o").arg("PreferredAuthentications=publickey");
        }
        SshAuth::Agent => {
            cmd.arg("-o").arg("PreferredAuthentications=publickey");
        }
    }

    cmd.arg(&session.destination).arg(remote_cmd);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("执行远程命令失败: {e}"))?;

    // 用完立即清理临时空 config
    let _ = std::fs::remove_file(&empty_config);

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("远程命令执行失败: {}", err));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 对远程路径做单引号转义，防止路径中的空格/特殊字符破坏命令。
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
///
/// 不再使用 `wc -lc`（大文件需遍历全部内容，90GB 耗时数分钟）；
/// 改用 `stat -c%s` 瞬时取大小 + 采样首 8KB 估算平均行长推得总行数。
/// 估算值与真实值在均匀日志文件上误差通常 <5%，滚动条仅有微幅偏差。
pub async fn remote_open(session: &SshSession, path: &str) -> Result<(u64, u64), String> {
    let path_q = sh_quote(path);
    // 单次 ssh 命令：stat 取大小 + head 采样首 8KB 统计样本行数/字节数
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
/// 这样高亮范围与本地检索完全一致，且避免把超大文件整份拉回本地。
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
        // grep(ERE) 与 Rust 正则方言存在差异，以客户端 Rust 正则为准：
        // 若 Rust 正则不命中（方言差异导致），丢弃该行，避免误报。
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
