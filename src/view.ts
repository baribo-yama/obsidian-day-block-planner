// ─────────────────────────────────────────────────────────────
// View / interaction layer.
//   render()        : Plan → DOM (stateless, rebuilt on each change)
//   pointer session : transient drag state, DOM-only preview while dragging
//   commit()        : Plan mutation → serialize → CodeBlockWriter
// ─────────────────────────────────────────────────────────────
import { App, MarkdownRenderChild, Menu } from "obsidian";
import {
  applyDrag,
  Block,
  clamp,
  DragMode,
  formatDuration,
  formatTime,
  layoutBlocks,
  parsePlan,
  Plan,
  PlanConfig,
  serializePlan,
  snap,
  tagHue,
} from "./model";
import { BlockModal, BlockDraft } from "./modal";
import { CodeBlockWriter } from "./persistence";

/** 時刻ラベル用の左余白(px)。 */
const GUTTER_PX = 48;
/** ドラッグ開始とみなす最小移動量(px)。 */
const DRAG_THRESHOLD_PX = 4;
/** ダブルタップ判定の許容間隔(ms)。 */
const DOUBLE_TAP_MS = 350;

/** 進行中のポインタ操作の状態。既存ブロックの移動/リサイズ("block")か、空き領域での新規作成("create")。 */
type Session =
  | {
      kind: "block";
      pointerId: number;
      startY: number;
      mode: DragMode;
      block: Block;
      el: HTMLElement;
      moved: boolean;
      next: { start: number; end: number };
    }
  | {
      kind: "create";
      pointerId: number;
      startY: number;
      anchor: number;
      ghost: HTMLElement | null;
      moved: boolean;
      next: { start: number; end: number };
    };

/** ビューに渡す設定(既定の PlanConfig と最大表示高さ)。 */
export interface ViewOptions {
  defaults: PlanConfig;
  maxHeight: number; // 0 = unlimited
}

/** dayplan コードブロックを描画し、ドラッグ・メニュー・モーダル操作で編集できるタイムラインビュー。 */
export class DayPlanView extends MarkdownRenderChild {
  private plan: Plan;
  private layer!: HTMLElement;
  private nowLine: HTMLElement | null = null;
  private session: Session | null = null;
  private lastTap: { key: string; time: number } | null = null;
  private saving = false;

  constructor(
    containerEl: HTMLElement,
    private readonly app: App,
    private source: string,
    private readonly writer: CodeBlockWriter,
    private readonly opts: ViewOptions,
  ) {
    super(containerEl);
    this.plan = parsePlan(source, opts.defaults);
  }

