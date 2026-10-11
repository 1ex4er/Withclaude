// Автозапуск агента на Windows через Планировщик заданий: старт при загрузке системы,
// перезапуск при падении. Отдельные программы-обёртки (NSSM и т.п.) не нужны.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASK_NAME = 'LX Agent';

const xmlEscape = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function taskXml({ exe, args, workDir, user }) {
  // Без пользователя — от имени SYSTEM. С пользователем — от его имени (рекомендуется отдельный без прав админа).
  const principal = user
    ? `<UserId>${xmlEscape(user)}</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel>`
    : '<UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel>';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Агент управления DayZ-сервером (LX)</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger></Triggers>
  <Principals><Principal id="Author">${principal}</Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exe)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('Установка службы доступна только на Windows');
}

export function install({ exe, args, workDir, user, password }) {
  requireWindows();
  const xmlFile = path.join(os.tmpdir(), `lx-agent-task-${process.pid}.xml`);
  fs.writeFileSync(xmlFile, '\uFEFF' + taskXml({ exe, args, workDir, user }), 'utf16le');
  try {
    const args = ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'];
    if (user) args.push('/RU', user, '/RP', password ?? '');
    execFileSync('schtasks.exe', args, { stdio: 'inherit', windowsHide: true });
    execFileSync('schtasks.exe', ['/Run', '/TN', TASK_NAME], { stdio: 'inherit', windowsHide: true });
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }
  restrictKeysAcl(path.join(workDir, 'keys'), user);
}

export function uninstall() {
  requireWindows();
  try {
    execFileSync('schtasks.exe', ['/End', '/TN', TASK_NAME], { stdio: 'ignore', windowsHide: true });
  } catch {}
  execFileSync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'inherit', windowsHide: true });
}

// Папку с ключом могут читать только SYSTEM, администраторы и пользователь агента.
function restrictKeysAcl(dir, user) {
  if (!fs.existsSync(dir)) return;
  const grants = ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'];
  if (user) grants.push(`${user}:(OI)(CI)R`);
  const args = [dir, '/inheritance:r'];
  for (const g of grants) args.push('/grant:r', g);
  execFileSync('icacls.exe', args, { stdio: 'ignore', windowsHide: true });
}
