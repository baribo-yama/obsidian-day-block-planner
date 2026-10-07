import { App, Modal, Setting } from "obsidian";
import { formatTime, parseTime, PlanConfig } from "./model";

/** モーダルで編集中のブロック内容(id を持たない下書き)。 */
export interface BlockDraft {
  title: string;
  start: number;
  end: number;
  done: boolean | null;
}

/** モーダルの結果。保存(下書き付き)または削除。 */
export type ModalResult ={ kind: "save"; draft: BlockDraft } | { kind: "delete" };

/** ブロックの追加・編集ダイアログ。作業内容・開始/終了時刻・ToDo 化を入力し、結果をコールバックで返す。 */
export class BlockModal extends Modal {
  private draft: BlockDraft;
  private errorEl!: HTMLElement;

  constructor(
    app: App,
    initial: BlockDraft,
    private readonly cfg: PlanConfig,
    private readonly isNew: boolean,
    private readonly onResult: (r: ModalResult) => void,
  ) {
    super(app);
    this.draft = { ...initial };
  }

  /** 入力フォーム(タイトル・時刻・ToDo トグル・ボタン)を構築し、Enter で保存できるようにする。 */
  override onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.isNew ? "ブロックを追加" : "ブロックを編集");

    new Setting(contentEl).setName("作業内容").addText((t) => {
      t.setPlaceholder("例: raqoo API実装 #dev")
        .setValue(this.draft.title)
        .onChange((v) => (this.draft.title = v));
      t.inputEl.style.width = "100%";
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    const timeInput = (key: "start" | "end", label: string) =>
      new Setting(contentEl).setName(label).addText((t) => {
        t.inputEl.type = "time";
        t.inputEl.step = String(this.cfg.step * 60);
        t.setValue(formatTime(Math.min(this.draft[key], 23 * 60 + 59)));
        if (key === "end" && this.draft.end === 1440) t.setValue("00:00");
        t.onChange((v) => {
          let m = parseTime(v);
          if (m === null) return;
          if (key === "end" && m === 0) m = 1440; // 00:00 as end = 24:00
          this.draft[key] = m;
        });
      });
    timeInput("start", "開始");
    timeInput("end", "終了");

    new Setting(contentEl)
      .setName("ToDoとして扱う")
      .setDesc("チェックボックスを付けて完了管理する")
      .addToggle((tg) =>
        tg.setValue(this.draft.done !== null).onChange((v) => {
          this.draft.done = v ? false : null;
        }),
      );

    this.errorEl = contentEl.createDiv({ cls: "dbp-modal-error" });

    const buttons = new Setting(contentEl);
    if (!this.isNew) {
      buttons.addButton((b) =>
        b
          .setButtonText("削除")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onResult({ kind: "delete" });
          }),
      );
    }
    buttons
      .addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("保存").setCta().onClick(() => this.submit()));

    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      this.submit();
      return false;
    });
  }

  /** 入力を検証(タイトル必須・終了>開始)し、問題なければ閉じて保存結果を通知する。 */
  private submit(): void {
    const d = this.draft;
    if (!d.title.trim()) return this.showError("作業内容を入力してください");
    if (d.end <= d.start) return this.showError("終了は開始より後にしてください");
    this.close();
    this.onResult({ kind: "save", draft: { ...d, title: d.title.trim() } });
  }

  /** 検証エラーメッセージをモーダル内に表示する。 */
  private showError(msg: string): void {
    this.errorEl.setText(msg);
  }

  /** 閉じる際にフォームの DOM を破棄する。 */
  override onClose(): void {
    this.contentEl.empty();
  }
}
