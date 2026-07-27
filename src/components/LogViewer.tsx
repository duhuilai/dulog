import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileTarget, MatchRange } from "../types";
import { readLines } from "../api";

interface Props {
  meta: { size: number; total_lines: number };
  target: FileTarget;
  highlights: Map<number, MatchRange[]>;
  jump: { line: number; nonce: number } | null;
  activeLine?: number;
}

const ROW_H = 22; // 单行像素高度
const PAGE = 500; // 每次向后端请求的连续行数

/**
 * 虚拟滚动日志查看器：
 * - 无论文件多大，仅渲染可视区域内的行，常驻内存恒定。
 * - 按需分页向后端请求行内容（懒加载），首次打开即时可用。
 * - 命中检索的行按区间高亮（<mark>），仅可视行参与渲染。
 */
export function LogViewer({ meta, target, highlights, jump, activeLine }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [cache, setCache] = useState<Map<number, string>>(new Map());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const loadingRef = useRef<Set<number>>(new Set());
  /** 跳转期间阻止 onScroll 覆盖 scrollTop state */
  const jumpingRef = useRef(false);

  const total = meta.total_lines;

  // 测量可视高度
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切换文件时清空缓存
  useEffect(() => {
    setCache(new Map());
    cacheRef.current = new Map();
    loadingRef.current.clear();
    setScrollTop(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [target]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const visible = Math.ceil(viewportH / ROW_H) + 12;
  const endIdx = Math.min(total, startIdx + visible);

  const loadPage = useCallback(
    async (s: number, e: number) => {
      for (let l = s; l <= e; l++) loadingRef.current.add(l);
      try {
        const lines = await readLines(s, e - s + 1);
        setCache((prev) => {
          const next = new Map(prev);
          for (const ln of lines) next.set(ln.line, ln.text);
          return next;
        });
      } catch (err) {
        console.error("读取行失败:", err);
      } finally {
        for (let l = s; l <= e; l++) loadingRef.current.delete(l);
      }
    },
    [target]
  );

  const ensureLoaded = useCallback(
    (from: number, to: number) => {
      for (let p = from; p <= to; p += PAGE) {
        const s = p;
        const e = Math.min(p + PAGE - 1, to);
        let need = false;
        for (let l = s; l <= e; l++) {
          if (!cacheRef.current.has(l) && !loadingRef.current.has(l)) {
            need = true;
            break;
          }
        }
        if (need) loadPage(s, e);
      }
    },
    [loadPage]
  );

  // 可视区行按需加载
  useEffect(() => {
    if (total === 0) return;
    ensureLoaded(startIdx + 1, endIdx);
  }, [startIdx, endIdx, total, ensureLoaded]);

  // 跳转到指定行：用 useLayoutEffect 同步 DOM 改动 + jumpingRef 阻止 onScroll 覆盖
  useLayoutEffect(() => {
    if (!jump || !containerRef.current || total === 0) return;

    const targetLine = Math.max(1, Math.min(jump.line, total));
    const targetScrollTop = (targetLine - 1) * ROW_H;

    // 启用跳转标记，阻止 onScroll 覆盖
    jumpingRef.current = true;
    containerRef.current.scrollTop = targetScrollTop;
    setScrollTop(targetScrollTop);

    // 预加载目标区域内容
    const preloadStart = Math.max(1, targetLine - PAGE / 2);
    const preloadEnd = Math.min(total, targetLine + PAGE / 2);
    ensureLoaded(preloadStart, preloadEnd);

    // 下一个 rAF 中释放标记（此时 scroll 事件已经处理完毕）
    requestAnimationFrame(() => {
      jumpingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, total]);

  const rows = [];
  for (let l = startIdx + 1; l <= endIdx; l++) {
    const text = cache.get(l);
    rows.push(
      <LogRow
        key={l}
        line={l}
        text={text ?? ""}
        loaded={text !== undefined}
        ranges={highlights.get(l)}
        isActive={l === activeLine}
      />
    );
  }

  return (
    <div
      className="viewer"
      ref={containerRef}
      onScroll={(e) => {
        if (jumpingRef.current) return;
        setScrollTop((e.target as HTMLDivElement).scrollTop);
      }}
    >
      <div className="viewer-spacer" style={{ height: total * ROW_H }}>
        <div
          className="viewer-rows"
          style={{ transform: `translateY(${startIdx * ROW_H}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}

function LogRow({
  line,
  text,
  loaded,
  ranges,
  isActive,
}: {
  line: number;
  text: string;
  loaded: boolean;
  ranges?: MatchRange[];
  isActive?: boolean;
}) {
  return (
    <div className={`log-row${isActive ? " active-line" : ""}`} style={{ height: ROW_H }}>
      <span className="ln">{line}</span>
      <span className="lt">
        {!loaded ? (
          <span className="loading">加载中…</span>
        ) : ranges && ranges.length > 0 ? (
          highlight(text, ranges)
        ) : (
          text
        )}
      </span>
    </div>
  );
}

function highlight(text: string, ranges: MatchRange[]) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(text.slice(cursor, r.start));
    parts.push(
      <mark key={i} className="hl">
        {text.slice(r.start, r.end)}
      </mark>
    );
    cursor = r.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
