// ─────────────────────────────────────────────────────────────
// Domain model: pure functions only (no Obsidian / DOM deps).
// Markdown text  ⇄  Plan  is the single source of truth.
// ─────────────────────────────────────────────────────────────

/** タイムライン上の1ブロック(時間帯と作業内容、ToDo 状態)。 */
export interface Block {
  id: number;
  /** minutes from 00:00 */
  start: number;
  /** minutes from 00:00 (may be 1440 = 24:00) */
  end: number;
  title: string;
  /** null = plain block (no checkbox), boolean = todo state */
  done: boolean | null;
}

/** 表示範囲・スナップ間隔・高さなど、タイムラインの表示設定。 */
export interface PlanConfig {
  start: number; // visible range start (min)
  end: number; // visible range end (min)
  step: number; // snap unit (min)
  hourHeight: number; // px per hour
  date: string | null; // YYYY-MM-DD, used for the "now" line
}

/** コードブロック全体をパースした結果(設定・ブロック群・原文保持行)。 */
export interface Plan {
  config: PlanConfig;
  blocks: Block[];
  /** raw header lines (before `---`), preserved verbatim */
  headerLines: string[] | null;
  /** lines we could not parse, preserved verbatim at the end */
  extraLines: string[];
}

/** PlanConfig の既定値(6:00〜24:00、15分刻み、1時間=48px)。 */
export const DEFAULT_CONFIG: PlanConfig = {
  start: 6 * 60,
  end: 24 * 60,
  step: 15,
  hourHeight: 48,
  date: null,
};

/** ブロック行("[x] 09:00-10:30 タイトル" 等)にマッチする正規表現。 */
const BLOCK_RE =
  /^\s*(?:[-*]\s+)?(?:\[([ xX])\]\s+)?(\d{1,2}):(\d{2})\s*[-–~〜]\s*(\d{1,2}):(\d{2})\s*(.*)$/;
/** 設定行("key: value")にマッチする正規表現。 */
const CONFIG_RE = /^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/;

/** "H:MM"/"HH:MM" を 0:00 からの分数に変換する。不正値は null(24:00 は許可)。 */
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** 分数を "HH:MM" 形式に整形する。 */
export function formatTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 分数を "1h30m" / "2h" / "45m" 形式の所要時間表記にする。 */
export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** 設定行1つを解釈して cfg に反映する。未知のキーや範囲外の値は無視する。 */
function applyConfigLine(cfg: PlanConfig, line: string): void {
  const m = CONFIG_RE.exec(line);
  if (!m) return;
  const key = m[1].toLowerCase();
  const val = m[2];
  switch (key) {
    case "start":
    case "end": {
      const t = parseTime(val);
      if (t !== null) cfg[key] = t;
      break;
    }
    case "step": {
      const n = Number(val);
      if (Number.isInteger(n) && n >= 5 && n <= 60) cfg.step = n;
      break;
    }
    case "hourheight": {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 20 && n <= 200) cfg.hourHeight = n;
      break;
    }
    case "date":
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) cfg.date = val;
      break;
  }
}

/** コードブロック本文を Plan にパースする。`---` より前を設定、後ろをブロック行として扱い、解釈できない行は extraLines に保持。 */
export function parsePlan(source: string, defaults: PlanConfig = DEFAULT_CONFIG): Plan {
  const lines = source.split(/\r?\n/);
  const config: PlanConfig = { ...defaults };
  let headerLines: string[] | null = null;
  let body = lines;

  const sep = lines.findIndex((l) => l.trim() === "---");
  if (sep !== -1) {
    headerLines = lines.slice(0, sep);
    headerLines.forEach((l) => applyConfigLine(config, l));
    body = lines.slice(sep + 1);
  }
  if (config.end <= config.start) {
    config.start = defaults.start;
    config.end = defaults.end;
  }

  const blocks: Block[] = [];
  const extraLines: string[] = [];
  let id = 0;
  for (const line of body) {
    const m = BLOCK_RE.exec(line);
    if (m) {
      const start = parseTime(`${m[2]}:${m[3]}`);
      const end = parseTime(`${m[4]}:${m[5]}`);
      if (start !== null && end !== null && end > start) {
        blocks.push({
          id: id++,
          start,
          end,
          title: m[6].trim(),
          done: m[1] === undefined ? null : m[1].toLowerCase() === "x",
        });
        continue;
      }
    }
    if (line.trim() !== "") extraLines.push(line);
  }
  return { config, blocks, headerLines, extraLines };
}

