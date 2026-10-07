import { App, Editor, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_CONFIG, formatTime, parseTime, PlanConfig } from "./model";
import { CodeBlockWriter } from "./persistence";
import { DayPlanView } from "./view";

/** プラグイン設定(data.json に保存)。時刻は "HH:MM" 文字列。 */
interface Settings {
  start: string;
  end: string;
  step: number;
  hourHeight: number;
  maxHeight: number;
}

/** 設定の初期値(モデルのデフォルト設定から導出)。 */
const DEFAULT_SETTINGS: Settings = {
  start: formatTime(DEFAULT_CONFIG.start),
  end: formatTime(DEFAULT_CONFIG.end),
  step: DEFAULT_CONFIG.step,
  hourHeight: DEFAULT_CONFIG.hourHeight,
  maxHeight: 0,
};

/** プラグイン本体。dayplan コードブロックの描画登録、コマンド、設定タブを提供する。 */
export default class DayBlockPlannerPlugin extends Plugin {
  prefs: Settings = { ...DEFAULT_SETTINGS };

  /** 設定を読み込み、dayplan プロセッサ・「今日のタイムラインを挿入」コマンド・設定タブを登録する。 */
  override async onload(): Promise<void> {
    this.prefs = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };

    this.registerMarkdownCodeBlockProcessor("dayplan", (source, el, ctx) => {
      const writer = new CodeBlockWriter(this.app, ctx, el);
      ctx.addChild(
        new DayPlanView(el, this.app, source, writer, {
          defaults: this.defaults(),
          maxHeight: this.prefs.maxHeight,
        }),
      );
    });

    this.addCommand({
      id: "insert-today",
      name: "今日のタイムラインを挿入",
      editorCallback: (editor: Editor) => {
        const d = new Date();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        editor.replaceSelection(["```dayplan", `date: ${date}`, "---", "```", ""].join("\n"));
      },
    });

    this.addSettingTab(new DbpSettingTab(this.app, this));
  }

  /** 設定値をブロック側 start:/end: 等で上書きされる前の PlanConfig に変換する。 */
  defaults(): PlanConfig {
    return {
      ...DEFAULT_CONFIG,
      start: parseTime(this.prefs.start) ?? DEFAULT_CONFIG.start,
      end: parseTime(this.prefs.end) ?? DEFAULT_CONFIG.end,
      step: this.prefs.step,
      hourHeight: this.prefs.hourHeight,
    };
  }

  /** 現在の設定を永続化する。 */
  async saveSettings(): Promise<void> {
    await this.saveData(this.prefs);
  }
}

/** 設定画面。表示時間帯・スナップ間隔・1時間の高さ・最大表示高さを編集する。 */
class DbpSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DayBlockPlannerPlugin,
  ) {
    super(app, plugin);
  }

  /** 設定項目を構築し、入力が妥当な場合のみ保存する。 */
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.prefs;
    const save = () => void this.plugin.saveSettings();

    const timeSetting = (key: "start" | "end", name: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc("HH:MM(ブロック内の start: / end: で上書き可)")
        .addText((t) =>
          t.setValue(s[key]).onChange((v) => {
            if (parseTime(v) !== null) {
              s[key] = v;
              save();
            }
          }),
        );
    timeSetting("start", "表示開始時刻");
    timeSetting("end", "表示終了時刻");

    new Setting(containerEl)
      .setName("スナップ間隔(分)")
      .addDropdown((d) =>
        d
          .addOptions({ "5": "5", "10": "10", "15": "15", "30": "30" })
          .setValue(String(s.step))
          .onChange((v) => {
            s.step = Number(v);
            save();
          }),
      );

    new Setting(containerEl).setName("1時間の高さ(px)").addSlider((sl) =>
      sl
        .setLimits(24, 120, 4)
        .setValue(s.hourHeight)
        .setDynamicTooltip()
        .onChange((v) => {
          s.hourHeight = v;
          save();
        }),
    );

    new Setting(containerEl)
      .setName("最大表示高さ(px)")
      .setDesc("0 = 制限なし。指定するとタイムライン内でスクロールします")
      .addText((t) =>
        t.setValue(String(s.maxHeight)).onChange((v) => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0) {
            s.maxHeight = n;
            save();
          }
        }),
      );
  }
}
