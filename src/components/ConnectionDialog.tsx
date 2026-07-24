import { useState } from "react";
import type { SshConfig, SavedConnection } from "../types";
import { sshConnect } from "../api";
import {
  loadConnections,
  upsertConnection,
  deleteConnection,
} from "../storage";

interface Props {
  onClose: () => void;
  onConnected: (cfg: SshConfig) => void;
  editConnection?: SavedConnection | null;
}

export function ConnectionDialog({ onClose, onConnected, editConnection }: Props) {
  const isEdit = !!editConnection;

  const [host, setHost] = useState(editConnection?.host ?? "");
  const [port, setPort] = useState(editConnection?.port ?? 22);
  const [user, setUser] = useState(editConnection?.user ?? "");
  const [password, setPassword] = useState(editConnection?.password ?? "");
  const [keyPath, setKeyPath] = useState(editConnection?.key_path ?? "");
  const [alias, setAlias] = useState(editConnection?.alias ?? "");
  const [authMethod, setAuthMethod] = useState<"password" | "key">(
    editConnection?.key_path ? "key" : "password"
  );
  const [saveConn, setSaveConn] = useState<boolean>(true);
  const [savePass, setSavePass] = useState(!!editConnection?.password);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedConnection[]>(() =>
    loadConnections()
  );

  function buildCfg(): SshConfig {
    return {
      host,
      port,
      user,
      password: authMethod === "password" && password ? password : undefined,
      key_path: authMethod === "key" && keyPath ? keyPath : undefined,
    };
  }

  async function doConnect(cfg: SshConfig) {
    setBusy(true);
    setError(null);
    try {
      await sshConnect(cfg);
      onConnected(cfg);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function handleConnect() {
    if (!host || !user) {
      setError("主机地址与用户名必填");
      return;
    }
    const cfg = buildCfg();
    if (saveConn || isEdit) {
      const entry: SavedConnection = {
        alias: alias.trim() || `${user}@${host}`,
        host,
        port,
        user,
        key_path: authMethod === "key" && keyPath ? keyPath : undefined,
        password: savePass && password ? password : undefined,
      };
      setSaved(upsertConnection(entry));
    }
    await doConnect(cfg);
  }

  function loadIntoForm(c: SavedConnection) {
    setAlias(c.alias);
    setHost(c.host);
    setPort(c.port);
    setUser(c.user);
    setKeyPath(c.key_path ?? "");
    setPassword(c.password ?? "");
    setAuthMethod(c.key_path ? "key" : "password");
    setSaveConn(true);
    setSavePass(!!c.password);
  }

  async function connectSaved(c: SavedConnection) {
    setBusy(true);
    setError(null);
    try {
      const cfg: SshConfig = {
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        key_path: c.key_path,
      };
      await sshConnect(cfg);
      onConnected(cfg);
    } catch (e) {
      setError(String(e));
      setBusy(false);
      loadIntoForm(c);
    }
  }

  function handleDelete(c: SavedConnection) {
    setSaved(deleteConnection(c));
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? "编辑 SSH 连接" : "新建 SSH 连接"}</h3>
        <p className="hint">
          {isEdit ? "修改连接配置" : "配置 Linux 服务器 SSH 连接参数"}
        </p>

        {error && <div className="form-error">{error}</div>}

        {saved.length > 0 && !isEdit && (
          <div className="saved-block">
            <div className="saved-title">已保存的连接</div>
            <div className="saved-list">
              {saved.map((c) => (
                <div
                  key={`${c.host}:${c.port}:${c.user}`}
                  className="saved-item"
                  onClick={() => loadIntoForm(c)}
                  title="点击填入表单"
                >
                  <div className="saved-main">
                    <div className="saved-alias">{c.alias}</div>
                    <div className="saved-sub">
                      {c.user}@{c.host}:{c.port}
                    </div>
                  </div>
                  <div className="saved-btns">
                    <button
                      className="mini primary"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        connectSaved(c);
                      }}
                    >
                      连接
                    </button>
                    <button
                      className="mini danger"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c);
                      }}
                      title="删除该连接"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <label>名称（别名）</label>
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={`例如 生产服务器-A（留空默认 ${user ? user + "@" + host : "user@host"}）`}
        />

        <label>主机地址 *</label>
        <input
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="例如 192.168.1.10 或 example.com"
        />

        <div className="row2">
          <div>
            <label>端口</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </div>
          <div>
            <label>用户名 *</label>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
            />
          </div>
        </div>

        <label>认证方式</label>
        <div className="auth-method-switch">
          <button
            className={`auth-method-btn${authMethod === "password" ? " active" : ""}`}
            onClick={() => setAuthMethod("password")}
          >
            密码
          </button>
          <button
            className={`auth-method-btn${authMethod === "key" ? " active" : ""}`}
            onClick={() => setAuthMethod("key")}
          >
            私钥
          </button>
        </div>

        {authMethod === "password" ? (
          <>
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空使用密钥/ssh-agent"
            />
          </>
        ) : (
          <>
            <label>私钥路径</label>
            <input
              type="text"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="例如 C:\Users\me\.ssh\id_rsa"
            />
          </>
        )}

        <div className="save-row">
          <label className="chk">
            <input
              type="checkbox"
              checked={saveConn}
              onChange={(e) => setSaveConn(e.target.checked)}
            />
            保存此连接
          </label>
          {authMethod === "password" && (
            <label className="chk">
              <input
                type="checkbox"
                checked={savePass}
                onChange={(e) => setSavePass(e.target.checked)}
              />
              保存密码
            </label>
          )}
        </div>
        {savePass && (
          <div className="save-warn">
            ⚠ 密码将以明文保存，仅建议在可信设备上使用。
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={handleConnect}
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="btn-spinner" />
                连接中…
              </>
            ) : isEdit ? (
              "保存并连接"
            ) : (
              "保存并连接"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
