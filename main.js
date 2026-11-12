const { Plugin, PluginSettingTab, Setting, Notice, Modal, debounce } = require("obsidian");
const { EditorView } = require("@codemirror/view");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // your local timezone
const DEFAULTS = {
  alarmMinutes: 10,
  durationMinutes: 30,
  defaultTime: "09:00",
  edsSync: true,            // push events straight into the Mint/GNOME calendar (Evolution Data Server)
  edsCalendar: "",          // blank = default calendar
  pythonPath: "/usr/bin/python3",
  desktopNotify: false,     // notify-send popups via systemd timers
  obsidianNotify: true,     // popups inside Obsidian
  writeFile: false,         // also write an .ics file
  outputPath: "~/journal/reminders.ics",
  state: { eds: {}, timers: {}, ids: [] }, // what each backend already has, plus the stable id of every reminder
};
const INSTALL_HINT = "sudo apt install evolution-data-server gir1.2-ecal-2.0 gir1.2-edataserver-1.2 python3-gi";

// ---------- parsing ----------
// Two accepted styles (add "🔁every monday" for repeats):
//   - [ ] Call supervisor (@2026-11-05 14:00 🔁every monday)
//   @2026-11-05 14:00 Call supervisor 🔁every monday
const RE_TASK = /^\s*[-*+]\s+\[ \]\s+(.*?)\s*\(@(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?([^)]*)\)\s*$/;
const RE_PLAIN = /^\s*@(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;

const DAYS = { monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" };
const UNITS = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" };

// "every monday" / "every weekday" / "every 2 weeks" / "every month"  ->  RRULE text (or "")
function parseRecurrence(phrase) {
  const p = phrase.toLowerCase().replace("when done", "").trim();
  let m = p.match(/^every\s+(\w+)$/);
  if (m && DAYS[m[1]]) return "FREQ=WEEKLY;BYDAY=" + DAYS[m[1]];
  if (m && m[1] === "weekday") return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  m = p.match(/^every\s+(\d+\s+)?(day|week|month|year)s?$/);
  if (m) return `FREQ=${UNITS[m[2]]};INTERVAL=${parseInt(m[1]) || 1}`;
  return "";
}

// Splits "Call supervisor 🔁every monday" into text and rrule
function splitRecurrence(text) {
  const i = text.indexOf("🔁");
  if (i < 0) return { text: text.trim(), rrule: "" };
  return { text: text.slice(0, i).trim(), rrule: parseRecurrence(text.slice(i + 2)) };
}

function parseLine(line, defaultTime) {
  let m = line.match(RE_TASK);
  if (m) {
    const r = splitRecurrence(m[1] + " " + m[4]);
    return { text: r.text, date: m[2], time: m[3] || defaultTime, rrule: r.rrule };
  }
  m = line.match(RE_PLAIN);
  if (m) {
    const r = splitRecurrence(m[3]);
    return { text: r.text, date: m[1], time: m[2], rrule: r.rrule };
  }
  return null;
}

function makeUid(s) {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(16) + "@obsidian-ics-reminders";
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const icsStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const startOf = (r) => {
  const [y, mo, d] = r.date.split("-").map(Number);
  const [h, mi] = r.time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi);
};
const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Does reminder r happen on this calendar day? (day = local midnight)
function occursOn(r, day) {
  const s = startOf(r);
  const first = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  if (day < first) return false;
  if (!r.rrule) return day.getTime() === first.getTime();
  const rule = Object.fromEntries(r.rrule.split(";").map((p) => p.split("=")));
  const n = parseInt(rule.INTERVAL) || 1;
  const days = Math.round((day - first) / 86400000);
  if (rule.FREQ === "DAILY") return days % n === 0;
  if (rule.FREQ === "WEEKLY") {
    const allowed = rule.BYDAY ? rule.BYDAY.split(",") : [WEEKDAY[first.getDay()]];
    const weeks = Math.floor((days + ((first.getDay() + 6) % 7)) / 7); // weeks since the Monday of the first week
    return allowed.includes(WEEKDAY[day.getDay()]) && weeks % n === 0;
  }
  if (rule.FREQ === "MONTHLY") {
    const months = (day.getFullYear() - first.getFullYear()) * 12 + day.getMonth() - first.getMonth();
    return day.getDate() === first.getDate() && months % n === 0;
  }
  if (rule.FREQ === "YEARLY") {
    return day.getMonth() === first.getMonth() && day.getDate() === first.getDate() && (day.getFullYear() - first.getFullYear()) % n === 0;
  }
  return false;
}

// A one-off reminder whose time has passed
const isPast = (r, durationMinutes) => !r.rrule && startOf(r).getTime() + durationMinutes * 60000 < Date.now();

// ---------- calendar (.ics) ----------
const escapeText = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,");

function veventLines(r, alarmMinutes, durationMinutes) {
  const start = startOf(r);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return [
    "BEGIN:VEVENT",
    `UID:${r.uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;TZID=${TZ}:${icsStamp(start)}`,
    `DTEND;TZID=${TZ}:${icsStamp(end)}`,
    ...(r.rrule ? [`RRULE:${r.rrule}`] : []),
    `SUMMARY:${escapeText(r.text)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(r.text)}`,
    `TRIGGER:-PT${alarmMinutes}M`,
    "END:VALARM",
    "END:VEVENT",
  ];
}

function buildIcs(reminders, alarmMinutes, durationMinutes) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//obsidian-ics-reminders//EN", `X-WR-TIMEZONE:${TZ}`];
  for (const r of reminders) lines.push(...veventLines(r, alarmMinutes, durationMinutes));
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------- desktop notifications (systemd timers + notify-send) ----------
const SD_DAY = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const unitName = (uid) => "ics-reminder-" + uid.split("@")[0];

// systemd OnCalendar text for when to pop the notification, or "" if it can't be expressed
function onCalendarFor(r, alarmMinutes) {
  const start = startOf(r);
  let fire = new Date(start.getTime() - alarmMinutes * 60000);
  if (!r.rrule) return fire.getTime() < Date.now() ? "" : `${ymd(fire)} ${pad(fire.getHours())}:${pad(fire.getMinutes())}:00`;
  if (ymd(fire) !== ymd(start)) fire = new Date(start.getFullYear(), start.getMonth(), start.getDate()); // keep it on the same day
  const t = `${pad(fire.getHours())}:${pad(fire.getMinutes())}:00`;
  const rule = Object.fromEntries(r.rrule.split(";").map((p) => p.split("=")));
  if ((parseInt(rule.INTERVAL) || 1) !== 1) return ""; // "every 2 weeks" etc.: only the in-Obsidian popup handles these
  if (rule.FREQ === "DAILY") return `*-*-* ${t}`;
  if (rule.FREQ === "WEEKLY") {
    const days = (rule.BYDAY ? rule.BYDAY.split(",") : [WEEKDAY[start.getDay()]]).map((d) => SD_DAY[d]);
    return `${days.join(",")} *-*-* ${t}`;
  }
  if (rule.FREQ === "MONTHLY") return `*-*-${pad(start.getDate())} ${t}`;
  if (rule.FREQ === "YEARLY") return `*-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${t}`;
  return "";
}

// Runs a program, optionally feeding it stdin. Resolves with stdout.
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `exit code ${code}`))));
    p.stdin.end(input || "");
  });
}

