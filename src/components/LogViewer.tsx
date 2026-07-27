import { useCallback, useEffect, useRef, useState } from "react";
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
/** 强制跳转模式的持续时间（ms），期间完全忽略 scroll 事件 */
const FORCE_SCROLL_MS = 300;

/**
 * 虚拟滚动日志查看器：
 * - 无论文件多大，仅渲染可视区域内的行，常驻内存恒定。
 * - 按需分页向后端请求行内容（懒加载），首次打开即时可用。
 * - 命中检索的行按区间高亮（<mark>），仅可视行参与渲染。
 *
 * 滚动策略：使用「强制覆盖」模式处理程序化跳转。
 *   - 正常滚动：onScroll → setScrollTop → 驱动渲染
 *   - 程序化跳转：setForcedScrollTop(target) + DOM.scrollTop = target
 *     → 渲染用 forcedScrollTop（优先于 scrollTop）
 *     → FORCE_SCROLL_MS 后自动恢复正常模式
 *     → 期间 onScroll 完全忽略，杜绝任何竞态
 */
export function LogViewer({ meta, target, highlights, jump, activeLine }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 用户手动滚动的位置 */
  const [scrollTop, setScrollTop] = useState(0);
  /** 程序化跳转的目标位置（null = 正常模式，非 null = 强制覆盖） */
  const [forcedScrollTop, setForcedScrollTop] = useState<number | null>(null);
  /**
   * 已成功加载的最高行号。后端 total_lines 仅是估算，可能偏小；
   * 用它动态扩展占位高度，确保跳转/滚动到真实存在的行时不被截断。
   */
  const [maxKnownLine, setMaxKnownLine] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [cache, setCache] = useState<Map<number, string>>(new Map());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const loadingRef = useRef<Set<number>>(new Set());
  /** 强制模式的定时器引用 */
  const forceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const total = meta.total_lines;

  // ====== 有效滚动位置：强制模式优先 ======
  const effectiveScrollTop = forcedScrollTop ?? scrollTop;

  // 测量可视高度
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切换文件时清空缓存和强制状态
  useEffect(() => {
    if (forceTimerRef.current) {
      clearTimeout(forceTimerRef.current);
      forceTimerRef.current = null;
    }
    setCache(new Map());
    cacheRef.current = new Map();
    loadingRef.current.clear();
    setScrollTop(0);
    setForcedScrollTop(null);
    setMaxKnownLine(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [target]);

  // ====== 有效总行数：后端估算可能偏小，用已加载最大行号动态扩展 ======
  const effectiveTotal = Math.max(total, maxKnownLine + PAGE * 2);

  // ====== 可视区计算（基于有效滚动位置）======
  const startIdx = Math.max(0, Math.floor(effectiveScrollTop / ROW_H) - 5);
  const visible = Math.ceil(viewportH / ROW_H) + 12;
  const endIdx = Math.min(effectiveTotal, startIdx + visible);

  // ====== 数据加载 ======
  const loadPage = useCallback(
    async (s: number, e: number) => {
      for (let l = s; l <= e; l++) loadingRef.current.add(l);
      try {
        const lines = await readLines(s, e - s + 1);
        setCache((prev) => {
          const next = new Map(prev);
          let maxLine = 0;
          for (const ln of lines) {
            next.set(ln.line, ln.text);
            if (ln.line > maxLine) maxLine = ln.line;
          }
          if (maxLine > 0) setMaxKnownLine((prevMax) => Math.max(prevMax, maxLine));
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

  // ====== 程序化跳转 ======
  useEffect(() => {
    if (!jump || !containerRef.current || total === 0) return;

    const targetLine = Math.max(1, Math.min(jump.line, total));
    const targetScrollTop = (targetLine - 1) * ROW_H;

    // 清除之前的定时器
    if (forceTimerRef.current) clearTimeout(forceTimerRef.current);

    // 1. 进入强制模式：设置覆盖值
    setForcedScrollTop(targetScrollTop);

    // 2. 同步 DOM 滚动位置
    containerRef.current.scrollTop = targetScrollTop;

    // 3. 立即扩展已知最大行号，确保占位高度足以容纳跳转目标（不被浏览器截断）
    setMaxKnownLine((prev) => Math.max(prev, targetLine + PAGE / 2));

    // 4. 立即预加载目标行附近的内容
    const preloadStart = Math.max(1, targetLine - PAGE / 2);
    const preloadEnd = Math.min(total, targetLine + PAGE / 2);
    ensureLoaded(preloadStart, preloadEnd);

    // 4. 延迟退出强制模式，给浏览器足够时间完成所有异步 scroll 事件
    forceTimerRef.current = setTimeout(() => {
      setForcedScrollTop(null);
      forceTimerRef.current = null;
      // 退出时同步 DOM 的最终位置到 state，确保无缝衔接
      if (containerRef.current) {
        setScrollTop(containerRef.current.scrollTop);
      }
    }, FORCE_SCROLL_MS);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, total]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (forceTimerRef.current) clearTimeout(forceTimerRef.current);
    };
  }, []);

  // ====== 滚动事件处理（仅在非强制模式下响应）======
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      // 强制模式下完全忽略 scroll 事件，防止竞态覆盖
      if (forcedScrollTop !== null) return;
      setScrollTop((e.target as HTMLDivElement).scrollTop);
    },
    [forcedScrollTop]
  );

  // ====== 渲染行 ======
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
      onScroll={handleScroll}
    >
      <div className="viewer-spacer" style={{ height: effectiveTotal * ROW_H }}>
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
