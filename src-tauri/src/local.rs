use std::cell::{Cell, RefCell};

use memmap2::Mmap;
use regex::Regex;

use crate::{LogLine, MatchRange, SearchMatch, SearchResult};

/// 稀疏行索引间隔：每 4096 行记录一个字节偏移，
/// 读取任意行时从最近检查点向前扫描，避免保存全量行偏移（超大文件也不爆内存）。
/// 检查点在首次读取经过对应行列时按需构建（懒加载）。
pub const CHECKPOINT_INTERVAL: u64 = 4096;

pub struct LocalFile {
    pub path: std::path::PathBuf,
    pub mmap: Mmap,
    /// 懒加载行偏移检查点：第 1 行偏移固定为 0，后续按 CHECKPOINT_INTERVAL
    /// 间隔在首次读取到对应行时构建。使用 RefCell 支持在 read_local 中就地扩展。
    pub checkpoints: RefCell<Vec<u64>>,
    /// 估算总行数。用 Cell 以支持 read_local 读到文件末尾时就地校正（避免估算
    /// 偏小导致虚拟滚动占位高度不足、跳转被浏览器截断）。
    pub total_lines: Cell<u64>,
}

/// 多区域采样估算总行数：仅采样文件开头容易因局部行长度异常导致整体估算
/// 严重偏低（例如开头刚好是几条超长行），故同时采样首部/中部/尾部多个 8KB
/// 区间，取平均行长推算，偏差远小于单点采样。
fn estimate_total_lines(bytes: &[u8]) -> u64 {
    let len = bytes.len();
    if len == 0 {
        return 0;
    }
    const SAMPLE: usize = 8192;
    // 采样区域：开头、1/4、1/2、3/4、末尾
    let anchors = [0usize, len / 4, len / 2, 3 * len / 4, len.saturating_sub(SAMPLE)];
    let mut avg_lens: Vec<f64> = Vec::new();
    for &a in &anchors {
        let end = (a + SAMPLE).min(len);
        if end <= a {
            continue;
        }
        let region = &bytes[a..end];
        let newlines = region.iter().filter(|&&b| b == b'\n').count();
        if newlines > 0 {
            // 该区间平均行长 = 区间字节数 / (换行数 + 1)
            let avg = (end - a) as f64 / (newlines as f64 + 1.0);
            avg_lens.push(avg);
        }
    }
    if avg_lens.is_empty() {
        // 无换行符 → 单行或二进制，保守估计
        return (len as u64 / 200).max(1);
    }
    let mean: f64 = avg_lens.iter().sum::<f64>() / avg_lens.len() as f64;
    // 向下取保守估计（宁可偏大不可偏小，避免占位不足），但给 20% 余量防止极端
    let est = (len as f64 / mean).ceil();
    (est as u64).max(1)
}

/// 打开本地文件，不再预先全量扫描建索引。
/// - 文件大小通过 mmap.len() 瞬时获取（O(1)）
/// - 总行数通过多区域采样估算（O(1)）
/// - 检查点首次读取时按需构建（懒加载）
///
/// 对比旧方案的全量字节扫描（90GB 耗时数分钟），新方案打开时间与文件大小无关。
pub fn open_local(path: &str) -> Result<LocalFile, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mmap = unsafe { Mmap::map(&file).map_err(|e| format!("内存映射失败: {e}"))? };
    let total_lines = estimate_total_lines(&mmap[..]);

    Ok(LocalFile {
        path: std::path::PathBuf::from(path),
        mmap,
        checkpoints: RefCell::new(vec![0]), // 仅行 1 偏移
        total_lines: Cell::new(total_lines),
    })
}

