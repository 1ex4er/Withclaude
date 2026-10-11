import path from 'node:path';
import { fileURLToPath } from 'node:url';

// __IS_EXE__, __VERSION__, __LX_SITE_PUBLIC_KEY__ подставляет сборщик (tools/build-exe.js).
/* global __IS_EXE__, __VERSION__, __LX_SITE_PUBLIC_KEY__ */
export const IS_EXE = typeof __IS_EXE__ !== 'undefined' && __IS_EXE__;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
export const LX_SITE_PUBLIC_KEY = typeof __LX_SITE_PUBLIC_KEY__ !== 'undefined' ? __LX_SITE_PUBLIC_KEY__ : null;

// Собранный .exe хранит конфиг, ключи и журналы рядом с собой; при запуске из исходников — в agent/.
export function appDir() {
  if (IS_EXE) return path.dirname(process.execPath);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
