/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { sessionId } from './session.js';

type LogLevel = 'LOG' | 'WARN' | 'ERROR' | 'DEBUG';

const DEBUG_ENABLED = (() => {
  const raw = process.env['DEBUG'];
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
})();

const LOG_DIR = path.join(os.homedir(), '.gemini', 'tmp');
const LOG_FILE = path.join(LOG_DIR, `gemini-debug-${sessionId}.log`);

class DebugLogger {
  private stream: fs.WriteStream | null = null;
  private streamFailed = false;

  log(...args: unknown[]): void {
    this.write('LOG', args);
  }

  warn(...args: unknown[]): void {
    this.write('WARN', args);
  }

  error(...args: unknown[]): void {
    this.write('ERROR', args);
  }

  debug(...args: unknown[]): void {
    this.write('DEBUG', args);
  }

  closeStreamForTests(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.streamFailed = false;
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (!DEBUG_ENABLED || this.streamFailed) {
      this.forwardToConsole(level, args);
      return;
    }

    const stream = this.getStream();
    if (!stream) {
      this.forwardToConsole(level, args);
      return;
    }

    const timestamp = new Date().toISOString();
    const content = util.format(...args);
    stream.write(`${timestamp} [${level}] ${content}\n`);
  }

  private getStream(): fs.WriteStream | null {
    if (this.stream || this.streamFailed === true) {
      return this.stream;
    }

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      this.stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      this.stream.on('error', () => {
        this.streamFailed = true;
        this.stream?.end();
        this.stream = null;
      });
      return this.stream;
    } catch {
      this.streamFailed = true;
      return null;
    }
  }

  private forwardToConsole(level: LogLevel, args: unknown[]): void {
    if (level === 'LOG') {
      console.log(...args);
    } else if (level === 'WARN') {
      console.warn(...args);
    } else if (level === 'ERROR') {
      console.error(...args);
    } else {
      console.debug(...args);
    }
  }
}

export const debugLogger = new DebugLogger();
