const fs = require("fs/promises");
const path = require("path");
const { validateDailySummary, validateWeeklySummary } = require("./scheduled-summary-schema");

class ScheduledSummaryStore {
    constructor(root) { if (!root) throw new Error("Scheduled summary-store root is required."); this.root = path.resolve(root); }
    dailyPath(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Invalid daily summary date."); return path.join(this.root, "daily", `${date}.json`); }
    weeklyPath(startDate) { if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) throw new Error("Invalid weekly summary start date."); return path.join(this.root, "weekly", `${startDate}.json`); }
    async writeAtomic(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`); await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); try { await fs.rename(temp, file); } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; } }
    async writeDaily(summary) { validateDailySummary(summary); await this.writeAtomic(this.dailyPath(summary.date), summary); return summary; }
    async writeWeekly(summary) { validateWeeklySummary(summary); await this.writeAtomic(this.weeklyPath(summary.period.start.slice(0, 10)), summary); return summary; }
    async readDaily(date) { const value = JSON.parse(await fs.readFile(this.dailyPath(date), "utf8")); validateDailySummary(value); return value; }
    async readWeekly(startDate) { const value = JSON.parse(await fs.readFile(this.weeklyPath(startDate), "utf8")); validateWeeklySummary(value); return value; }
}
module.exports = { ScheduledSummaryStore };
