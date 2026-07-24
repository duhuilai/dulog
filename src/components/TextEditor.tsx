import { useCallback, useEffect, useRef, useState } from "react";
import { saveToFile } from "../api";

interface Props {
  content: string;
  onChange: (content: string) => void;
  onCursorChange?: (line: number, col: number) => void;
}

const ROW_H = 22;
const GUTTER_W = 50;

/**
 * 高级文本编辑器（类 Notepad++ 体验）：
 * - 行号栏 / 编辑区域分离，滚动同步
 * - Tab 缩进、Shift+Tab 减少缩进、Enter 自动继承缩进
 * - 当前行高亮 + 光标行列位置追踪
 */
export function TextEditor({ content, onChange, onCursorChange }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [wrap, setWrap] = useState(false);

  const lines = content ? content.split("\n") : [""];
  const lineCount = lines.length;

  /** 从 textarea 选取位置计算行列 */
  const updateCursor = useCallback(
    (ta: HTMLTextAreaElement) => {
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const ln = (before.match(/\n/g) || []).length + 1;
      const lastLF = before.lastIndexOf("\n");
      const col = pos - (lastLF + 1) + 1;
      setCursorLine(ln);
      setCursorCol(col);
      onCursorChange?.(ln, col);
    },
    [onCursorChange],
  );

  /** 同步行号栏滚动 */
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const g = gutterRef.current;
    if (ta && g) {
      g.scrollTop = ta.scrollTop;
    }
  }, []);

  // 键盘事件处理
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (e.shiftKey) {
          // Shift+Tab：减少缩进
          const before = ta.value.slice(0, start);
          const lineStart = before.lastIndexOf("\n") + 1;
          const line = ta.value.slice(lineStart, end);
          const dedented = line
            .split("\n")
            .map((l) => (l.startsWith("\t") ? l.slice(1) : l.startsWith("    ") ? l.slice(4) : l))
            .join("\n");
          if (dedented !== line) {
            const newVal = ta.value.slice(0, lineStart) + dedented + ta.value.slice(end);
            const removed = start - lineStart < 4 ? start - lineStart : (start - lineStart > 0 && ta.value[lineStart] === "\t" ? 1 : 4);
            // Actually calculate removed chars more carefully for multi-line case
            const firstLinePre = ta.value.slice(lineStart, start);
            const firstChar = ta.value[lineStart] || "";
            let rmFirst = 0;
            if (firstChar === "\t") rmFirst = 1;
            else if (ta.value.slice(lineStart, lineStart + 4) === "    ") rmFirst = 4;
            const actualRemoved = start - lineStart >= rmFirst ? rmFirst : 0;
            onChange(newVal);
            const newPos = Math.max(lineStart, start - actualRemoved - (line.length - dedented.length));
            requestAnimationFrame(() => {
              ta.selectionStart = newPos;
              ta.selectionEnd = newPos;
              updateCursor(ta);
            });
          }
        } else {
          // Tab：插入制表符
          const newVal = ta.value.slice(0, start) + "\t" + ta.value.slice(end);
          onChange(newVal);
          requestAnimationFrame(() => {
            ta.selectionStart = start + 1;
            ta.selectionEnd = start + 1;
            updateCursor(ta);
          });
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const start = ta.selectionStart;
        const before = ta.value.slice(0, start);
        const lineStart = before.lastIndexOf("\n") + 1;
        const currentLine = ta.value.slice(lineStart, start);
        // 继承当前行缩进
        const indent = currentLine.match(/^(\t|    )*/)?.[0] || "";
        // C-like 大括号自动额外缩进
        let extra = "";
        if (currentLine.trimEnd().endsWith("{") || currentLine.trimEnd().endsWith("(")) {
          extra = "\t";
        }
        const insert = "\n" + indent + extra;
        const newVal = ta.value.slice(0, start) + insert + ta.value.slice(ta.selectionEnd);
        onChange(newVal);
        const newPos = start + insert.length;
        requestAnimationFrame(() => {
          ta.selectionStart = newPos;
          ta.selectionEnd = newPos;
          updateCursor(ta);
        });
        return;
      }

      // 闭合括号配对：输入 } 时自动匹配上一行的缩进级别
      if (e.key === "}" && e.shiftKey === false && e.ctrlKey === false && e.metaKey === false) {
        const start = ta.selectionStart;
        const before = ta.value.slice(0, start);
        const lineStart = before.lastIndexOf("\n") + 1;
        const currentLine = ta.value.slice(lineStart, start);
        // 仅当光标前只有空白时进行缩进修正
        if (/^\s*$/.test(currentLine)) {
          // 查找匹配的 { 所在行的缩进
          let depth = 1;
          let idx = lineStart - 2;
          while (idx >= 0 && depth > 0) {
            if (ta.value[idx] === "{") depth--;
            else if (ta.value[idx] === "}") depth++;
            idx--;
          }
          if (depth === 0) {
            const matchLineStart = ta.value.lastIndexOf("\n", idx) + 1;
            const matchIndent = ta.value.slice(matchLineStart, idx + 1).match(/^(\t|    )*/)?.[0] || "";
            // 缩进一致（不额外-1，因为闭合的是同一层级）
            const dedented = matchIndent.slice(1);
            const newIndent = matchIndent.length > 0 ? matchIndent.slice(matchIndent.startsWith("\t") ? 1 : 4) : "";
            const newVal = ta.value.slice(0, lineStart) + newIndent + "}" + ta.value.slice(ta.selectionEnd);
            onChange(newVal);
            requestAnimationFrame(() => {
              ta.selectionStart = lineStart + newIndent.length + 1;
              ta.selectionEnd = lineStart + newIndent.length + 1;
              updateCursor(ta);
            });
            return;
          }
        }
      }
    };

    ta.addEventListener("keydown", onKeyDown);
    return () => ta.removeEventListener("keydown", onKeyDown);
  }, [onChange, updateCursor]);

  // 自动聚焦
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Ctrl+S / Cmd+S 保存
  useEffect(() => {
    const onSave = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveToFile(content);
      }
    };
    document.addEventListener("keydown", onSave);
    return () => document.removeEventListener("keydown", onSave);
  }, [content]);

  const handleSaveClick = useCallback(() => {
    saveToFile(content);
  }, [content]);

  return (
    <div className="text-editor" style={{ display: "flex", overflow: "hidden" }}>
      {/* 行号栏 */}
      <div
        className="editor-gutter"
        ref={gutterRef}
        style={{
          width: GUTTER_W + 10,
          flex: "none",
          overflow: "hidden",
          background: "var(--panel)",
          borderRight: "1px solid var(--border)",
          paddingTop: 0,
          userSelect: "none",
          textAlign: "right",
          fontFamily: "inherit",
          fontSize: "11.5px",
          lineHeight: ROW_H + "px",
          color: "#b6bcc6",
        }}
      >
        {lines.map((_, i) => (
          <div
            key={i}
            style={{
              height: ROW_H,
              lineHeight: ROW_H + "px",
              paddingRight: 10,
              background: i + 1 === cursorLine ? "var(--editor-line-active)" : "transparent",
              color: i + 1 === cursorLine ? "#888" : undefined,
            }}
          >
            {i + 1}
          </div>
        ))}
      </div>

      {/* 编辑区 */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* 顶部迷你工具栏 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            background: "var(--panel)",
            borderBottom: "1px solid var(--border)",
            fontSize: 11.5,
            lineHeight: "20px",
          }}
        >
          <button
            className="btn-toggle"
            onClick={handleSaveClick}
            title="保存到本地 (Ctrl+S)"
            style={{ fontSize: 11, padding: "1px 6px" }}
          >
            💾
          </button>
          <button
            className={`btn-toggle${wrap ? " on" : ""}`}
            onClick={() => setWrap(!wrap)}
            title="自动换行"
            style={{ fontSize: 11, padding: "1px 6px" }}
          >
            ↲
          </button>
          <span style={{ color: "var(--muted)", marginLeft: 6 }}>
            Ln {cursorLine}, Col {cursorCol}
          </span>
        </div>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            onChange(e.target.value);
            updateCursor(e.target);
          }}
          onClick={() => {
            const ta = textareaRef.current;
            if (ta) requestAnimationFrame(() => updateCursor(ta));
          }}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow") || e.key === "End" || e.key === "Home" || e.key === "PageUp" || e.key === "PageDown") {
              updateCursor(e.target as HTMLTextAreaElement);
            }
          }}
          onScroll={syncScroll}
          placeholder="在此输入文本…"
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          style={{
            width: "100%",
            height: "calc(100% - 25px)",
            border: "none",
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            fontSize: "13px",
            lineHeight: ROW_H + "px",
            padding: 0,
            paddingLeft: 10,
            margin: 0,
            background: "transparent",
            color: "var(--text)",
            whiteSpace: wrap ? "pre-wrap" : "pre",
            overflowX: wrap ? "hidden" : "auto",
            overflowY: "auto",
            tabSize: 4,
          }}
        />
      </div>
    </div>
  );
}
