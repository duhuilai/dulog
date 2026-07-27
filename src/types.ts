export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface FileMeta {
  size: number;
  total_lines: number;
}

export interface LogLine {
  line: number;
  text: string;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchMatch {
  line: number;
  text: string;
  ranges: MatchRange[];
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  elapsed_ms: number;
  scanned_lines: number;
}

export type FileTarget = { type: "local" | "remote"; path: string };

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  key_path?: string;
}

/** 持久化保存的 SSH 连接（存储在本机 localStorage）。 */
export interface SavedConnection {
  alias: string;
  host: string;
  port: number;
  user: string;
  key_path?: string;
  /** 仅当选中"保存密码"时存储，明文保存于本机，仅建议在可信设备使用。 */
  password?: string;
}

/** 编辑器标签页 */
export interface EditorTab {
  id: string;
  title: string;
  /** 标签类型：log=日志文件(只读), text=空白文本(可编辑) */
  type: "log" | "text";
  target?: FileTarget;
  meta?: FileMeta;
  /** 文本编辑器内容（仅 text 类型） */
  content?: string;
  /** 是否有未保存的更改 */
  dirty?: boolean;
  /** 正在加载文件元数据 */
  loading?: boolean;
}

// ===================== 更新检查 =====================

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  body: string;
  download_url: string;
  file_size: number;
  published_at: string;
}

export interface DownloadProgress {
  received: number;
  total: number;
}
