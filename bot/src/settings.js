// Настройки, выбранные в Discord через /setup, хранятся в БД и накладываются поверх config.json.

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

export function applySettings(cfg, db) {
  const saved = db.kv.get('settings', {});
  for (const [path, value] of Object.entries(saved)) setPath(cfg, path, value);
  return cfg;
}

export function saveSetting(cfg, db, path, value) {
  const saved = db.kv.get('settings', {});
  saved[path] = value;
  db.kv.set('settings', saved);
  setPath(cfg, path, value);
}