/** ブロック1つを Markdown 1行("HH:MM-HH:MM タイトル" か ToDo 形式)に変換する。 */
export function serializeBlock(b: Block): string {
  const range = `${formatTime(b.start)}-${formatTime(b.end)}`;
  const title = b.title ? ` ${b.title}` : "";
  if (b.done === null) return `${range}${title}`;
  return `- [${b.done ? "x" : " "}] ${range}${title}`;
}

/** Plan をテキストに戻す。ヘッダ原文→開始順に並べたブロック→extraLines の順で出力。 */
export function serializePlan(plan: Plan): string {
  const out: string[] = [];
  if (plan.headerLines) {
    out.push(...plan.headerLines, "---");
  }
  const sorted = [...plan.blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  out.push(...sorted.map(serializeBlock));
  out.push(...plan.extraLines);
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Overlap layout (Google Calendar style):
// blocks that transitively overlap form a cluster; within a cluster each
// block takes the first free column. Width = 1 / (#columns in cluster).
// O(n log n + n·k)  (k = columns per cluster, tiny in practice)
// ─────────────────────────────────────────────────────────────
/** 重なりレイアウト上の位置(何列目か / クラスタ内の総列数)。 */
export interface Slot {
  col: number;
  cols: number;
}

/** 各ブロックの Slot を計算し、id をキーにした Map で返す。 */
export function layoutBlocks(blocks: Block[]): Map<number, Slot> {
  const result = new Map<number, Slot>();
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);

  let cluster: Block[] = [];
  let columnsEnd: number[] = [];
  let clusterEnd = -1;

  const flush = () => {
    const cols = columnsEnd.length;
    for (const b of cluster) result.get(b.id)!.cols = cols;
    cluster = [];
    columnsEnd = [];
    clusterEnd = -1;
  };

  for (const b of sorted) {
    if (cluster.length > 0 && b.start >= clusterEnd) flush();
    let col = columnsEnd.findIndex((e) => e <= b.start);
    if (col === -1) {
      col = columnsEnd.length;
      columnsEnd.push(b.end);
    } else {
      columnsEnd[col] = b.end;
    }
    result.set(b.id, { col, cols: 1 });
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  if (cluster.length > 0) flush();
  return result;
}

// ─────────────────────────────────────────────────────────────
// Time arithmetic helpers used by drag interactions.
// ─────────────────────────────────────────────────────────────
/** 分数を step の倍数に丸める。 */
export function snap(min: number, step: number): number {
  return Math.round(min / step) * step;
}

/** v を lo〜hi の範囲に収める。 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** ドラッグ操作の種類(移動 / 上端リサイズ / 下端リサイズ)。 */
export type DragMode = "move" | "resize-top" | "resize-bottom";

/** Apply a (snapped) minute delta to a block for the given drag mode. */
export function applyDrag(
  orig: { start: number; end: number },
  mode: DragMode,
  delta: number,
  cfg: Pick<PlanConfig, "start" | "end" | "step">,
): { start: number; end: number } {
  const dur = orig.end - orig.start;
  switch (mode) {
    case "move": {
      const start = clamp(orig.start + delta, cfg.start, cfg.end - dur);
      return { start, end: start + dur };
    }
    case "resize-top": {
      const start = clamp(orig.start + delta, cfg.start, orig.end - cfg.step);
      return { start, end: orig.end };
    }
    case "resize-bottom": {
      const end = clamp(orig.end + delta, orig.start + cfg.step, cfg.end);
      return { start: orig.start, end };
    }
  }
}

/** Stable hue (0-359) derived from the first #tag in a title, or null. */
export function tagHue(title: string): number | null {
  const m = /#([^\s#]+)/.exec(title);
  if (!m) return null;
  let h = 0;
  for (const ch of m[1]) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}