/// 确保检查点已构建至覆盖目标行号。
/// 从最后一个已知检查点向前扫描 CHECPOINT_INTERVAL 行，记录偏移。
fn ensure_checkpoint(f: &LocalFile, target_line: u64) {
    let bytes = &f.mmap[..];
    let len = bytes.len();
    let mut cps = f.checkpoints.borrow_mut();

    // target_line 对应检查点索引: (target_line - 1) / CHECKPOINT_INTERVAL
    let needed_cp = ((target_line - 1) / CHECKPOINT_INTERVAL) as usize;

    while cps.len() <= needed_cp {
        let last_offset = *cps.last().unwrap_or(&0) as usize;
        // 当前已构建的最大行号（每 INTERVAL 行一个检查点）
        let built_line = ((cps.len() - 1) as u64) * CHECKPOINT_INTERVAL + 1;
        let target = built_line + CHECKPOINT_INTERVAL;

        let mut pos = last_offset;
        let mut lno = built_line;

        // 扫描 CHECKPOINT_INTERVAL 行
        while lno < target && pos < len {
            // 跳过当前行
            while pos < len && bytes[pos] != b'\n' {
                pos += 1;
            }
            pos += 1; // 跳过换行符
            lno += 1;
        }
        cps.push(pos as u64);
    }
}

/// 读取 [start, start+count) 行（1-based）。从最近检查点向前扫描，仅返回所需行。
/// 首次访问新区域时自动构建中间检查点。
pub fn read_local(f: &LocalFile, start: u64, count: u64) -> Vec<LogLine> {
    let bytes = &f.mmap[..];
    let len = bytes.len();
    if start < 1 || len == 0 || count == 0 {
        return Vec::new();
    }

    // 确保对应检查点已构建
    ensure_checkpoint(f, start);

    let k = CHECKPOINT_INTERVAL;
    let cps = f.checkpoints.borrow();
    let cp_idx = ((start - 1) / k) as usize;
    let mut pos = if cp_idx < cps.len() {
        cps[cp_idx] as usize
    } else {
        0
    };
    let mut line_no = cp_idx as u64 * k + 1;
    drop(cps);

    // 前进到目标起始行
    while line_no < start && pos < len {
        while pos < len && bytes[pos] != b'\n' {
            pos += 1;
        }
        pos += 1;
        line_no += 1;
    }

    let mut out: Vec<LogLine> = Vec::new();
    while (out.len() as u64) < count && pos < len {
        let mut i = pos;
        while i < len && bytes[i] != b'\n' {
            i += 1;
        }
        let line_bytes = &bytes[pos..i];
        let text = match std::str::from_utf8(line_bytes) {
            Ok(s) => s.trim_end_matches('\r').to_string(),
            Err(_) => format!("[非 UTF-8 行，{} 字节]", line_bytes.len()),
        };
        out.push(LogLine {
            line: line_no,
            text,
        });
        line_no += 1;
        pos = i + 1;
    }

    // 自校正：若本次读取触达文件末尾，则精确已知总行数 = 最后读到的行号。
    // 这会修正 open 阶段可能偏小的估算，避免虚拟滚动占位高度不足。
    if pos >= len && !out.is_empty() {
        let last = out.last().unwrap().line;
        if last > f.total_lines.get() {
            f.total_lines.set(last);
        }
    }

    out
}

/// 流式正则检索：逐行扫描 mmap，命中即记录行号/文本/命中区间。
/// 仅保存命中行（上限 max），未命中行不分配内存，超大文件也不爆内存。
pub fn search_local(f: &LocalFile, re: &Regex, max: u64) -> SearchResult {
    let bytes = &f.mmap[..];
    let len = bytes.len();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut line_no: u64 = 1;
    let mut pos: usize = 0;
    let start_time = std::time::Instant::now();
    let mut truncated = false;
    let mut scanned: u64 = 0;

    while pos < len {
        let mut i = pos;
        while i < len && bytes[i] != b'\n' {
            i += 1;
        }
        let line_bytes = &bytes[pos..i];
        scanned += 1;
        if let Ok(line_str) = std::str::from_utf8(line_bytes) {
            let line_str = line_str.trim_end_matches('\r');
            let mut ranges: Vec<MatchRange> = Vec::new();
            for m in re.find_iter(line_str) {
                ranges.push(MatchRange {
                    start: m.start() as u32,
                    end: m.end() as u32,
                });
            }
            if !ranges.is_empty() {
                matches.push(SearchMatch {
                    line: line_no,
                    text: line_str.to_string(),
                    ranges,
                });
                if matches.len() as u64 >= max {
                    truncated = true;
                    break;
                }
            }
        }
        line_no += 1;
        pos = i + 1;
    }

    SearchResult {
        matches,
        truncated,
        elapsed_ms: start_time.elapsed().as_millis() as u64,
        scanned_lines: scanned,
    }
}