  /** イベント登録・初回描画・現在時刻線の定期更新・Esc でのドラッグ取消を設定する。 */
  override onload(): void {
    // Keep clicks from moving the Live Preview cursor into the code block.
    for (const ev of ["mousedown", "click", "dblclick"] as const) {
      this.registerDomEvent(this.containerEl, ev, (e) => e.stopPropagation());
    }
    this.render();
    this.registerInterval(window.setInterval(() => this.updateNowLine(), 60_000));
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape" && this.session) this.cancelSession();
    });
  }

  // ───────────────────────── rendering ─────────────────────────
  /** 現在の Plan の設定への短縮アクセサ。 */
  private get cfg(): PlanConfig {
    return this.plan.config;
  }

  /** 分数 → グリッド上の Y 座標(px)。 */
  private y(min: number): number {
    return ((min - this.cfg.start) / 60) * this.cfg.hourHeight;
  }

  /** 画面上の clientY → 対応する分数(y の逆変換)。 */
  private minuteAt(clientY: number): number {
    const top = this.layer.getBoundingClientRect().top;
    return this.cfg.start + ((clientY - top) / this.cfg.hourHeight) * 60;
  }

  /** Plan 全体(ヘッダ・時刻グリッド・ブロック・現在時刻線)を DOM に再構築する。 */
  private render(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("dbp-root");

    this.renderHeader(root.createDiv({ cls: "dbp-header" }));

    const scroller = root.createDiv({ cls: "dbp-scroller" });
    if (this.opts.maxHeight > 0) scroller.style.maxHeight = `${this.opts.maxHeight}px`;

    const grid = scroller.createDiv({ cls: "dbp-grid" });
    grid.style.height = `${this.y(this.cfg.end)}px`;
    grid.style.setProperty("--dbp-gutter", `${GUTTER_PX}px`);

    for (let m = Math.ceil(this.cfg.start / 30) * 30; m <= this.cfg.end; m += 30) {
      const full = m % 60 === 0;
      const line = grid.createDiv({ cls: full ? "dbp-line" : "dbp-line dbp-line-half" });
      line.style.top = `${this.y(m)}px`;
      if (full && m < this.cfg.end) {
        const label = grid.createDiv({ cls: "dbp-hour-label", text: formatTime(m) });
        label.style.top = `${this.y(m)}px`;
      }
    }

    this.layer = grid.createDiv({ cls: "dbp-layer" });
    const slots = layoutBlocks(this.plan.blocks);
    for (const b of this.plan.blocks) this.renderBlock(b, slots.get(b.id)!);

    this.nowLine = this.layer.createDiv({ cls: "dbp-now" });
    this.updateNowLine();

    this.layer.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.layer.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.layer.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.layer.addEventListener("pointercancel", () => this.cancelSession());
    this.layer.addEventListener("contextmenu", (e) => this.onContextMenu(e));

    // Initial scroll: first block (or now) when the timeline is height-limited.
    if (this.opts.maxHeight > 0) {
      const first = this.plan.blocks.reduce((a, b) => Math.min(a, b.start), Infinity);
      const target = Number.isFinite(first) ? first : this.nowMinute() ?? this.cfg.start;
      scroller.scrollTop = Math.max(0, this.y(target) - this.cfg.hourHeight / 2);
    }
  }

  /** ヘッダ(日付・計画合計時間・ToDo 進捗・追加ボタン)を描画する。 */
  private renderHeader(h: HTMLElement): void {
    const blocks = this.plan.blocks;
    const total = blocks.reduce((s, b) => s + (b.end - b.start), 0);
    const todos = blocks.filter((b) => b.done !== null);
    const doneMin = todos.filter((b) => b.done).reduce((s, b) => s + (b.end - b.start), 0);
    const todoMin = todos.reduce((s, b) => s + (b.end - b.start), 0);

    if (this.cfg.date) h.createSpan({ cls: "dbp-date", text: this.cfg.date });
    h.createSpan({ cls: "dbp-summary", text: `計画 ${formatDuration(total)}` });
    if (todoMin > 0) {
      const pct = Math.round((doneMin / todoMin) * 100);
      const prog = h.createSpan({ cls: "dbp-progress" });
      prog.createSpan({ cls: "dbp-progress-bar" }).style.width = `${pct}%`;
      h.createSpan({ cls: "dbp-summary", text: `完了 ${formatDuration(doneMin)} (${pct}%)` });
    }
    const add = h.createEl("button", { cls: "dbp-add", text: "+ 追加" });
    add.addEventListener("click", () => {
      const lastEnd = blocks.reduce((a, b) => Math.max(a, b.end), -1);
      const now = this.nowMinute();
      let start = lastEnd >= 0 ? lastEnd : now !== null ? snap(now, this.cfg.step) : 9 * 60;
      start = clamp(start, this.cfg.start, this.cfg.end - this.cfg.step);
      this.openModal(null, { title: "", start, end: Math.min(start + 60, this.cfg.end), done: false });
    });
  }

  /** ブロック1つを描画する(重なり位置・タグ色・チェックボックス・リサイズハンドル)。 */
  private renderBlock(b: Block, slot: { col: number; cols: number }): void {
    const el = this.layer.createDiv({ cls: "dbp-block" });
    el.dataset.id = String(b.id);
    if (b.done) el.addClass("is-done");
    const hue = tagHue(b.title);
    if (hue !== null) {
      el.addClass("has-hue");
      el.style.setProperty("--dbp-hue", String(hue));
    }
    el.style.left = `calc(${(slot.col / slot.cols) * 100}% + 1px)`;
    el.style.width = `calc(${100 / slot.cols}% - 3px)`;
    this.positionBlock(el, b.start, b.end);

    el.createDiv({ cls: "dbp-handle dbp-handle-top" });
    const inner = el.createDiv({ cls: "dbp-block-inner" });
    const row = inner.createDiv({ cls: "dbp-row" });
    if (b.done !== null) {
      const cb = row.createEl("input", { type: "checkbox", cls: "dbp-check" });
      cb.checked = b.done;
      cb.addEventListener("pointerdown", (e) => e.stopPropagation());
      cb.addEventListener("change", () => this.commit((p) => this.find(p, b.id)!.done = cb.checked));
    }
    row.createSpan({ cls: "dbp-title", text: b.title || "(無題)" });
    inner.createSpan({ cls: "dbp-time", text: `${formatTime(b.start)}–${formatTime(b.end)}` });
    el.createDiv({ cls: "dbp-handle dbp-handle-bottom" });
  }

  /** 要素の top/height を時間帯に合わせ、短いブロックには compact クラスを付ける。 */
  private positionBlock(el: HTMLElement, start: number, end: number): void {
    const s = clamp(start, this.cfg.start, this.cfg.end);
    const e = clamp(end, this.cfg.start, this.cfg.end);
    el.style.top = `${this.y(s)}px`;
    el.style.height = `${Math.max(this.y(e) - this.y(s), 12)}px`;
    el.toggleClass("is-compact", (e - s) / 60 * this.cfg.hourHeight < 34);
  }

  /** 現在時刻の分数。date 指定が今日でなければ null。 */
  private nowMinute(): number | null {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (this.cfg.date && this.cfg.date !== today) return null;
    return d.getHours() * 60 + d.getMinutes();
  }

  /** 現在時刻線の位置と表示/非表示を更新する。 */
  private updateNowLine(): void {
    if (!this.nowLine) return;
    const now = this.nowMinute();
    const visible = now !== null && now >= this.cfg.start && now <= this.cfg.end;
    this.nowLine.toggleClass("is-hidden", !visible);
    if (visible) this.nowLine.style.top = `${this.y(now!)}px`;
  }

  // ───────────────────────── interactions ─────────────────────────
  /** ポインタ押下。ブロック上なら移動/リサイズ、空き領域なら新規作成のセッションを開始する。 */
  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.saving) return;
    const target = e.target as HTMLElement;
    const blockEl = target.closest<HTMLElement>(".dbp-block");

    if (blockEl) {
      const block = this.plan.blocks.find((b) => String(b.id) === blockEl.dataset.id);
      if (!block) return;
      const mode: DragMode = target.hasClass("dbp-handle-top")
        ? "resize-top"
        : target.hasClass("dbp-handle-bottom")
          ? "resize-bottom"
          : "move";
      this.session = {
        kind: "block",
        pointerId: e.pointerId,
        startY: e.clientY,
        mode,
        block,
        el: blockEl,
        moved: false,
        next: { start: block.start, end: block.end },
      };
    } else {
      const anchor = clamp(
        Math.floor(this.minuteAt(e.clientY) / this.cfg.step) * this.cfg.step,
        this.cfg.start,
        this.cfg.end - this.cfg.step,
      );
      this.session = {
        kind: "create",
        pointerId: e.pointerId,
        startY: e.clientY,
        anchor,
        ghost: null,
        moved: false,
        next: { start: anchor, end: anchor + this.cfg.step },
      };
      // On touch, let empty-area swipes scroll the note; only double-tap creates.
      if (e.pointerType !== "mouse") return;
    }
    e.preventDefault();
    this.layer.setPointerCapture(e.pointerId);
  }

  /** ポインタ移動。閾値超過後、DOM 上だけでプレビュー(ブロック位置 or ゴースト)を更新する。 */
  private onPointerMove(e: PointerEvent): void {
    const s = this.session;
    if (!s || e.pointerId !== s.pointerId) return;
    const dy = e.clientY - s.startY;
    if (!s.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      if (s.kind === "create" && e.pointerType !== "mouse") return;
      s.moved = true;
      this.containerEl.addClass("is-dragging");
    }

    if (s.kind === "block") {
      const delta = snap((dy / this.cfg.hourHeight) * 60, this.cfg.step);
      s.next = applyDrag(s.block, s.mode, delta, this.cfg);
      s.el.addClass("is-active");
      this.positionBlock(s.el, s.next.start, s.next.end);
      s.el.querySelector(".dbp-time")?.setText(`${formatTime(s.next.start)}–${formatTime(s.next.end)}`);
    } else {
      const cur = clamp(snap(this.minuteAt(e.clientY), this.cfg.step), this.cfg.start, this.cfg.end);
      let start = Math.min(s.anchor, cur);
      let end = Math.max(s.anchor, cur);
      if (end - start < this.cfg.step) {
        if (cur < s.anchor) start = end - this.cfg.step;
        else end = start + this.cfg.step;
      }
      s.next = { start, end };
      if (!s.ghost) s.ghost = this.layer.createDiv({ cls: "dbp-block dbp-ghost" });
      this.positionBlock(s.ghost, start, end);
      s.ghost.setText(`${formatTime(start)}–${formatTime(end)}`);
    }
  }

  /** ポインタ解放。ドラッグ結果を保存、新規作成ならモーダルを開く。ダブルタップは編集/作成モーダル。 */
  private onPointerUp(e: PointerEvent): void {
    const s = this.session;
    if (!s || e.pointerId !== s.pointerId) return;
    this.session = null;
    this.containerEl.removeClass("is-dragging");

    if (s.kind === "block") {
      if (s.moved) {
        s.el.removeClass("is-active");
        if (s.next.start !== s.block.start || s.next.end !== s.block.end) {
          const { start, end } = s.next;
          void this.commit((p) => Object.assign(this.find(p, s.block.id)!, { start, end }));
        }
      } else if (this.isDoubleTap(`b${s.block.id}`)) {
        this.openModal(s.block, { ...s.block });
      }
      return;
    }

    s.ghost?.remove();
    if (s.moved) {
      this.openModal(null, { title: "", ...s.next, done: false });
    } else if (this.isDoubleTap("empty")) {
      const start = s.anchor;
      this.openModal(null, { title: "", start, end: Math.min(start + 60, this.cfg.end), done: false });
    }
  }

  /** 進行中の操作を破棄し、プレビューを元の表示に戻す。 */
  private cancelSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.containerEl.removeClass("is-dragging");
    if (s.kind === "block") {
      s.el.removeClass("is-active");
      this.positionBlock(s.el, s.block.start, s.block.end);
      s.el.querySelector(".dbp-time")?.setText(`${formatTime(s.block.start)}–${formatTime(s.block.end)}`);
    } else {
      s.ghost?.remove();
    }
  }

  /** key に対する連続タップがダブルタップか判定し、タップ履歴を更新する。 */
  private isDoubleTap(key: string): boolean {
    const now = Date.now();
    const hit = this.lastTap?.key === key && now - this.lastTap.time < DOUBLE_TAP_MS;
    this.lastTap = hit ? null : { key, time: now };
    return hit;
  }

  /** ブロックの右クリックメニュー(編集・完了切替・直後に複製・削除)を表示する。 */
  private onContextMenu(e: MouseEvent): void {
    const blockEl = (e.target as HTMLElement).closest<HTMLElement>(".dbp-block");
    const block = blockEl && this.plan.blocks.find((b) => String(b.id) === blockEl.dataset.id);
    if (!block) return;
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("編集").setIcon("pencil").onClick(() => this.openModal(block, { ...block })));
    menu.addItem((i) =>
      i
        .setTitle(block.done ? "未完了に戻す" : "完了にする")
        .setIcon("check")
        .onClick(() => this.commit((p) => (this.find(p, block.id)!.done = !block.done))),
    );
    menu.addItem((i) =>
      i
        .setTitle("直後に複製")
        .setIcon("copy")
        .onClick(() =>
          this.commit((p) => {
            const dur = block.end - block.start;
            const start = Math.min(block.end, this.cfg.end - dur);
            p.blocks.push({ ...block, id: -1, start, end: start + dur, done: block.done === null ? null : false });
          }),
        ),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("削除")
        .setIcon("trash")
        .onClick(() => this.commit((p) => (p.blocks = p.blocks.filter((x) => x.id !== block.id)))),
    );
    menu.showAtMouseEvent(e);
  }

  /** 追加/編集モーダルを開き、結果(保存・削除)を commit で反映する。existing が null なら新規。 */
  private openModal(existing: Block | null, draft: BlockDraft): void {
    new BlockModal(this.app, draft, this.cfg, existing === null, (r) => {
      if (r.kind === "delete") {
        void this.commit((p) => (p.blocks = p.blocks.filter((x) => x.id !== existing!.id)));
      } else if (existing) {
        void this.commit((p) => Object.assign(this.find(p, existing.id)!, r.draft));
      } else {
        void this.commit((p) => p.blocks.push({ id: -1, ...r.draft }));
      }
    }).open();
  }

  // ───────────────────────── persistence ─────────────────────────
  /** Plan から id でブロックを探す。 */
  private find(p: Plan, id: number): Block | undefined {
    return p.blocks.find((b) => b.id === id);
  }

  /** Mutate a copy of the plan, write it back, then re-render optimistically. */
  private async commit(mutate: (p: Plan) => void): Promise<void> {
    if (this.saving) return;
    const draft: Plan = structuredClone(this.plan);
    mutate(draft);
    const text = serializePlan(draft);
    if (text === this.source) return this.render();

    this.saving = true;
    try {
      const ok = await this.writer.replace(this.source, text);
      if (ok) {
        this.source = text;
        this.plan = parsePlan(text, this.opts.defaults);
      }
    } finally {
      this.saving = false;
      this.render();
    }
  }
}
