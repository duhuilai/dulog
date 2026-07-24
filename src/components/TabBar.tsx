import type { EditorTab } from "../types";

interface Props {
  tabs: EditorTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewText: () => void;
}

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNewText }: Props) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`tab-item${isActive ? " active" : ""}`}
            onClick={() => onSelect(tab.id)}
            title={tab.title}
          >
            <span>{tab.title}</span>
            {tab.loading && (
              <span className="tab-spinner" title="加载中…">⏳</span>
            )}
            {tab.dirty ? (
              <span
                className="tab-dot"
                title="未保存的更改"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ●
              </span>
            ) : (
              <button
                className="tab-close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button className="tab-add" onClick={onNewText}>
        + 新建空白文本
      </button>
    </div>
  );
}
