import {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  setIcon,
} from "obsidian";

const RIBBON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100" height="100" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;

const DEFAULT_SETTINGS = {
  swipeEnabled: true,
  swipeThreshold: 72,
  showRibbon: true,
  useSelection: true,
  folder: "",
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function blockAt(doc, pos) {
  const line = doc.lineAt(clamp(pos, 0, doc.length));
  let first = line.number;
  let last = line.number;
  if (line.text.trim() === "") {
    if (last < doc.lines && doc.line(last + 1).text.trim() !== "") first = last + 1;
    else if (first > 1 && doc.line(first - 1).text.trim() !== "") last = first - 1;
  }
  while (first > 1 && doc.line(first - 1).text.trim() !== "") first--;
  while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last++;
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  return { from, to, first, last, text: doc.sliceString(from, to) };
}

function removalRange(doc, block) {
  if (!block.first || !block.last) return { from: block.from, to: block.to };
  let above = 0;
  let below = 0;
  while (block.first - above > 1 && doc.line(block.first - above - 1).text.trim() === "") above++;
  while (block.last + below < doc.lines && doc.line(block.last + below + 1).text.trim() === "") below++;
  const from = above > 0 ? doc.line(block.first - above).from : block.from;
  let to;
  if (below > 0) to = doc.line(block.last + below).from;
  else if (above > 0) to = block.to;
  else if (block.last < doc.lines) to = doc.line(block.last + 1).from;
  else if (block.first > 1) to = doc.line(block.first - 1).to;
  else to = block.to;
  return { from, to };
}

function revalidate(doc, block) {
  if (block.from >= 0 && block.to <= doc.length && doc.sliceString(block.from, block.to) === block.text) {
    return block;
  }
  if (!block.first) return null;
  const from = Math.max(1, block.first - 5);
  const to = Math.min(doc.lines, block.first + 60);
  for (let n = from; n <= to; n++) {
    const cand = blockAt(doc, doc.line(n).from);
    if (cand.text === block.text) return cand;
  }
  return null;
}

function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits = [];
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    hits.push(i);
    let s = 10;
    if (i === 0) s += 20;
    else if (/[\s/\-_.]/.test(t[i - 1])) s += 14;
    if (last >= 0 && i === last + 1) s += 8;
    if (t[i] === query[qi]) s += 2;
    score += s;
    last = i;
    qi++;
  }
  if (qi < q.length) return null;
  score -= (t.length - q.length) * 0.15;
  return { score, hits };
}