const REPEATS = ["", "every day", "every weekday", "every week", "every 2 weeks", "every month", "every year"];

// Clean popup: quick date chips, date + 24h time, optional repeat, live preview
class DateModal extends Modal {
  constructor(app, withRepeat, onSubmit) {
    super(app);
    this.withRepeat = withRepeat;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("ics-picker");
    contentEl.createDiv({ text: "New reminder", cls: "ics-title" });

    const start = new Date();
    start.setHours(start.getHours() + 1, 0, 0, 0);

    const chips = contentEl.createDiv({ cls: "ics-chips" });
    const row = contentEl.createDiv({ cls: "ics-row" });

    const dateField = row.createDiv({ cls: "ics-field" });
    dateField.createEl("label", { text: "Date" });
    const dateInput = dateField.createEl("input", { type: "date" });
    dateInput.value = ymd(start);

    const timeField = row.createDiv({ cls: "ics-field" });
    timeField.createEl("label", { text: "Time (24h)" });
    const time = timeField.createDiv({ cls: "ics-time" });
    const hh = time.createEl("select");
    for (let i = 0; i < 24; i++) hh.createEl("option", { text: pad(i), value: pad(i) });
    time.createEl("span", { text: ":" });
    const mm = time.createEl("select");
    for (let i = 0; i < 60; i += 5) mm.createEl("option", { text: pad(i), value: pad(i) });
    hh.value = pad(start.getHours());
    mm.value = "00";

    let select = null;
    if (this.withRepeat) {
      const repField = contentEl.createDiv({ cls: "ics-field ics-repeat" });
      repField.createEl("label", { text: "Repeat" });
      select = repField.createEl("select");
      for (const r of REPEATS) select.createEl("option", { text: r || "Does not repeat", value: r });
    }

    const preview = contentEl.createDiv({ cls: "ics-preview" });
    const update = () => {
      if (!dateInput.value) return preview.setText("Pick a date");
      const [y, m, d] = dateInput.value.split("-").map(Number);
      const day = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      preview.setText(`${day}, ${hh.value}:${mm.value}  ·  local time (${TZ})`);
    };
    for (const el of [dateInput, hh, mm]) el.addEventListener("change", update);
    update();

    const addDays = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return ymd(d);
    };
    const nextMonday = () => addDays((8 - new Date().getDay()) % 7 || 7);
    for (const [label, get] of [["Today", () => addDays(0)], ["Tomorrow", () => addDays(1)], ["Next Monday", nextMonday]]) {
      chips.createEl("button", { text: label, cls: "ics-chip" }).onclick = () => {
        dateInput.value = get();
        update();
      };
    }

