// ─────────────────────────────────────────────────────────────
// Write-back adapter: replaces the body of *this* code block in the note.
//
// Strategy
//  1. Note open in an editor (Live Preview / Source) → Editor.replaceRange
//     → change goes through CodeMirror, so Ctrl+Z works.
//  2. Otherwise (Reading view, closed pane)         → Vault.process
//     → atomic read-modify-write on the file.
//
// Optimistic concurrency: the current body must still equal the source we
// rendered from. If someone edited the block meanwhile we abort instead of
// clobbering their change (compare-and-swap on the text).
// ─────────────────────────────────────────────────────────────
import { App, MarkdownPostProcessorContext, MarkdownView, Notice, TFile } from "obsidian";

/** 比較用の正規化。CR を除去し末尾の空白を落とす。 */
const norm =(s: string) => s.replace(/\r/g, "").replace(/\s+$/, "");

/** ノート内の自分自身の dayplan コードブロック本文を書き換えるクラス。 */
export class CodeBlockWriter {
  constructor(
    private readonly app: App,
    private readonly ctx: MarkdownPostProcessorContext,
    private readonly el: HTMLElement,
  ) {}

  /** 本文が expected のままなら next に置換する。成功なら true、位置不明・競合なら false(通知付き)。 */
  async replace(expected: string, next: string): Promise<boolean> {
    const info = this.ctx.getSectionInfo(this.el);
    const file = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!info || !(file instanceof TFile)) {
      new Notice("Day Block Planner: ブロックの位置を特定できませんでした");
      return false;
    }
    const from = info.lineStart + 1; // first body line
    const to = info.lineEnd; // closing fence line (exclusive)

    const view = this.findEditingView(file);
    if (view) {
      const editor = view.editor;
      const current = [];
      for (let i = from; i < to; i++) current.push(editor.getLine(i));
      if (norm(current.join("\n")) !== norm(expected)) return this.conflict();
      editor.replaceRange(next + "\n", { line: from, ch: 0 }, { line: to, ch: 0 });
      return true;
    }

    let ok = false;
    await this.app.vault.process(file, (data) => {
      const eol = data.includes("\r\n") ? "\r\n" : "\n";
      const lines = data.split(/\r?\n/);
      if (norm(lines.slice(from, to).join("\n")) !== norm(expected)) return data;
      lines.splice(from, to - from, ...next.split("\n"));
      ok = true;
      return lines.join(eol);
    });
    return ok || this.conflict();
  }

  /** 対象ファイルをソース/ライブプレビューで開いている MarkdownView を探す。なければ null。 */
  private findEditingView(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file?.path === file.path && v.getMode() === "source") {
        return v;
      }
    }
    return null;
  }

  /** 競合時の通知を出し、保存失敗(false)を返す。 */
  private conflict(): false {
    new Notice("Day Block Planner: ブロックが別の場所で変更されたため、保存を中止しました");
    return false;
  }
}
