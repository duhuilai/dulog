import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { DownloadProgress, UpdateInfo } from "../types";
import * as api from "../api";

interface Props {
  onClose: () => void;
}

type Stage =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsDialog({ onClose }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [savePath, setSavePath] = useState("");
  const [currentVersion, setCurrentVersion] = useState<string>("");

  // 挂载时获取当前应用版本
  useEffect(() => {
    getVersion()
      .then((v) => setCurrentVersion(v))
      .catch(() => setCurrentVersion(""));
  }, []);

  // ---- 检查更新 ----
  const doCheck = useCallback(async () => {
    setStage("checking");
    setErrorMsg("");
    try {
      const info = await api.checkUpdate(currentVersion || undefined);
      setUpdateInfo(info);
      if (info.has_update) {
        setStage("available");
      } else {
        setStage("up-to-date");
      }
    } catch (e) {
      setErrorMsg(String(e));
      setStage("error");
    }
  }, [currentVersion]);

  // ---- 下载更新 ----
  const doDownload = useCallback(async () => {
    if (!updateInfo) return;
    setStage("downloading");
    setErrorMsg("");
    setProgress(null);

    // 监听进度
    const unlisten = await api.onDownloadProgress((p) => {
      setProgress(p);
    });

    try {
      const path = await api.downloadUpdate(updateInfo.download_url);
      setSavePath(path);
      setStage("downloaded");
    } catch (e) {
      setErrorMsg(String(e));
      setStage("error");
    } finally {
      unlisten();
    }
  }, [updateInfo]);

  // ---- 安装更新 ----
  const doInstall = useCallback(async () => {
    if (!savePath) return;
    setStage("installing");
    try {
      await api.installUpdate(savePath);
      // 安装程序已启动，通知用户
    } catch (e) {
      setErrorMsg(String(e));
      setStage("error");
    }
  }, [savePath]);

  // 计算进度百分比
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.received / progress.total) * 100)
      : 0;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <div className="hint">版本更新 &amp; 关于</div>

        {/* ===== 关于 ===== */}
        <div className="settings-section">
          <div className="settings-label">关于 DuLog</div>
          <div className="settings-row">
            <span>当前版本</span>
            <span className="settings-value">
              {currentVersion ? `v${currentVersion}` : "v—"}
            </span>
          </div>
        </div>

        {/* ===== 检查更新 ===== */}
        <div className="settings-section">
          <div className="settings-label">检查更新</div>

          {/* idle / checking */}
          {(stage === "idle" || stage === "checking") && (
            <button
              className="btn-primary"
              onClick={doCheck}
              disabled={stage === "checking"}
              style={{ width: "100%", marginTop: 8 }}
            >
              {stage === "checking" && <span className="btn-spinner" />}
              {stage === "checking" ? "检查中…" : "检查更新"}
            </button>
          )}

          {/* up-to-date */}
          {stage === "up-to-date" && (
            <div className="update-status success">
              <span className="update-icon">✓</span>
              <div>
                <div className="update-title">已是最新版本</div>
                <div className="update-sub">v{updateInfo?.latest_version}</div>
              </div>
            </div>
          )}

          {/* available */}
          {stage === "available" && updateInfo && (
            <div className="update-card">
              <div className="update-status info">
                <span className="update-icon">↑</span>
                <div>
                  <div className="update-title">发现新版本</div>
                  <div className="update-sub">
                    {updateInfo.latest_version} ·{" "}
                    {formatBytes(updateInfo.file_size)} ·{" "}
                    {updateInfo.published_at.slice(0, 10)}
                  </div>
                </div>
              </div>

              {updateInfo.body && (
                <div className="release-notes">
                  <div className="release-notes-title">更新内容</div>
                  <pre className="release-notes-body">{updateInfo.body}</pre>
                </div>
              )}

              <button
                className="btn-primary"
                onClick={doDownload}
                style={{ width: "100%", marginTop: 10 }}
              >
                下载更新
              </button>
            </div>
          )}

          {/* downloading */}
          {stage === "downloading" && (
            <div className="update-downloading">
              <div className="update-status info">
                <span className="btn-spinner" style={{ display: "inline-block", width: 18, height: 18 }} />
                <div>
                  <div className="update-title">正在下载…</div>
                  <div className="update-sub">
                    {progress
                      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                      : "准备中…"}
                  </div>
                </div>
              </div>

              <div className="progress-bar-track">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="progress-pct">{pct}%</div>
            </div>
          )}

          {/* downloaded */}
          {stage === "downloaded" && (
            <div className="update-card">
              <div className="update-status success">
                <span className="update-icon">✓</span>
                <div>
                  <div className="update-title">下载完成</div>
                  <div className="update-sub" style={{ wordBreak: "break-all" }}>
                    {savePath}
                  </div>
                </div>
              </div>

              <button
                className="btn-primary"
                onClick={doInstall}
                style={{ width: "100%", marginTop: 10 }}
              >
                安装更新
              </button>
            </div>
          )}

          {/* installing */}
          {stage === "installing" && (
            <div className="update-status info">
              <span className="btn-spinner" style={{ display: "inline-block", width: 18, height: 18 }} />
              <div>
                <div className="update-title">启动安装程序…</div>
                <div className="update-sub">
                  请在弹出的安装窗口中完成安装，安装完成后请重新启动应用
                </div>
              </div>
            </div>
          )}

          {/* error */}
          {stage === "error" && (
            <div className="update-status error">
              <span className="update-icon">✗</span>
              <div>
                <div className="update-title">操作失败</div>
                <div className="update-sub">{errorMsg}</div>
              </div>
            </div>
          )}

          {/* error 后可重试 */}
          {stage === "error" && (
            <button
              className="btn-secondary"
              onClick={doCheck}
              style={{ width: "100%", marginTop: 8 }}
            >
              重试
            </button>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
