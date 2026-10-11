import fs from 'node:fs';

// Небольшое постоянное состояние агента (pid сервера, выбранные моды, расписание).
export class StateStore {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key, fallback) {
    return this.data[key] ?? fallback;
  }

  set(key, value) {
    this.data[key] = value;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// Журнал всех команд: кто, что, когда, результат. Одна запись — одна строка JSON.
export class AuditLog {
  constructor(file) {
    this.file = file;
  }

  write(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFile(this.file, line, (err) => {
      if (err) console.error('[audit] не удалось записать:', err.message);
    });
  }
}
