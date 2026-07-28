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
 * 占位元素（spacer）的最大物理高度。
 *
 * 关键限制：Chromium/WebView2 对单个 DOM 元素的高度有硬上限
 * （LayoutUnit = int32/64 ≈ 33,554,432px）。按 22px 行高计算，
 * 超过 1,525,201 行后 spacer 高度会被浏览器静默 clamp，
 * scrollTop 永远无法超过该位置 —— 这就是"卡在 1525202 行"的根因。
 *
 * 解决方案：spacer 高度封顶在 30,000,000px（安全余量），当虚拟总高度
 * 超过该值时，用比例系数 scale 在「物理滚动位置」和「虚拟行位置」之间
 * 做线性映射，从而支持任意行数（1 亿行也没问题）。
 */
const MAX_SPACER_PX = 30_000_000;

/**
 * 虚拟滚动日志查看器：
 * - 无论文件多大，仅渲染可视区域内的行，常驻内存恒定。
 * - 按需分页向后端请求行内容（懒加载），首次打开即时可用。
 * - 命中检索的行按区间高亮（<mark>），仅可视行参与渲染。
 *
 * 坐标系说明：
 * - 物理坐标（physical）：DOM 真实的 scrollTop / spacer 高度，受浏览器上限约束。
 * - 虚拟坐标（virtual）：行号 × ROW_H，可以任意大。
 * - scale = 虚拟可滚动高度 / 物理可滚动高度（≥1）。行数不超限时 scale=1，两坐标系重合。
 *
 * 滚动策略：使用「强制覆盖」模式处理程序化跳转。
 *   - 正常滚动：onScroll → setScrollTop(物理) → ×scale → 虚拟位置 → 驱动渲染
 *   - 程序化跳转：setForcedVirtualTop(虚拟目标) + DOM.scrollTop = 虚拟目标/scale
 *     → 渲染用 forcedVirtualTop（优先于 scrollTop）
 *     → FORCE_SCROLL_MS 后自动恢复正常模式
 *     → 期间 onScroll 完全忽略，杜绝任何竞态
 */
