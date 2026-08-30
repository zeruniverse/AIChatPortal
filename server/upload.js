import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

class SharedUploadLimiter extends Transform {
  constructor(state, maxBytes) {
    super();
    this.state = state;
    this.maxBytes = maxBytes;
  }

  _transform(chunk, _encoding, callback) {
    if (this.state.exceeded) {
      callback();
      return;
    }
    this.state.bytes += chunk.length;
    if (this.state.bytes > this.maxBytes) {
      this.state.exceeded = true;
      this.state.error ||= Object.assign(
        new Error('上传文件原始总大小超过服务器限制'),
        { code: 'RAW_UPLOAD_LIMIT' },
      );
      callback();
      return;
    }
    callback(null, chunk);
  }
}

export async function parseMultipartRequest(req, { chatDir, maxRawUploadBytes, maxFiles, maxPromptChars }) {
  const uploadDir = path.join(chatDir, '.uploads', randomUUID());
  await fsp.mkdir(uploadDir, { recursive: true, mode: 0o700 });

  const state = { bytes: 0, exceeded: false, error: null };
  const fields = {};
  const files = [];
  const writes = [];
  let parseError = null;

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: {
        files: maxFiles,
        fields: 10,
        parts: maxFiles + 10,
        fieldSize: Math.max(maxPromptChars * 4, 64 * 1024),
      },
    });
  } catch (error) {
    await fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  busboy.on('field', (name, value, info) => {
    if (info.valueTruncated) {
      parseError ||= Object.assign(new Error('表单字段过长'), { code: 'FIELD_LIMIT' });
      return;
    }
    fields[name] = value;
  });

  busboy.on('file', (fieldName, file, info) => {
    if (fieldName !== 'attachments') {
      file.resume();
      return;
    }
    const tempPath = path.join(uploadDir, `${String(files.length + 1).padStart(4, '0')}-${randomUUID()}`);
    const record = {
      tempPath,
      originalName: info.filename || `attachment-${files.length + 1}`,
      mimeType: info.mimeType || 'application/octet-stream',
      encoding: info.encoding || 'binary',
    };
    files.push(record);
    const write = pipeline(
      file,
      new SharedUploadLimiter(state, maxRawUploadBytes),
      fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    ).catch((error) => {
      parseError ||= error;
    });
    writes.push(write);
  });

  busboy.on('fieldsLimit', () => {
    parseError ||= Object.assign(new Error('表单字段数量过多'), { code: 'FIELD_LIMIT' });
  });
  busboy.on('filesLimit', () => {
    parseError ||= Object.assign(new Error(`附件数量不能超过 ${maxFiles}`), { code: 'FILES_LIMIT' });
  });
  busboy.on('partsLimit', () => {
    parseError ||= Object.assign(new Error('表单项目过多'), { code: 'PARTS_LIMIT' });
  });
  busboy.on('error', (error) => {
    parseError ||= error;
  });

  try {
    await new Promise((resolve, reject) => {
      const cleanupListeners = () => {
        req.off('aborted', onAborted);
        req.off('error', onRequestError);
      };
      const onClose = () => {
        cleanupListeners();
        resolve();
      };
      const onBusboyError = (error) => {
        cleanupListeners();
        reject(error);
      };
      const onAborted = () => {
        cleanupListeners();
        reject(Object.assign(new Error('上传连接已中断'), { code: 'UPLOAD_ABORTED' }));
      };
      const onRequestError = (error) => {
        cleanupListeners();
        reject(error);
      };
      busboy.once('close', onClose);
      busboy.once('error', onBusboyError);
      req.once('aborted', onAborted);
      req.once('error', onRequestError);
      req.pipe(busboy);
    });
    await Promise.all(writes);
    parseError ||= state.error;
    if (parseError) throw parseError;
    return {
      fields,
      files,
      directory: uploadDir,
      rawBytes: state.bytes,
      cleanup: () => fsp.rm(uploadDir, { recursive: true, force: true }),
    };
  } catch (error) {
    req.unpipe(busboy);
    busboy.destroy();
    await Promise.allSettled(writes);
    await fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