function splitPath(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

class PickerModal extends Modal {
  constructor(app, plugin, previewText, onPick) {
    super(app);
    this.plugin = plugin;
    this.previewText = previewText;
    this.onPick = onPick;
    this.items = [];
    this.active = 0;
  }

  onOpen() {
    const { contentEl } = this;
    this.containerEl.addClass("ps-container");
    this.modalEl.addClass("ps-shell");
    contentEl.empty();
    contentEl.addClass("ps-modal");

    const head = contentEl.createDiv({ cls: "ps-head" });
    setIcon(head.createSpan({ cls: "ps-head-icon" }), "arrow-right-to-line");
    const headText = head.createDiv({ cls: "ps-head-text" });
    headText.createDiv({ cls: "ps-title", text: "Куда перенести абзац?" });
    const preview = previewLine(this.previewText);
    if (preview) headText.createDiv({ cls: "ps-preview", text: preview });

    this.input = contentEl.createEl("input", {
      type: "text",
      cls: "ps-input",
      placeholder: "Поиск заметки…",
    });
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("spellcheck", "false");

    this.list = contentEl.createDiv({ cls: "ps-list" });
    this.empty = contentEl.createDiv({ cls: "ps-empty" });

    const foot = contentEl.createDiv({ cls: "ps-foot" });
    const cancel = foot.createEl("button", { cls: "ps-cancel", text: "Отмена" });
    cancel.addEventListener("click", () => this.close());

    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.refresh();
    window.setTimeout(() => this.input.focus(), 60);
  }

  onKey(e) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.pickActive();
    }
  }

  move(step) {
    if (!this.items.length) return;
    this.active = clamp(this.active + step, 0, this.items.length - 1);
    this.paint();
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  pickActive() {
    const item = this.items[this.active];
    if (!item) return;
    this.onPick(item.path);
    this.close();
  }

  candidateFiles() {
    const folder = this.plugin.settings.folder.trim().replace(/\/+$/, "");
    const files = this.app.vault.getMarkdownFiles();
    const scoped = folder
      ? files.filter((f) => f.path === folder || f.path.startsWith(`${folder}/`))
      : files;
    return scoped.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
  }

  refresh() {
    const query = this.input.value.trim();
    const files = this.candidateFiles();
    const scored = [];
    for (const file of files) {
      const m = fuzzy(query, file.path);
      if (m) scored.push({ path: file.path, score: m.score, hits: m.hits });
    }
    if (query) scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);

    this.items = scored.slice(0, 200).map((s) => ({ path: s.path, hits: s.hits }));
    const bare = query.toLowerCase().replace(/\.md$/, "");
    const exact = files.some((f) => f.name.toLowerCase().replace(/\.md$/, "") === bare);
    if (bare && !exact) this.items.push({ path: this.newFilePath(query), hits: [], isNew: true });
    this.active = 0;
    this.paint();
  }

  newFilePath(query) {
    const folder = this.plugin.settings.folder.trim().replace(/\/+$/, "");
    const clean = query.replace(/\.md$/i, "").replace(/[\\/:*?"<>|]/g, "-");
    const name = `${clean}.md`;
    return folder ? `${folder}/${name}` : name;
  }

  paint() {
    this.list.empty();
    this.list.scrollTop = 0;
    if (!this.items.length) {
      this.empty.setText("Ничего не найдено");
      this.empty.style.display = "block";
      return;
    }
    this.empty.style.display = "none";
    this.items.forEach((item, i) => {
      const row = this.list.createDiv({ cls: "ps-row" });
      if (i === this.active) row.addClass("is-active");
      const icon = row.createSpan({ cls: "ps-row-icon" });
      setIcon(icon, item.isNew ? "file-plus" : "file-text");
      const text = row.createDiv({ cls: "ps-row-text" });
      const { name, dir } = splitPath(item.path);
      const nameEl = text.createSpan({ cls: "ps-row-name" });
      highlight(nameEl, name, item.hits, item.path.length - name.length);
      if (dir) {
        const dirEl = text.createSpan({ cls: "ps-row-dir", text: dir });
        if (item.hits.length) {
          dirEl.empty();
          highlight(dirEl, dir, item.hits, 0);
        }
      }
      if (item.isNew) row.createSpan({ cls: "ps-badge", text: "новая" });
      row.addEventListener("click", () => {
        this.active = i;
        this.pickActive();
      });
    });
  }
}

function previewLine(text) {
  const line = text.split("\n").find((l) => l.trim() !== "");
  if (!line) return "";
  const trimmed = line.trim().replace(/^(?:[-*+>#]+\s+|\d+[.)]\s+)/, "");
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed;
}

function highlight(el, text, hits, offset) {
  if (!hits || !hits.length) {
    el.setText(text);
    return;
  }
  let cursor = 0;
  for (const h of hits) {
    const i = h - offset;
    if (i < cursor || i >= text.length) continue;
    if (i > cursor) el.createSpan({ text: text.slice(cursor, i) });
    el.createSpan({ text: text[i], cls: "ps-hit" });
    cursor = i + 1;
  }
  if (cursor < text.length) el.createSpan({ text: text.slice(cursor) });
}

class ParaSwipeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Свайп вправо")
      .setDesc("Проведи пальцем вправо по абзацу — откроется мини-окошко со списком заметок.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.swipeEnabled).onChange(async (v) => {
          this.plugin.settings.swipeEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Порог свайпа")
      .setDesc("Сколько пикселей надо провести, чтобы сработало. Больше — меньше ложных срабатываний.")
      .addSlider((s) =>
        s
          .setLimits(30, 220, 5)
          .setValue(this.plugin.settings.swipeThreshold)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.swipeThreshold = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Иконка на ленте")
      .setDesc("Кнопка справа на экране — если свайп неудобен.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showRibbon).onChange(async (v) => {
          this.plugin.settings.showRibbon = v;
          await this.plugin.saveSettings();
          this.plugin.syncRibbon();
        })
      );

    new Setting(containerEl)
      .setName("Учитывать выделение")
      .setDesc("Если текст выделен — переносится выделение, иначе весь абзац под курсором.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useSelection).onChange(async (v) => {
          this.plugin.settings.useSelection = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Папка-фильтр")
      .setDesc("Ограничить список файлов одной папкой. Пусто — весь архив.")
      .addText((t) =>
        t
          .setPlaceholder("Projects")
          .setValue(this.plugin.settings.folder)
          .onChange(async (v) => {
            this.plugin.settings.folder = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

export default class ParagraphSwipePlugin extends Plugin {
  settings = { ...DEFAULT_SETTINGS };
  gesture = null;
  ribbon = null;
  modalOpen = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ParaSwipeSettingTab(this.app, this));
    this.syncRibbon();
    this.addCommand({
      id: "move-paragraph-to-file",
      name: "Перенести абзац в другой файл",
      callback: () => this.startMove(null),
    });

    const root = document;
    const opts = { capture: true };
    this.registerDomEvent(root, "touchstart", (e) => this.onTouchStart(e), { ...opts, passive: true });
    this.registerDomEvent(root, "touchmove", (e) => this.onTouchMove(e), { ...opts, passive: false });
    this.registerDomEvent(root, "touchend", () => { this.gesture = null; }, { ...opts, passive: true });
    this.registerDomEvent(root, "touchcancel", () => { this.gesture = null; }, { ...opts, passive: true });
  }

  syncRibbon() {
    if (this.settings.showRibbon && !this.ribbon) {
      this.ribbon = this.addRibbonIcon(RIBBON_ICON, "Перенести абзац в другой файл", () => this.startMove(null));
    } else if (!this.settings.showRibbon && this.ribbon) {
      this.ribbon.remove();
      this.ribbon = null;
    }
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  get activeEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.editor ? view.editor : null;
  }

  onTouchStart(e) {
    this.gesture = null;
    if (!this.settings.swipeEnabled || this.modalOpen) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX < 24 || t.clientX > window.innerWidth - 12) return;
    if (!(e.target instanceof Element) || !e.target.closest(".cm-editor")) return;
    const editor = this.activeEditor;
    if (!editor) return;
    this.gesture = {
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
      pos: this.posFromPoint(editor, t.clientX, t.clientY),
    };
  }

  onTouchMove(e) {
    const g = this.gesture;
    if (!g) return;
    const t = Array.from(e.touches).find((x) => x.identifier === g.id);
    if (!t) return;
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) > 16) {
      this.gesture = null;
      return;
    }
    const threshold = this.settings.swipeThreshold;
    if (dx > threshold && Math.abs(dy) < threshold * 0.7) {
      this.gesture = null;
      if (e.cancelable) e.preventDefault();
      this.startMove(g.pos);
    }
  }

  cursorPos(editor) {
    try {
      const c = editor.getCursor();
      return editor.state.doc.line(c.line).from + c.ch;
    } catch {
      return null;
    }
  }

  posFromPoint(editor, x, y) {
    try {
      const pos = editor.posAtCoords({ x, y });
      if (typeof pos === "number") return pos;
    } catch {
      /* ignore */
    }
    return this.cursorPos(editor);
  }

  startMove(pos) {
    const editor = this.activeEditor;
    if (!editor || this.modalOpen) return;
    const doc = editor.state.doc;
    const sel = editor.state.selection.main;
    let block;
    if (this.settings.useSelection && !sel.empty) {
      block = { from: sel.from, to: sel.to, text: doc.sliceString(sel.from, sel.to) };
    } else {
      const at = pos ?? this.cursorPos(editor) ?? doc.length;
      block = blockAt(doc, at);
    }
    if (!block.text.trim()) {
      new Notice("Пустая строка — переносить нечего");
      return;
    }
    this.modalOpen = true;
    new PickerModal(this.app, this, block.text, (path) => {
      this.performMove(editor, block, path);
    }).open();
  }

  async resolveTarget(path) {
    const found = this.app.vault.getAbstractFileByPath(path);
    if (found instanceof TFolder) return null;
    if (found instanceof TFile) return found;
    try {
      return await this.app.vault.create(path, "");
    } catch {
      return null;
    }
  }

  async performMove(editor, block, path) {
    this.modalOpen = false;
    const doc = editor.state.doc;
    const fresh = revalidate(doc, block);
    if (!fresh) {
      new Notice("Абзац изменился, попробуй ещё раз");
      return;
    }
    const target = await this.resolveTarget(path);
    if (!target) {
      new Notice("Не удалось открыть файл");
      return;
    }
    const text = fresh.text;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (view && view.file && view.file.path === target.path) {
      const r = removalRange(editor.state.doc, fresh);
      editor.dispatch({ changes: { from: r.from, to: r.to, insert: "" } });
      const end = editor.state.doc.length;
      editor.dispatch({ changes: { from: end, insert: `\n\n${text}` } });
      editor.focus();
      new Notice(`Абзац перенесён в конец «${target.name}»`);
      return;
    }

    const existing = await this.app.vault.read(target);
    const head = existing.replace(/\s+$/, "");
    const next = `${head ? `${head}\n\n` : ""}${text}\n`;
    try {
      await this.app.vault.modify(target, next);
    } catch {
      new Notice("Не удалось записать в файл");
      return;
    }

    const r = removalRange(editor.state.doc, fresh);
    const after = editor.state.doc.sliceString(r.to);
    const chunk = editor.state.doc.sliceString(r.from, r.to);
    const expected = editor.state.doc.sliceString(0, r.from) + after;
    editor.dispatch({ changes: { from: r.from, to: r.to, insert: "" } });
    editor.focus();

    const notice = new Notice(`Перенесено в «${target.name}»`, 10000);
    const undo = notice.messageEl.createEl("button", { cls: "ps-undo", text: "Отменить" });
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      const d = editor.state.doc;
      const byHistory = d.toString() === expected && typeof editor.undo === "function";
      let at = -1;
      if (!byHistory) {
        at = after === "" ? d.length : d.toString().indexOf(after);
        if (at < 0) {
          new Notice("Текст изменился — верни абзац вручную");
          return;
        }
      }
      try {
        const current = await this.app.vault.read(target);
        if (!current.startsWith(head)) {
          new Notice("Файл уже изменён — отмена не удалась");
          return;
        }
        await this.app.vault.modify(target, existing);
        if (byHistory) editor.undo();
        else editor.dispatch({ changes: { from: at, insert: chunk } });
        notice.hide();
        new Notice("Абзац вернулся обратно");
      } catch {
        new Notice("Не получилось отменить");
      }
    });
  }
}