    const submit = () => {
      if (!dateInput.value) return;
      this.close();
      this.onSubmit(`${dateInput.value} ${hh.value}:${mm.value}`, select ? select.value : "");
    };
    const footer = contentEl.createDiv({ cls: "ics-footer" });
    footer.createEl("button", { text: "Cancel", cls: "ics-ghost" }).onclick = () => this.close();
    footer.createEl("button", { text: "Insert", cls: "mod-cta" }).onclick = submit;
    this.scope.register([], "Enter", submit);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class IcsRemindersPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.state = Object.assign({ eds: {}, timers: {}, ids: [] }, this.settings.state);
    for (const k of ["eds", "timers"]) {
      // older versions stored a plain list of ids: treat them as "sent, content unknown" so they get cleaned up
      if (Array.isArray(this.settings.state[k])) this.settings.state[k] = Object.fromEntries(this.settings.state[k].map((u) => [u, ""]));
    }
    this.current = new Map(); // uid -> reminder, as found in the notes right now
    this.fired = new Set();   // in-Obsidian popups already shown
    this.addSettingTab(new IcsSettingTab(this.app, this));

    this.addCommand({
      id: "sync-reminders",
      name: "Sync reminders now (full re-send)",
      callback: () => {
        this.settings.state.eds = {};
        this.settings.state.timers = {};
        this.syncAll(true);
      },
    });

