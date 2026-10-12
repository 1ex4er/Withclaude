import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileManager, checkXml } from '../agent/src/files.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'));
  const server = path.join(base, 'server');
  fs.mkdirSync(path.join(server, 'battleye'), { recursive: true });
  fs.mkdirSync(path.join(server, 'mission', 'db'), { recursive: true });
  fs.writeFileSync(path.join(server, 'serverDZ.cfg'), 'hostname = "Blackout";\npasswordAdmin = "secret123";\nmaxPlayers = 60;\n');
  fs.writeFileSync(path.join(server, 'battleye', 'beserver_x64.cfg'), 'RConPassword 123');
  fs.writeFileSync(path.join(server, 'mission', 'db', 'types.xml'), '<types><type name="A"><nominal>1</nominal></type></types>');
  fs.writeFileSync(path.join(base, 'outside.cfg'), 'nope');
  const fm = new FileManager({
    roots: { server },
    extensions: ['.cfg', '.xml', '.json'],
    deny: ['beserver', 'battleye', 'keys', '.exe'],
    maskedCfgKeys: ['passwordAdmin'],
    maxSizeMb: 1,
    keepBackups: 3,
    backupDir: path.join(base, 'backups'),
  });
  return { base, server, fm };
}

test('нельзя выйти за пределы корня и читать запрещённое', () => {
  const { fm, base, server } = setup();
  assert.throws(() => fm.read('server', '../outside.cfg'), { code: 'bad_path' });
  assert.throws(() => fm.read('server', path.join(base, 'outside.cfg')), { code: 'bad_path' });
  assert.throws(() => fm.read('server', 'battleye/beserver_x64.cfg'), { code: 'denied' });
  assert.throws(() => fm.read('nope', 'serverDZ.cfg'), { code: 'bad_root' });
  fs.writeFileSync(path.join(server, 'run.bat'), 'x');
  assert.throws(() => fm.read('server', 'run.bat'), { code: 'denied' });
  assert.ok(!fm.list('server').some((e) => e.name === 'battleye' || e.name === 'run.bat'));
});

test('симлинк наружу не даёт доступа', { skip: process.platform === 'win32' }, () => {
  const { fm, base, server } = setup();
  fs.symlinkSync(path.join(base, 'outside.cfg'), path.join(server, 'link.cfg'));
  assert.throws(() => fm.read('server', 'link.cfg'), { code: 'bad_path' });
});

test('пароль админа скрыт и сохраняется при записи', () => {
  const { fm, server } = setup();
  const r = fm.read('server', 'serverDZ.cfg');
  assert.ok(!r.content.includes('secret123'));
  assert.deepEqual(r.masked, ['passwordAdmin']);
  fm.write('server', 'serverDZ.cfg', r.content.replace('60', '80'), r.sha, { name: 'admin' });
  const disk = fs.readFileSync(path.join(server, 'serverDZ.cfg'), 'utf8');
  assert.match(disk, /passwordAdmin = "secret123"/);
  assert.match(disk, /maxPlayers = 80/);
});

test('конфликт правок, проверка XML, бэкап и откат', () => {
  const { fm, server } = setup();
  const file = 'mission/db/types.xml';
  const r = fm.read('server', file);
  assert.throws(() => fm.write('server', file, '<types></types>', 'старый'), { code: 'conflict' });
  assert.throws(() => fm.write('server', file, '<types><type></types>', r.sha), { code: 'invalid' });
  const w = fm.write('server', file, '<types/>', r.sha);
  const backups = fm.backups('server', file);
  assert.equal(backups.length, 1);
  fm.restore('server', file, backups[0].id);
  assert.equal(fs.readFileSync(path.join(server, file), 'utf8'), '<types><type name="A"><nominal>1</nominal></type></types>');
  assert.notEqual(w.sha, fm.read('server', file).sha);
  assert.throws(() => fm.readBackup('server', file, '../../x.bak'), { code: 'bad_params' });
});

test('старые бэкапы удаляются', () => {
  const { fm } = setup();
  for (let i = 0; i < 6; i++) {
    const r = fm.read('server', 'serverDZ.cfg');
    fm.write('server', 'serverDZ.cfg', r.content + `// ${i}\n`, r.sha);
  }
  assert.ok(fm.backups('server', 'serverDZ.cfg').length <= 3);
});

test('checkXml', () => {
  assert.equal(checkXml('<?xml version="1.0"?>\n<!-- c --><types><type name="a" x=\'1\'/></types>\n'), null);
  assert.match(checkXml('<types><type></types>'), /закрывает/);
  assert.match(checkXml('<types>'), /не закрыт/);
  assert.match(checkXml('<a/><b/>'), /второй корневой/);
  assert.match(checkXml('<types name=x></types>'), /некорректный тег/);
  assert.match(checkXml('<types><!-- not closed </types>'), /строка 1/);
  assert.match(checkXml(''), /нет корневого/);
});

test('время обновления мода — по meta.cpp и addons/*.pbo', async () => {
  const { filesUpdatedAt } = await import('../agent/src/mods.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mod-'));
  fs.mkdirSync(path.join(dir, 'addons'));
  fs.writeFileSync(path.join(dir, 'meta.cpp'), 'publishedid = 1;');
  fs.writeFileSync(path.join(dir, 'addons', 'a.pbo'), 'x');
  fs.writeFileSync(path.join(dir, 'addons', 'readme.txt'), 'x');
  fs.utimesSync(path.join(dir, 'meta.cpp'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'addons', 'a.pbo'), 2000, 2000);
  fs.utimesSync(path.join(dir, 'addons', 'readme.txt'), 9000, 9000);
  assert.equal(filesUpdatedAt(dir), 2_000_000);
  assert.equal(filesUpdatedAt(path.join(dir, 'nope')), null);
});
