import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const EMPTY_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

function abortError(reason) {
  return Object.assign(new Error('任务已取消'), { name: 'AbortError', reason });
}

async function statSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function createEmptyZip(destination) {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.writeFile(temporary, EMPTY_ZIP, { flag: 'wx', mode: 0o600 });
  await fsp.rename(temporary, destination);
  return { bytes: EMPTY_ZIP.length };
}

export async function runZip9({ cwd, names, destination, maxBytes, signal }) {
  if (!Array.isArray(names) || names.length === 0) return createEmptyZip(destination);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    let settled = false;
    let limitExceeded = false;
    let stderr = '';
    let sizeTimer = null;
    const child = spawn('zip', ['-9', '-r', temporary, '--', ...names], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    const finish = async (error = null) => {
      if (settled) return;
      settled = true;
      clearInterval(sizeTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        reject(error);
        return;
      }
      try {
        const bytes = await statSize(temporary);
        if (bytes > maxBytes) {
          throw Object.assign(
            new Error(`附件压缩后超过 ${maxBytes} 字节限制`),
            { code: 'COMPRESSED_LIMIT' },
          );
        }
        await fsp.rename(temporary, destination);
        resolve({ bytes });
      } catch (renameError) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        reject(renameError);
      }
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      void finish(abortError(signal?.reason));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => {
      const message = error?.code === 'ENOENT'
        ? '服务器缺少 zip 命令，请安装 Info-ZIP zip'
        : `启动 zip 失败：${error.message}`;
      void finish(new Error(message));
    });
    child.once('exit', (code, childSignal) => {
      if (settled) return;
      if (limitExceeded) {
        void finish(Object.assign(
          new Error(`附件压缩后超过 ${maxBytes} 字节限制`),
          { code: 'COMPRESSED_LIMIT' },
        ));
        return;
      }
      if (code !== 0) {
        void finish(new Error(`zip 压缩失败（退出码 ${code ?? childSignal ?? 'unknown'}）：${stderr.trim() || '没有错误详情'}`));
        return;
      }
      void finish();
    });

    sizeTimer = setInterval(() => {
      void statSize(temporary).then((bytes) => {
        if (!settled && bytes > maxBytes) {
          limitExceeded = true;
          child.kill('SIGKILL');
        }
      }).catch((error) => {
        if (!settled) {
          child.kill('SIGKILL');
          void finish(error);
        }
      });
    }, 100);
    sizeTimer.unref?.();
  });
}

export async function createNestedTurnArchive({ chatDir, chatId, turnNumbers, turnPath, destination, maxBytes, signal }) {
  const workDir = path.join(chatDir, '.work', `${chatId}-${turnNumbers.at(-1) || 0}-${randomUUID()}`);
  await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    const names = [];
    for (const turnNo of turnNumbers) {
      if (signal?.aborted) throw abortError(signal.reason);
      const name = `${turnNo}.zip`;
      const source = turnPath(turnNo);
      const target = path.join(workDir, name);
      try {
        await fsp.link(source, target);
      } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error;
        await fsp.copyFile(source, target);
      }
      names.push(name);
    }
    return await runZip9({ cwd: workDir, names, destination, maxBytes, signal });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
