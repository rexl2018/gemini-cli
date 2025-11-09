/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteStream } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_SESSION_ID = 'test-session-id';

vi.mock('./session.js', () => ({
  sessionId: TEST_SESSION_ID,
}));

const mockTempDir = path.join('/tmp', 'gemini-test-home');

const mockWriteStream = {
  write: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
};

const mkdirSyncMock = vi.fn();
const createWriteStreamMock = vi.fn(
  () => mockWriteStream as unknown as WriteStream,
);

type LoggerModule = typeof import('./debugLogger.js');

vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof import('node:os')>();
  return {
    ...actualOs,
    homedir: () => mockTempDir,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof import('node:fs')>();
  return {
    ...actualFs,
    mkdirSync: mkdirSyncMock,
    createWriteStream: createWriteStreamMock,
  };
});

describe('DebugLogger', () => {
  let loggerModule: LoggerModule;
  const originalDebug = process.env['DEBUG'];

  const reloadLogger = async () => {
    vi.resetModules();
    loggerModule = await import('./debugLogger.js');
    return loggerModule.debugLogger;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['DEBUG'] = originalDebug;
    await reloadLogger();
  });

  afterEach(() => {
    loggerModule.debugLogger.closeStreamForTests();
    process.env['DEBUG'] = originalDebug;
  });

  describe('when DEBUG is not enabled', () => {
    beforeEach(async () => {
      delete process.env['DEBUG'];
      await reloadLogger();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('delegates log level methods to console', () => {
      const logger = loggerModule.debugLogger;
      const error = new Error('boom');

      logger.log('log message', { foo: 'bar' });
      logger.warn('warn message');
      logger.error('error message', error);
      logger.debug('debug message');

      expect(console.log).toHaveBeenCalledWith('log message', { foo: 'bar' });
      expect(console.warn).toHaveBeenCalledWith('warn message');
      expect(console.error).toHaveBeenCalledWith('error message', error);
      expect(console.debug).toHaveBeenCalledWith('debug message');
    });
  });

  describe('when DEBUG is enabled', () => {
    const expectedDir = path.join(mockTempDir, '.gemini', 'tmp');
    const expectedFile = path.join(
      expectedDir,
      `gemini-debug-${TEST_SESSION_ID}.log`,
    );

    beforeEach(async () => {
      process.env['DEBUG'] = '1';
      await reloadLogger();
    });

    it('initialises the destination directory lazily', () => {
      loggerModule.debugLogger.log('test');
      expect(mkdirSyncMock).toHaveBeenCalledWith(expectedDir, {
        recursive: true,
      });
    });

    it('creates a write stream in append mode', () => {
      loggerModule.debugLogger.warn('warn');
      expect(createWriteStreamMock).toHaveBeenCalledWith(expectedFile, {
        flags: 'a',
      });
    });

    it('writes formatted log entries with timestamp and level', () => {
      loggerModule.debugLogger.log('hello %s', 'world');
      expect(mockWriteStream.write).toHaveBeenCalledTimes(1);
      const payload = mockWriteStream.write.mock.calls[0][0] as string;
      expect(payload).toMatch(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[LOG\] hello world\n/,
      );
    });

    it('writes each severity level with the correct label', () => {
      loggerModule.debugLogger.warn('warning');
      loggerModule.debugLogger.error('error');
      loggerModule.debugLogger.debug('debug');

      expect(mockWriteStream.write).toHaveBeenCalledTimes(3);
      const [warnLine, errorLine, debugLine] =
        mockWriteStream.write.mock.calls.map((call) => call[0] as string);
      expect(warnLine).toContain('[WARN] warning');
      expect(errorLine).toContain('[ERROR] error');
      expect(debugLine).toContain('[DEBUG] debug');
    });

    it('does not invoke console methods in debug mode', () => {
      const spies = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      };

      loggerModule.debugLogger.log('a');
      loggerModule.debugLogger.warn('b');
      loggerModule.debugLogger.error('c');
      loggerModule.debugLogger.debug('d');

      expect(spies.log).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
      expect(spies.error).not.toHaveBeenCalled();
      expect(spies.debug).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('closes the write stream via closeStreamForTests', () => {
      loggerModule.debugLogger.log('one');
      loggerModule.debugLogger.closeStreamForTests();
      expect(mockWriteStream.end).toHaveBeenCalledTimes(1);
    });

    it('falls back to console when stream creation fails', async () => {
      createWriteStreamMock.mockImplementationOnce(() => {
        throw new Error('failed');
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      loggerModule.debugLogger.log('fallback');

      expect(consoleSpy).toHaveBeenCalledWith('fallback');
      expect(mockWriteStream.write).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });
});