export function LogViewer({ meta, target, highlights, jump, activeLine }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 用户手动滚动的位置（物理坐标） */
  const [scrollTop, setScrollTop] = useState(0);
  /** 程序化跳转的目标位置（虚拟坐标；null = 正常模式，非 null = 强制覆盖） */
  const [forcedVirtualTop, setForcedVirtualTop] = useState<number | null>(null);
  /**
   * 已成功加载的最高行号。后端 total_lines 仅是估算，可能偏小；
   * 用它动态扩展虚拟总高度，确保跳转/滚动到真实存在的行时不被截断。
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
    setForcedVirtualTop(null);
    setMaxKnownLine(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [target]);

  // ====== 有效总行数：后端估算可能偏小，用「已加载最大行号 + 余量」动态扩展 ======
  // 始终保留 PAGE*4 行余量，确保滚动到底部附近时仍能继续向下扩展（无限滚动）。
  const effectiveTotal = Math.max(total, maxKnownLine) + PAGE * 4;

  // ====== 物理/虚拟坐标映射 ======
  const virtualHeight = effectiveTotal * ROW_H; // 虚拟总高度（可任意大）
  const spacerH = Math.min(virtualHeight, MAX_SPACER_PX); // 物理 spacer 高度（受限）
  // 两个坐标系的「可滚动距离」之比。行数不超限时 = 1。
  const scale =
    virtualHeight > spacerH
      ? Math.max(1, (virtualHeight - viewportH) / Math.max(1, spacerH - viewportH))
      : 1;
  // 回调（rAF/setTimeout/onScroll）中需要最新 scale，用 ref 保存避免闭包过期
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // ====== 有效滚动位置（虚拟坐标）：强制模式优先 ======
  const virtualScrollTop = forcedVirtualTop ?? scrollTop * scale;
  // 渲染行块 translateY 需要的物理锚点位置
  const physicalScrollTop =
    forcedVirtualTop !== null ? forcedVirtualTop / scale : scrollTop;

  // ====== 可视区计算（基于虚拟滚动位置）======
  const startIdx = Math.max(0, Math.floor(virtualScrollTop / ROW_H) - 5);
  const visible = Math.ceil(viewportH / ROW_H) + 12;
  const endIdx = Math.min(effectiveTotal, startIdx + visible);
  // 行块偏移：把 startIdx 对应的行放到「视口顶部上方 5 行」的物理位置。
  // scale=1 时退化为 startIdx * ROW_H（与传统虚拟滚动一致）。
  const rowsOffset = physicalScrollTop - (virtualScrollTop - startIdx * ROW_H);

  // ====== 数据加载 ======
  const loadPage = useCallback(
    async (s: number, e: number) => {
      for (let l = s; l <= e; l++) loadingRef.current.add(l);
      try {
        const lines = await readLines(s, e - s + 1);
        let maxLine = 0;
        setCache((prev) => {
          const next = new Map(prev);
          for (const ln of lines) {
            next.set(ln.line, ln.text);
            if (ln.line > maxLine) maxLine = ln.line;
          }
          return next;
        });
        // 注意：必须在 setCache 的 updater 之外更新 maxKnownLine，
        // React 不允许在另一个 setState 的 updater 函数内调用 setState。
        if (maxLine > 0) setMaxKnownLine((prevMax) => Math.max(prevMax, maxLine));
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

    // 关键：不按估算 total 截断！跳转目标以搜索结果的实际行号为准，
    // 否则会被偏小的估算值截掉（例如实际 1300 万行被截到 152 万行）。
    const targetLine = Math.max(1, jump.line);
    const targetVirtualTop = (targetLine - 1) * ROW_H;

    // 清除之前的定时器
    if (forceTimerRef.current) clearTimeout(forceTimerRef.current);

    // 1. 先扩展已知行范围，使虚拟总高度足够容纳跳转目标。
    setMaxKnownLine((prev) => Math.max(prev, targetLine + PAGE / 2));

    // 2. 进入强制模式：以虚拟坐标驱动渲染位置（不受物理高度上限影响）
    setForcedVirtualTop(targetVirtualTop);

    // 3. 立即预加载目标行附近的内容（后端按真实文件读取，不受估算 total 限制）
    const preloadStart = Math.max(1, targetLine - PAGE / 2);
    const preloadEnd = targetLine + PAGE / 2;
    ensureLoaded(preloadStart, preloadEnd);

    // 4. 等 spacer/scale 随 maxKnownLine 更新后，把 DOM 滚动到对应物理位置。
    //    物理位置 = 虚拟位置 / 最新 scale（从 scaleRef 读取，避免闭包过期）。
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = targetVirtualTop / scaleRef.current;
      }
    });

    // 5. 延迟退出强制模式，并在退出前再次确保 DOM 滚动位置正确
    forceTimerRef.current = setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = targetVirtualTop / scaleRef.current;
      }
      setForcedVirtualTop(null);
      forceTimerRef.current = null;
      if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
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
      if (forcedVirtualTop !== null) return;
      const el = e.target as HTMLDivElement;
      const st = el.scrollTop;
      setScrollTop(st);
      // 接近底部时扩展已知行范围，避免占位不足导致无法继续向下滚动
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (st >= maxScroll - ROW_H * 20) {
        // 换算到虚拟坐标再推算行号（scale>1 时物理位置 ≠ 行号×ROW_H）
        const vst = st * scaleRef.current;
        const approxLine = Math.floor(vst / ROW_H) + PAGE * 4;
        setMaxKnownLine((prev) => Math.max(prev, approxLine));
      }
    },
    [forcedVirtualTop]
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
      <div className="viewer-spacer" style={{ height: spacerH }}>
        <div
          className="viewer-rows"
          style={{ transform: `translateY(${rowsOffset}px)` }}
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
