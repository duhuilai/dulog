import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type {
  FileEntry,
  FileMeta,
  FileTarget,
  LogLine,
  SearchResult,
  SshConfig,
  UpdateInfo,
  DownloadProgress,
} from "./types";

/** 调起系统原生文件夹选择框（Windows 资源管理器）。 */
export function pickFolder(): Promise<string | null> {
  return open({ directory: true, multiple: false }) as Promise<string | null>;
}

export const listLocal = (dir: string, recursive = true) =>
  invoke<FileEntry[]>("list_local_cmd", { dir, recursive });

export const sshConnect = (cfg: SshConfig) =>
  invoke<void>("ssh_connect", {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password ?? null,
    key_path: cfg.key_path ?? null,
  });

export const remoteList = (path: string) =>
  invoke<FileEntry[]>("remote_list", { path });

export const openFile = (target: FileTarget) =>
  invoke<FileMeta>("open_file", { target });

export const readLines = (start: number, count: number) =>
  invoke<LogLine[]>("read_lines", { start, count });

export const searchLogs = (
  pattern: string,
  icase: boolean,
  isRegex: boolean,
  max: number
) =>
  invoke<SearchResult>("search", {
    pattern,
    icase,
    isRegex: isRegex,
    max,
  });

export const sshDiag = (host: string, port: number, user: string, password: string) =>
  invoke<string>("ssh_diag", { host, port, user, password });

/** 保存文件到本地：弹出保存对话框 */
export async function saveToFile(content: string): Promise<string | null> {
  const path = await save({
    title: "保存为…",
    defaultPath: "未命名.txt",
    filters: [
      { name: "文本文件", extensions: ["txt", "log", "out"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (!path) return null;
  await invoke<void>("save_file", { path, content });
  return path;
}

// ===================== 更新检查 =====================

/** 检查 GitHub 是否有新版本（传入当前版本号，确保与 tauri.conf.json 一致） */
export const checkUpdate = (currentVersion?: string) =>
  invoke<UpdateInfo>("check_update", { currentVer: currentVersion ?? null });

/** 下载更新文件，返回保存路径。下载过程中通过 "download-progress" 事件推送进度。 */
export const downloadUpdate = (downloadUrl: string) =>
  invoke<string>("download_update", { downloadUrl });

/** 打开下载的安装包 */
export const installUpdate = (filePath: string) =>
  invoke<void>("install_update", { filePath });

/** 监听下载进度事件 */
export const onDownloadProgress = (
  callback: (progress: DownloadProgress) => void
) => {
  const unlisten = listen<DownloadProgress>("download-progress", (event) => {
    callback(event.payload);
  });
  return unlisten;
};
