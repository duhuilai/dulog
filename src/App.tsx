import { useCallback, useEffect, useState } from "react";
import type {
  FileEntry,
  FileMeta,
  FileTarget,
  EditorTab,
  MatchRange,
  SavedConnection,
  SearchMatch,
  SshConfig,
} from "./types";
import * as api from "./api";
import { loadConnections, upsertConnection, deleteConnection } from "./storage";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { LogViewer } from "./components/LogViewer";
import { TextEditor } from "./components/TextEditor";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { DeleteConfirm } from "./components/DeleteConfirm";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

let tabCounter = 1;

export default function App() {
  // ===== 标签系统 =====
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // ===== 侧栏状态 =====
  // "none" | "local:dir" | "remote:host"
  const [sideMode, setSideMode] = useState<"none" | "local" | "remote">("none");
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const [remoteCwd, setRemoteCwd] = useState<string>("/");
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [sshCfg, setSshCfg] = useState<SshConfig | null>(null);

  // ===== SSH 连接管理 =====
  const [savedConns, setSavedConns] = useState<SavedConnection[]>(() =>
    loadConnections()
  );
  const [showConnDialog, setShowConnDialog] = useState(false);
  const [editConn, setEditConn] = useState<SavedConnection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    conn: SavedConnection;
    x: number;
    y: number;
  } | null>(null);
  const [activeConnIdx, setActiveConnIdx] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // ===== 检索 =====
  const [pattern, setPattern] = useState("");
  const [icase, setIcase] = useState(false);
  const [isRegex, setIsRegex] = useState(true);
  const [searching, setSearching] = useState(false);
  const [highlights, setHighlights] = useState<Map<number, MatchRange[]>>(
    new Map()
  );
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searchInfo, setSearchInfo] = useState("");
  const [matchIdx, setMatchIdx] = useState(-1);
  const [jump, setJump] = useState<{ line: number; nonce: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  // ===== 光标位置 =====
  const [cursorLine, setCursorLine] = useState<number | undefined>(undefined);
  const [cursorCol, setCursorCol] = useState<number | undefined>(undefined);

  const showError = useCallback((e: unknown) => {
    setError(String(e));
    setTimeout(() => setError(null), 6000);
  }, []);

  // ===== 当前活跃标签 =====
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // 切换到非 text 标签时清除光标
  useEffect(() => {
    if (activeTab?.type !== "text") {
      setCursorLine(undefined);
      setCursorCol(undefined);
    }
  }, [activeTab]);

  // ===== 标签操作 =====
  const newTextTab = useCallback(() => {
    const id = `tab-${tabCounter++}`;
    const num = tabs.filter((t) => t.type === "text").length + 1;
    const tab: EditorTab = {
      id,
      title: `未命名-${num}`,
      type: "text",
      content: "",
      dirty: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }, [tabs]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.filter((t) => t.id !== id);
        if (id === activeTabId) {
          if (next.length === 0) {
            setActiveTabId(null);
          } else {
            const newIdx = Math.min(idx, next.length - 1);
            setActiveTabId(next[newIdx].id);
          }
        }
        return next;
      });
    },
    [activeTabId]
  );

  const updateTextTab = useCallback(
    (content: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, content, dirty: true } : t
        )
      );
    },
    [activeTabId]
  );

  // ===== 本地文件 =====
  const pickFolder = useCallback(async () => {
    try {
      const dir = await api.pickFolder();
      if (!dir) return;
      setLocalDir(dir);
      const files = await api.listLocal(dir);
      setLocalFiles(files);
      setSideMode("local");
      setConnected(false);
      setSshCfg(null);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  const openLocal = useCallback(
    async (path: string) => {
      const name = path.split(/[/\\]/).pop() ?? path;
      const target: FileTarget = { type: "local", path };

      // 去重
      const existing = tabs.find(
        (t) => t.type === "log" && t.target?.path === path
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }

      // 立即创建标签（显示文件名，响应即时）
      const id = `tab-${tabCounter++}`;
      const tab: EditorTab = {
        id,
        title: name,
        type: "log",
        target,
        meta: { total_lines: 0, size: 0 },
        loading: true,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(id);
      setHighlights(new Map());
      setMatches([]);
      setSearchInfo("");

      // 后台加载元数据
      try {
        const meta = await api.openFile(target);
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, meta, loading: false } : t))
        );
      } catch (e) {
        setTabs((prev) => prev.filter((t) => t.id !== id));
        showError(e);
      }
    },
    [tabs, showError]
  );

  // ===== SSH 远程 =====
  const connect = useCallback(
    async (cfg: SshConfig) => {
      setShowConnDialog(false);
      setEditConn(null);
      try {
        await api.sshConnect(cfg);
        setSshCfg(cfg);
        setConnected(true);
        setSideMode("remote");
        const cwd = "/";
        setRemoteCwd(cwd);
        const files = await api.remoteList(cwd);
        setRemoteFiles(files);

        // 更新保存列表
        setSavedConns(loadConnections());

        // 查找匹配的连接索引
        const conns = loadConnections();
        const idx = conns.findIndex(
          (c) => c.host === cfg.host && c.port === cfg.port && c.user === cfg.user
        );
        setActiveConnIdx(idx >= 0 ? idx : null);
      } catch (e) {
        showError(e);
      }
    },
    [showError]
  );

  const navigateRemote = useCallback(
    async (path: string) => {
      try {
        const files = await api.remoteList(path);
        setRemoteFiles(files);
        setRemoteCwd(path);
      } catch (e) {
        showError(e);
      }
    },
    [showError]
  );

  const openRemote = useCallback(
    async (path: string) => {
      const name = path.split("/").pop() ?? path;
      const target: FileTarget = { type: "remote", path };

      // 去重
      const existing = tabs.find(
        (t) => t.type === "log" && t.target?.path === path
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }

      // 立即创建标签（显示文件名，响应即时）
      const id = `tab-${tabCounter++}`;
      const tab: EditorTab = {
        id,
        title: name,
        type: "log",
        target,
        meta: { total_lines: 0, size: 0 },
        loading: true,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(id);
      setHighlights(new Map());
      setMatches([]);
      setSearchInfo("");

      // 后台加载元数据
      try {
        const meta = await api.openFile(target);
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, meta, loading: false } : t))
        );
      } catch (e) {
        setTabs((prev) => prev.filter((t) => t.id !== id));
        showError(e);
      }
    },
    [tabs, showError]
  );

  const disconnect = useCallback(() => {
    setConnected(false);
    setSshCfg(null);
    setRemoteFiles([]);
    setRemoteCwd("/");
    setSideMode("none");
    setActiveConnIdx(null);
  }, []);

  // ===== SSH 连接操作 =====
  const handleConnectSaved = useCallback(
    async (conn: SavedConnection) => {
      try {
        const cfg: SshConfig = {
          host: conn.host,
          port: conn.port,
          user: conn.user,
          password: conn.password,
          key_path: conn.key_path,
        };
        await connect(cfg);
      } catch (e) {
        showError(e);
      }
    },
    [connect, showError]
  );

  const handleEditConn = useCallback(
    (conn: SavedConnection, e: React.MouseEvent) => {
      e.stopPropagation();
      setEditConn(conn);
      setShowConnDialog(true);
    },
    []
  );

  const handleDeleteClick = useCallback(
    (conn: SavedConnection, e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      setDeleteTarget({
        conn,
        x: rect.left - 220,
        y: rect.top - 80,
      });
    },
    []
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    setSavedConns(deleteConnection(deleteTarget.conn));
    if (
      connected &&
      sshCfg &&
      sshCfg.host === deleteTarget.conn.host &&
      sshCfg.port === deleteTarget.conn.port
    ) {
      disconnect();
    }
    setDeleteTarget(null);
  }, [deleteTarget, connected, sshCfg, disconnect]);

  // ===== 新建/编辑连接 =====
  const handleNewConn = useCallback(() => {
    setEditConn(null);
    setShowConnDialog(true);
  }, []);

  // ===== 检索 =====
  const doSearch = useCallback(async () => {
    if (!activeTab || activeTab.type !== "log" || !pattern) return;
    setSearching(true);
    try {
      const res = await api.searchLogs(pattern, icase, isRegex, 20000);
      const map = new Map<number, MatchRange[]>();
      for (const m of res.matches) map.set(m.line, m.ranges);
      setHighlights(map);
      setMatches(res.matches);
      setMatchIdx(-1);
      setSearchInfo(
        `${res.matches.length} / ${formatLines(res.scanned_lines)}${
          res.truncated ? " (已截断)" : ""
        }`
      );
      if (res.matches.length > 0) {
        setJump({ line: res.matches[0].line, nonce: Date.now() });
        setMatchIdx(0);
      }
    } catch (e) {
      showError(e);
    } finally {
      setSearching(false);
    }
  }, [activeTab, pattern, icase, isRegex, showError]);

  const navigateMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const next = matchIdx < 0 ? 0 : matchIdx + dir;
      if (next < 0 || next >= matches.length) return;
      setMatchIdx(next);
      setJump({ line: matches[next].line, nonce: Date.now() });
    },
    [matches, matchIdx]
  );

  const onPickMatch = useCallback(
    (m: SearchMatch, idx: number) => {
      setMatchIdx(idx);
      setJump({ line: m.line, nonce: Date.now() });
    },
    []
  );

  // ===== 导出结果 =====
  const exportResults = useCallback(() => {
    if (matches.length === 0) return;
    const text = matches
      .map((m) => `L${m.line}: ${m.text}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dulog-search-results.txt";
    a.click();
    URL.revokeObjectURL(url);
  }, [matches]);

  // ===== 当前状态栏信息 =====
  const statusDirty = activeTab?.dirty ?? false;
  const statusFileType =
    !activeTab
      ? "就绪"
      : activeTab.type === "text"
        ? "纯文本"
        : "日志文件";
  const statusLines = activeTab?.meta?.total_lines;
  const statusSize = activeTab?.meta?.size;

  return (
    <div className="app">
      {/* ====== 顶栏 ====== */}
      <header className="topbar">
        <div className="brand">DuLog</div>
        <button
          className="btn-settings"
          title="设置"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
        <button
          className="btn-toggle"
          title="SSH 诊断"
          onClick={async () => {
            try {
              const result = await api.sshDiag("192.168.5.66", 22, "root", "Zkpd@123");
              setError(result);
            } catch (e) {
              setError(String(e));
            }
          }}
          style={{ fontSize: 11, padding: "2px 8px", width: "auto", marginLeft: 8 }}
        >
          🔍 诊断
        </button>
        {activeTab && activeTab.type === "log" && (
          <div className="search-toolbar" style={{ marginLeft: "auto", border: "none", background: "none", padding: 0 }}>
            <input
              className="search-input"
              value={pattern}
              placeholder="输入检索文本或正则…"
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) navigateMatch(-1);
                  else doSearch();
                }
                if (e.key === "Escape") {
                  setPattern("");
                  setHighlights(new Map());
                  setMatches([]);
                }
              }}
            />
            {matches.length > 0 && (
              <span className="search-count">
                {matchIdx >= 0 ? matchIdx + 1 : 0} / {matches.length}
              </span>
            )}
            <button
              className={`btn-toggle${icase ? " on" : ""}`}
              onClick={() => setIcase(!icase)}
              title="忽略大小写"
            >
              Aa
            </button>
            <button
              className={`btn-toggle${isRegex ? " on" : ""}`}
              onClick={() => setIsRegex(!isRegex)}
              title="正则表达式"
            >
              .*
            </button>
            <button
              className="btn-toggle"
              onClick={() => navigateMatch(-1)}
              title="上一处 (Shift+Enter)"
            >
              ↑
            </button>
            <button
              className="btn-toggle"
              onClick={() => navigateMatch(1)}
              title="下一处 (Enter)"
            >
              ↓
            </button>
            <span className="search-hint">
              {searching ? "检索中…" : "回车搜索 · Shift+回车上一处 · Esc 关闭"}
            </span>
          </div>
        )}
      </header>

      {/* ====== 主体 ====== */}
      <div className="body">
        {/* ---- 左栏 ---- */}
        <aside className="sidebar">
          {/* SSH 连接区 */}
          <div className="side-ssh-section">
            <div className="side-section-title">SSH 连接</div>
            <button className="btn-new-ssh" onClick={handleNewConn}>
              + 新建 SSH 连接
            </button>
            <div className="conn-list">
              {savedConns.map((c, idx) => (
                <div
                  key={`${c.host}:${c.port}:${c.user}`}
                  className={`conn-item${activeConnIdx === idx ? " active" : ""}`}
                >
                  <span
                    className={`conn-dot${
                      connected &&
                      sshCfg?.host === c.host &&
                      sshCfg?.port === c.port
                        ? " online"
                        : " offline"
                    }`}
                  />
                  <span className="conn-name" title={`${c.user}@${c.host}:${c.port}`}>
                    {c.alias}
                  </span>
                  <button
                    className="conn-connect-btn"
                    title="连接"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnectSaved(c);
                    }}
                  >
                    连接
                  </button>
                  <div className="conn-actions">
                    <button
                      className="conn-action-btn edit"
                      title="编辑"
                      onClick={(e) => handleEditConn(c, e)}
                    >
                      ✎
                    </button>
                    <button
                      className="conn-action-btn delete"
                      title="删除"
                      onClick={(e) => handleDeleteClick(c, e)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              {savedConns.length === 0 && (
                <div className="empty" style={{ padding: "10px 12px" }}>
                  暂无保存的连接
                </div>
              )}
            </div>
          </div>

          {/* 本地文件夹区 */}
          <div className="side-local-section">
            <div className="side-section-title">本地</div>
            <button className="side-action" onClick={pickFolder}>
              📁 选择日志文件夹
            </button>
          </div>

          {/* 文件树 */}
          {sideMode !== "none" && (
            <div className="filelist">
              {sideMode === "local" && localDir && (
                <div className="side-path" title={localDir}>
                  {localDir}
                </div>
              )}
              {sideMode === "remote" && (
                <>
                  <div className="conn-info">
                    <span>
                      {sshCfg?.user}@{sshCfg?.host}:{sshCfg?.port}
                    </span>
                    <button className="link" onClick={disconnect}>
                      断开
                    </button>
                  </div>
                  <div className="side-path" title={remoteCwd}>
                    {remoteCwd}
                  </div>
                  <button
                    className="btn-back"
                    onClick={() => {
                      if (remoteCwd === "/") return;
                      const parent =
                        remoteCwd.split("/").slice(0, -1).join("/") ||
                            "/";
                      navigateRemote(parent);
                    }}
                    disabled={remoteCwd === "/"}
                  >
                    ⬆ 返回上级
                  </button>
                </>
              )}

              {(sideMode === "local" ? localFiles : remoteFiles).map((f) => (
                <div
                  key={f.path}
                  className="fileitem"
                  onClick={() =>
                    f.is_dir
                      ? sideMode === "remote"
                        ? navigateRemote(f.path)
                        : undefined
                      : sideMode === "local"
                        ? openLocal(f.path)
                        : openRemote(f.path)
                  }
                >
                  <span className="fname">
                    {f.is_dir ? "📂 " : "📄 "}
                    {f.name}
                  </span>
                  {!f.is_dir && (
                    <span className="fsize">{formatBytes(f.size)}</span>
                  )}
                </div>
              ))}
              {(sideMode === "local" ? localFiles : remoteFiles).length === 0 &&
                (sideMode === "local" ? localDir : connected) && (
                  <div className="empty">该目录无 .log/.txt/.out 文件</div>
                )}
            </div>
          )}
        </aside>

        {/* ---- 主区域 ---- */}
        <main className="main">
          {/* 标签栏 */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onNewText={newTextTab}
          />

          {/* 编辑器区域 */}
          <div className="editor-area">
            {!activeTab ? (
              <div className="placeholder">
                请从左侧选择本地或远程日志文件，或点击「+ 新建空白文本」
              </div>
            ) : activeTab.type === "text" ? (
              <TextEditor
                content={activeTab.content ?? ""}
                onChange={updateTextTab}
                onCursorChange={(ln, col) => {
                  setCursorLine(ln);
                  setCursorCol(col);
                }}
              />
            ) : activeTab.loading ? (
              <div className="placeholder">
                <span style={{ fontSize: 20, marginRight: 8 }}>⏳</span>
                正在加载 {activeTab.title}… {activeTab.meta?.size ? `(${formatBytes(activeTab.meta.size)})` : ""}
              </div>
            ) : (
              <>
                <LogViewer
                  meta={activeTab.meta!}
                  target={activeTab.target!}
                  highlights={highlights}
                  jump={jump}
                  activeLine={matchIdx >= 0 ? matches[matchIdx]?.line : undefined}
                />
                {matches.length > 0 && (
                  <div className="matchpanel">
                    <div className="match-head">
                      <span>搜索结果 · {matches.length} 处</span>
                      <button className="match-export" onClick={exportResults}>
                        导出结果
                      </button>
                    </div>
                    <div className="match-list">
                      {matches.map((m, i) => (
                        <div
                          key={i}
                          className={`match-item${matchIdx === i ? " selected" : ""}`}
                          onClick={() => onPickMatch(m, i)}
                        >
                          <span className="mln">L{m.line}</span>
                          <span className="mlt">
                            {m.text.length > 120
                              ? m.text.slice(0, 120) + "…"
                              : m.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* ====== 底部状态栏 ====== */}
      <StatusBar
        lineCount={statusLines}
        fileSize={statusSize}
        fileType={statusFileType}
        dirty={statusDirty}
        cursorLine={activeTab?.type === "text" ? cursorLine : undefined}
        cursorCol={activeTab?.type === "text" ? cursorCol : undefined}
      />

      {/* ====== 弹窗 ====== */}
      {showConnDialog && (
        <ConnectionDialog
          onClose={() => {
            setShowConnDialog(false);
            setEditConn(null);
          }}
          onConnected={connect}
          editConnection={editConn}
        />
      )}

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}

      {deleteTarget && (
        <DeleteConfirm
          name={deleteTarget.conn.alias}
          x={deleteTarget.x}
          y={deleteTarget.y}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {searching && (
        <div className="modal-mask" style={{ background: "rgba(0,0,0,0.2)" }}>
          <div className="loading-modal">
            <span className="btn-spinner" />
            <span>检索中…</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatLines(n: number): string {
  if (n < 10000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}
