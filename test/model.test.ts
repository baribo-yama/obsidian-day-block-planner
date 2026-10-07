import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDrag,
  DEFAULT_CONFIG,
  layoutBlocks,
  parsePlan,
  serializePlan,
} from "../src/model.ts";

const SRC = `date: 2026-10-07
start: 08:00
end: 22:00
---
- [x] 09:00-10:30 研究室ミーティング
- [ ] 10:30-12:00 raqoo API実装 #dev
13:00-14:00 昼休み
メモ: これは保持される行`;

test("parse: config, todo, plain block, extra lines", () => {
  const p = parsePlan(SRC);
  assert.equal(p.config.start, 8 * 60);
  assert.equal(p.config.end, 22 * 60);
  assert.equal(p.config.date, "2026-10-07");
  assert.equal(p.blocks.length, 3);
  assert.deepEqual(
    p.blocks.map((b) => [b.start, b.end, b.title, b.done]),
    [
      [540, 630, "研究室ミーティング", true],
      [630, 720, "raqoo API実装 #dev", false],
      [780, 840, "昼休み", null],
    ],
  );
  assert.deepEqual(p.extraLines, ["メモ: これは保持される行"]);
});

test("serialize: round-trips byte-for-byte", () => {
  assert.equal(serializePlan(parsePlan(SRC)), SRC);
});

test("parse: accepts 〜 and 24:00, rejects inverted ranges", () => {
  const p = parsePlan("22:00〜24:00 寝る\n12:00-11:00 bad");
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].end, 1440);
  assert.deepEqual(p.extraLines, ["12:00-11:00 bad"]);
});

test("serialize: sorts blocks by start time", () => {
  const p = parsePlan("15:00-16:00 B\n09:00-10:00 A");
  assert.equal(serializePlan(p), "09:00-10:00 A\n15:00-16:00 B");
});

test("layout: overlapping blocks share columns, separate clusters don't", () => {
  const p = parsePlan(
    ["09:00-11:00 a", "09:30-10:00 b", "10:00-10:30 c", "12:00-13:00 d"].join("\n"),
  );
  const l = layoutBlocks(p.blocks);
  assert.deepEqual(l.get(0), { col: 0, cols: 2 });
  assert.deepEqual(l.get(1), { col: 1, cols: 2 });
  assert.deepEqual(l.get(2), { col: 1, cols: 2 }); // reuses freed column
  assert.deepEqual(l.get(3), { col: 0, cols: 1 });
});

test("drag: move clamps inside range and keeps duration", () => {
  const cfg = { ...DEFAULT_CONFIG, start: 360, end: 1440 };
  assert.deepEqual(applyDrag({ start: 400, end: 460 }, "move", -120, cfg), { start: 360, end: 420 });
  assert.deepEqual(applyDrag({ start: 1380, end: 1440 }, "move", 60, cfg), { start: 1380, end: 1440 });
});

test("drag: resize never goes below one step", () => {
  const cfg = { ...DEFAULT_CONFIG, step: 15 };
  assert.deepEqual(applyDrag({ start: 600, end: 660 }, "resize-bottom", -120, cfg), { start: 600, end: 615 });
  assert.deepEqual(applyDrag({ start: 600, end: 660 }, "resize-top", 120, cfg), { start: 645, end: 660 });
});
