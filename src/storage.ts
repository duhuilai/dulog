import type { SavedConnection } from "./types";

const KEY = "dulog.ssh.connections";

function keyOf(c: SavedConnection): string {
  return `${c.host}:${c.port}:${c.user}`;
}

export function loadConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as SavedConnection[];
  } catch {
    return [];
  }
}

function persist(list: SavedConnection[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/**
 * 以 host:port:user 作为去重键：
 * - 已存在则更新（若新条目未填写密码但旧条目有，则保留旧密码）；
 * - 不存在则追加。
 * 返回最新列表。
 */
export function upsertConnection(entry: SavedConnection): SavedConnection[] {
  const list = loadConnections();
  const idx = list.findIndex((c) => keyOf(c) === keyOf(entry));
  if (idx >= 0) {
    const existing = list[idx];
    const merged: SavedConnection = {
      ...entry,
      password:
        entry.password && entry.password.length > 0
          ? entry.password
          : existing.password,
    };
    list[idx] = merged;
  } else {
    list.push(entry);
  }
  persist(list);
  return list;
}

export function deleteConnection(entry: SavedConnection): SavedConnection[] {
  const next = loadConnections().filter((c) => keyOf(c) !== keyOf(entry));
  persist(next);
  return next;
}