    // Typing "@" at line start, or "(@", opens the date picker
    this.registerEditorExtension(
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || !u.transactions.some((t) => t.isUserEvent("input.type"))) return;
        const pos = u.state.selection.main.head;
        const line = u.state.doc.lineAt(pos);
        const before = line.text.slice(0, pos - line.from);
        const inParens = /\(@$/.test(before);
        if (!inParens && !/^\s*@$/.test(before)) return;
        setTimeout(() => this.pickDate(u.view, pos, inParens), 0);
      })
    );

    // Every save: look for new / removed / changed reminders and sync only those
    const later = debounce(() => this.syncAll(false), 2000, true);
    this.registerEvent(this.app.vault.on("modify", later));
    this.registerEvent(this.app.vault.on("delete", later));
    this.registerEvent(this.app.vault.on("rename", later));
    this.app.workspace.onLayoutReady(() => {
      this.settings.state.timers = {}; // systemd timers vanish on reboot, so re-create them at startup
      this.syncAll(false);
    });

    this.registerInterval(window.setInterval(() => this.checkDue(), 30000));
  }

  pickDate(view, pos, inParens) {
    new DateModal(this.app, inParens, (dateTime, repeat) => {
      let text = dateTime;
      if (repeat) text += " 🔁" + repeat;
      const next = view.state.doc.sliceString(pos, pos + 1);
      if (inParens && next !== ")") text += ")";
      else if (!inParens) text += " ";
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    }).open();
  }

  outPath() {
    return this.settings.outputPath.replace(/^~/, os.homedir());
  }

  helperPath() {
    return path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, "eds_sync.py");
  }

  // All reminders in the vault, keyed by their stable id
  async collect() {
    const list = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      content.split("\n").forEach((line, i) => {
        const r = parseLine(line, this.settings.defaultTime);
        if (!r) return;
        r.hash = `${r.date} ${r.time} ${r.text} ${r.rrule}`; // what the reminder says
        r.key = `${file.path}:${i}`;                           // where it is
        list.push(r);
      });
    }
    return new Map(this.assignIds(list).map((r) => [r.uid, r]));
  }

  // Gives every reminder an id that survives edits, so changing its time or text updates the same
  // calendar entry instead of creating a new one.
  assignIds(list) {
    const todo = [...new Map(list.map((r) => [r.hash, r])).values()]; // identical lines count once
    const unused = new Set(this.settings.state.ids); // {uid, hash, key} from the previous save
    const used = new Set();
    const take = (r, p) => { r.uid = p.uid; used.add(p.uid); unused.delete(p); };
    // 1. same text as before: same entry
    for (const r of todo) {
      const p = [...unused].find((p) => p.hash === r.hash);
      if (p) take(r, p);
    }
    // 2. not found by text, but same note and line as before: the reminder was edited
    for (const r of todo.filter((r) => !r.uid)) {
      const p = [...unused].find((p) => p.key === r.key);
      if (p) take(r, p);
    }
    // 3. brand new
    for (const r of todo.filter((r) => !r.uid)) {
      let uid = makeUid(r.hash);
      while (used.has(uid)) uid = makeUid(r.hash + Math.random());
      r.uid = uid;
      used.add(uid);
    }
    this.settings.state.ids = todo.map((r) => ({ uid: r.uid, hash: r.hash, key: r.key }));
    return todo;
  }

  async syncAll(showNotice) {
    if (this.syncing) { this.again = true; return; }
    this.syncing = true;
    const s = this.settings;
    try {
      this.current = await this.collect();
      if (s.writeFile) {
        fs.mkdirSync(path.dirname(this.outPath()), { recursive: true });
        fs.writeFileSync(this.outPath(), buildIcs([...this.current.values()], s.alarmMinutes, s.durationMinutes));
      }
      if (s.edsSync) await this.applyDiff("eds", (add, del) => this.edsApply(add, del));
      else s.state.eds = {};
      if (s.desktopNotify) await this.applyDiff("timers", (add, del) => this.timersApply(add, del));
      else s.state.timers = {};
      await this.saveData(this.settings);
      if (showNotice) new Notice(`Synced ${this.current.size} reminder(s).`);
    } catch (e) {
      new Notice("ICS Reminders: " + e.message, 8000);
      console.error(e);
    } finally {
      this.syncing = false;
      if (this.again) { this.again = false; this.syncAll(false); }
    }
  }

  // Compare what is in the notes now with what this backend already has; send only the difference
  async applyDiff(name, apply) {
    const sent = this.settings.state[name]; // id -> text last sent
    const added = [...this.current.values()].filter((r) => sent[r.uid] !== r.hash && !isPast(r, this.settings.durationMinutes));
    const removed = Object.keys(sent).filter((uid) => !this.current.has(uid));
    const nowSent = () => Object.fromEntries([...this.current.values()].map((r) => [r.uid, r.hash]));
    try {
      if (added.length || removed.length) await apply(added, removed);
      this.settings.state[name] = nowSent();
    } catch (e) {
      const hint = /No module named|Namespace \w+ not available/.test(e.message) ? `\nInstall with: ${INSTALL_HINT}` : "";
      new Notice(`ICS Reminders (${name}): ${e.message}${hint}`, 10000);
    }
  }

  // Backend 1: the Mint / GNOME calendar (Evolution Data Server)
  async edsApply(added, removed) {
    const s = this.settings;
    const payload = JSON.stringify({
      calendar: s.edsCalendar,
      upsert: added.map((r) => ({ uid: r.uid, ics: veventLines(r, s.alarmMinutes, s.durationMinutes).join("\r\n") })),
      delete: removed,
    });
    await run(s.pythonPath, [this.helperPath()], payload);
  }

  // Backend 2: desktop popups at the right time, even if Obsidian is closed later
  async timersApply(added, removed) {
    for (const uid of removed) await run("systemctl", ["--user", "stop", unitName(uid) + ".timer"]).catch(() => {});
    for (const r of added) {
      const when = onCalendarFor(r, this.settings.alarmMinutes);
      if (!when) continue;
      await run("systemctl", ["--user", "stop", unitName(r.uid) + ".timer"]).catch(() => {});
      await run("systemd-run", ["--user", "--quiet", `--unit=${unitName(r.uid)}`, `--on-calendar=${when}`,
        "--timer-property=AccuracySec=1s", "notify-send", "-a", "Obsidian", "Reminder", `${r.time}  ${r.text}`]);
    }
  }

  // Backend 3: popups inside Obsidian (needs Obsidian open)
  checkDue() {
    if (!this.settings.obsidianNotify) return;
    const now = Date.now();
    const lead = this.settings.alarmMinutes * 60000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const r of this.current.values()) {
      for (const offset of [-1, 0, 1]) {
        const day = new Date(today);
        day.setDate(day.getDate() + offset);
        if (!occursOn(r, day)) continue;
        const [h, m] = r.time.split(":").map(Number);
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
        const key = `${r.uid}@${start}`;
        if (now >= start - lead && now < start + 10 * 60000 && !this.fired.has(key)) {
          this.fired.add(key);
          new Notice(`⏰ ${r.time}  ${r.text}`, 0); // stays until you click it
        }
      }
    }
  }
}

class IcsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async (key, value) => {
      s[key] = value;
      await this.plugin.saveData(s);
    };
    const text = (name, desc, key, number) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addText((t) => t.setValue(String(s[key])).onChange((v) => save(key, number ? Number(v) || 0 : v)));
    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addToggle((t) => t.setValue(s[key]).onChange((v) => save(key, v)));

    new Setting(containerEl).setName("Calendar app (Mint / GNOME)").setHeading();
    toggle("Sync to calendar on save", "On every save, new / changed / removed reminders are sent straight to your system calendar (the one the Cinnamon panel clock, GNOME Calendar and Evolution show).", "edsSync");
    text("Calendar name", "Leave blank for your default calendar.", "edsCalendar");
    text("Python path", "Must be the system Python that has the 'gi' module.", "pythonPath");
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Lists your calendars. If it fails: " + INSTALL_HINT)
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            const out = await run(s.pythonPath, [this.plugin.helperPath(), "--list"]);
            new Notice("Calendars found:\n" + out.trim(), 8000);
          } catch (e) {
            new Notice("Failed: " + e.message + "\nInstall with: " + INSTALL_HINT, 12000);
          }
        })
      );

    new Setting(containerEl).setName("Other notifications").setHeading();
    toggle("Desktop notifications (notify-send)", "Schedules a popup with systemd timers. Re-created each time Obsidian starts.", "desktopNotify");
    toggle("Popups inside Obsidian", "A sticky popup in Obsidian when a reminder is due (Obsidian must be open).", "obsidianNotify");

    new Setting(containerEl).setName("Timing").setHeading();
    text("Alarm (minutes before)", "", "alarmMinutes", true);
    text("Event length (minutes)", "", "durationMinutes", true);
    text("Default time", "Used when a reminder has a date but no time (HH:MM).", "defaultTime");

    new Setting(containerEl).setName("Also write an .ics file").setHeading();
    toggle("Write .ics file", "For calendar apps that can only subscribe to a file (e.g. Thunderbird).", "writeFile");
    text("Output .ics file", "Full path.", "outputPath");
  }
}

module.exports = IcsRemindersPlugin;
module.exports.parseLine = parseLine;
module.exports.buildIcs = buildIcs;
module.exports.occursOn = occursOn;
module.exports.onCalendarFor = onCalendarFor;
module.exports.makeUid = makeUid;
