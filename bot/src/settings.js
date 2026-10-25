// Настройки, выбранные в Discord через /setup или на сайте (вкладка «Бот»), хранятся в БД
// и накладываются поверх config.json.

// Значение из config.json (или по умолчанию) до первой замены — чтобы «сбросить» вернуло его.
const base = new Map();

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

function remember(cfg, path) {
  if (!base.has(path)) base.set(path, structuredClone(getPath(cfg, path)));
}

export function applySettings(cfg, db) {
  const saved = db.kv.get('settings', {});
  for (const [path, value] of Object.entries(saved)) {
    remember(cfg, path);
    setPath(cfg, path, value);
  }
  return cfg;
}

export function savedSettings(db) {
  return db.kv.get('settings', {});
}

export function saveSetting(cfg, db, path, value) {
  const saved = db.kv.get('settings', {});
  saved[path] = value;
  db.kv.set('settings', saved);
  remember(cfg, path);
  setPath(cfg, path, value);
}

// Убрать сохранённое значение: снова действует config.json / значение по умолчанию.
export function resetSetting(cfg, db, path) {
  const saved = db.kv.get('settings', {});
  if (!(path in saved)) return false;
  delete saved[path];
  db.kv.set('settings', saved);
  if (base.has(path)) setPath(cfg, path, structuredClone(base.get(path)));
  return true;
}
