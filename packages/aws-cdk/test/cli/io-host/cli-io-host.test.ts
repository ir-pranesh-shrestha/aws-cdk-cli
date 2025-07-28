import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { RequireApproval } from '@aws-cdk/cloud-assembly-schema';
import * as chalk from 'chalk';
import * as fs from 'fs-extra';
import { Context } from '../../../lib/api/context';
import type { IoMessage, IoMessageLevel, IoRequest } from '../../../lib/cli/io-host';
import { CliIoHost } from '../../../lib/cli/io-host';

let passThrough: PassThrough;

// Store original process.on
const originalProcessOn = process.on;

// Mock process.on to be a no-op function that returns process for chaining
process.on = jest.fn().mockImplementation(function() {
  return process;
}) as any;

const ioHost = CliIoHost.instance({
  logLevel: 'trace',
});

// Mess with the 'process' global so we can replace its 'process.stdin' member
global.process = { ...process };

describe('CliIoHost', () => {
  let mockStdout: jest.Mock;
  let mockStderr: jest.Mock;
  let defaultMessage: Omit<IoMessage<unknown>, 'data'>;

  beforeEach(() => {
    mockStdout = jest.fn();
    mockStderr = jest.fn();

    // Reset singleton state
    ioHost.isTTY = process.stdout.isTTY ?? false;
    ioHost.isCI = false;
    ioHost.currentAction = 'synth';
    ioHost.requireDeployApproval = RequireApproval.ANYCHANGE;
    (process as any).stdin = passThrough = new PassThrough();

    defaultMessage = {
      time: new Date('2024-01-01T12:00:00'),
      level: 'info',
      action: 'synth',
      code: 'CDK_TOOLKIT_I0001',
      message: 'test message',
    };

    jest.spyOn(process.stdout, 'write').mockImplementation((str: any, encoding?: any, cb?: any) => {
      mockStdout(str.toString());
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (callback) callback();
      return true;
    });

    jest.spyOn(process.stderr, 'write').mockImplementation((str: any, encoding?: any, cb?: any) => {
      mockStderr(str.toString());
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (callback) callback();
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    // Restore original process.on
    process.on = originalProcessOn;
  });

  describe('stream selection', () => {
    test('writes to stderr by default for non-error messages in non-CI mode', async () => {
      ioHost.isTTY = true;
      await ioHost.notify(plainMessage({
        time: new Date(),
        level: 'info',
        action: 'synth',
        code: 'CDK_TOOLKIT_I0001',
        message: 'test message',
      }));

      expect(mockStderr).toHaveBeenCalledWith(chalk.white('test message') + '\n');
      expect(mockStdout).not.toHaveBeenCalled();
    });

    test('writes to stderr for error level with red color', async () => {
      ioHost.isTTY = true;
      await ioHost.notify(plainMessage({
        time: new Date(),
        level: 'error',
        action: 'synth',
        code: 'CDK_TOOLKIT_E0001',
        message: 'error message',
      }));

      expect(mockStderr).toHaveBeenCalledWith(chalk.red('error message') + '\n');
      expect(mockStdout).not.toHaveBeenCalled();
    });

    test('writes to stdout for result level', async () => {
      ioHost.isTTY = true;
      await ioHost.notify(plainMessage({
        time: new Date(),
        level: 'result',
        action: 'synth',
        code: 'CDK_TOOLKIT_I0001',
        message: 'result message',
      }));

      expect(mockStdout).toHaveBeenCalledWith(chalk.white('result message') + '\n');
      expect(mockStderr).not.toHaveBeenCalled();
    });
  });

  describe('notices stream selection', () => {
    const NOTICES_MSG: IoMessage<unknown> = plainMessage({
      time: new Date(),
      level: 'info',
      action: 'doctor',
      code: 'CDK_TOOLKIT_I0100',
      message: 'MESSAGE',
    });

    test('can send notices to stdout', async () => {
      ioHost.noticesDestination = 'stdout';
      await ioHost.notify(NOTICES_MSG);
      // THEN
      expect(mockStdout).toHaveBeenCalledWith(expect.stringContaining('MESSAGE'));
    });

    test('can send notices to stderr', async () => {
      ioHost.noticesDestination = 'stderr';
      await ioHost.notify(NOTICES_MSG);
      // THEN
      expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining('MESSAGE'));
    });

    test('can drop notices', async () => {
      ioHost.noticesDestination = 'drop';
      await ioHost.notify(NOTICES_MSG);
      // THEN
      expect(mockStdout).not.toHaveBeenCalled();
      expect(mockStderr).not.toHaveBeenCalled();
    });
  });

  describe('message formatting', () => {
    beforeEach(() => {
      ioHost.isTTY = true;
    });

    test('formats debug messages with timestamp', async () => {
      await ioHost.notify(plainMessage({
        ...defaultMessage,
        level: 'debug',
      }));

      expect(mockStderr).toHaveBeenCalledWith(`[12:00:00] ${chalk.gray('test message')}\n`);
    });

    test('formats trace messages with timestamp', async () => {
      await ioHost.notify(plainMessage({
        ...defaultMessage,
        level: 'trace',
      }));

      expect(mockStderr).toHaveBeenCalledWith(`[12:00:00] ${chalk.gray('test message')}\n`);
    });

    test('applies no styling when TTY is false', async () => {
      ioHost.isTTY = false;
      await ioHost.notify(plainMessage({
        ...defaultMessage,
      }));

      expect(mockStderr).toHaveBeenCalledWith('test message\n');
    });

    test.each([
      ['error', 'red', false],
      ['warn', 'yellow', false],
      ['info', 'white', false],
      ['debug', 'gray', true],
      ['trace', 'gray', true],
    ] as Array<[IoMessageLevel, typeof chalk.ForegroundColor, boolean]>)('outputs %ss in %s color ', async (level, color, shouldAddTime) => {
      // Given
      const style = chalk[color];
      let expectedOutput = `${style('test message')}\n`;
      if (shouldAddTime) {
        expectedOutput = `[12:00:00] ${expectedOutput}`;
      }

      // When
      await ioHost.notify(plainMessage({
        ...defaultMessage,
        level,
      }));

      // Then
      expect(mockStderr).toHaveBeenCalledWith(expectedOutput);
      mockStdout.mockClear();
    });
  });

  describe('action handling', () => {
    test('sets and gets current action', () => {
      ioHost.currentAction = 'deploy';
      expect(ioHost.currentAction).toBe('deploy');
    });
  });

  describe('CI mode behavior', () => {
    beforeEach(() => {
      ioHost.isTTY = true;
      ioHost.isCI = true;
    });

    test('writes to stdout in CI mode when level is not error', async () => {
      await ioHost.notify(plainMessage({
        time: new Date(),
        level: 'info',
        action: 'synth',
        code: 'CDK_TOOLKIT_W0001',
        message: 'ci message',
      }));

      expect(mockStdout).toHaveBeenCalledWith(chalk.white('ci message') + '\n');
      expect(mockStderr).not.toHaveBeenCalled();
    });

    test('writes to stderr for error level in CI mode', async () => {
      await ioHost.notify(plainMessage({
        time: new Date(),
        level: 'error',
        action: 'synth',
        code: 'CDK_TOOLKIT_E0001',
        message: 'ci error message',
      }));

      expect(mockStderr).toHaveBeenCalledWith(chalk.red('ci error message') + '\n');
      expect(mockStdout).not.toHaveBeenCalled();
    });
  });

  describe('timestamp handling', () => {
    beforeEach(() => {
      ioHost.isTTY = true;
    });

    test('includes timestamp for DEBUG level with gray color', async () => {
      const testDate = new Date('2024-01-01T12:34:56');
      await ioHost.notify(plainMessage({
        time: testDate,
        level: 'debug',
        action: 'synth',
        code: 'CDK_TOOLKIT_I0001',
        message: 'debug message',
      }));

      expect(mockStderr).toHaveBeenCalledWith(`[12:34:56] ${chalk.gray('debug message')}\n`);
    });

    test('excludes timestamp for other levels but includes color', async () => {
      const testDate = new Date('2024-01-01T12:34:56');
      await ioHost.notify(plainMessage({
        time: testDate,
        level: 'info',
        action: 'synth',
        code: 'CDK_TOOLKIT_I0001',
        message: 'info message',
      }));

      expect(mockStderr).toHaveBeenCalledWith(chalk.white('info message') + '\n');
    });
  });

  describe('telemetry', () => {
    let telemetryIoHost: CliIoHost;
    let telemetryEmitSpy: jest.SpyInstance;
    let telemetryDir: string;

    beforeEach(async () => {
      // Create a telemetry file to satisfy requirements; we are not asserting on the file contents
      telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry'));
      const telemetryFilePath = path.join(telemetryDir, 'telemetry-file.json');

      // Create a new instance with telemetry enabled
      telemetryIoHost = CliIoHost.instance({
        logLevel: 'trace',
      }, true);
      await telemetryIoHost.startTelemetry({ '_': 'init', 'telemetry-file': telemetryFilePath }, new Context());

      expect(telemetryIoHost.telemetry).toBeDefined();

      telemetryEmitSpy = jest.spyOn(telemetryIoHost.telemetry!, 'emit')
        .mockImplementation(async () => Promise.resolve());
    });

    afterEach(() => {
      fs.rmdirSync(telemetryDir, { recursive: true });
      jest.restoreAllMocks();
    });

    test('emit telemetry on SYNTH event', async () => {
      // Create a message that should trigger telemetry using the actual message code
      const message: IoMessage<unknown> = {
        time: new Date(),
        level: 'trace',
        action: 'synth',
        code: 'CDK_CLI_I1001',
        message: 'telemetry message',
        data: {
          duration: 123,
        },
      };

      // Send the notification
      await telemetryIoHost.notify(message);

      // Verify that the emit method was called with the correct parameters
      expect(telemetryEmitSpy).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'SYNTH',
        duration: 123,
      }));
    });

    test('emit telemetry on INVOKE event', async () => {
      // Create a message that should trigger telemetry using the actual message code
      const message: IoMessage<unknown> = {
        time: new Date(),
        level: 'trace',
        action: 'synth',
        code: 'CDK_CLI_I2001',
        message: 'telemetry message',
        data: {
          duration: 123,
        },
      };

      // Send the notification
      await telemetryIoHost.notify(message);

      // Verify that the emit method was called with the correct parameters
      expect(telemetryEmitSpy).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'INVOKE',
        duration: 123,
      }));
    });

    test('do not emit telemetry on non telemetry codes', async () => {
      // Create a message that should trigger telemetry using the actual message code
      const message: IoMessage<unknown> = {
        time: new Date(),
        level: 'trace',
        action: 'synth',
        code: 'CDK_CLI_I2000', // only I2001, I1001 are valid
        message: 'telemetry message',
        data: {
          duration: 123,
        },
      };

      // Send the notification
      await telemetryIoHost.notify(message);

      // Verify that the emit method was not called
      expect(telemetryEmitSpy).not.toHaveBeenCalled();
    });

    test('emit telemetry with error name', async () => {
      // Create a message that should trigger telemetry using the actual message code
      const message: IoMessage<unknown> = {
        time: new Date(),
        level: 'trace',
        action: 'synth',
        code: 'CDK_CLI_I2001',
        message: 'telemetry message',
        data: {
          duration: 123,
          error: {
            name: 'MyError',
            message: 'Some message',
          },
        },
      };

      // Send the notification
      await telemetryIoHost.notify(message);

      // Verify that the emit method was called with the correct parameters
      expect(telemetryEmitSpy).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'INVOKE',
        duration: 123,
        error: {
          name: 'MyError',
          message: 'Some message',
        },
      }));
    });
  });

  describe('requestResponse', () => {
    beforeEach(() => {
      ioHost.isTTY = true;
      ioHost.isCI = false;
    });

    test('fail if concurrency is > 1', async () => {
      await expect(() => ioHost.requestResponse({
        time: new Date(),
        level: 'info',
        action: 'synth',
        code: 'CDK_TOOLKIT_I0001',
        message: 'Continue?',
        defaultResponse: true,
        data: {
          concurrency: 3,
        },
      })).rejects.toThrow('but concurrency is greater than 1');
    });

    describe('boolean', () => {
      test('respond "yes" to a confirmation prompt', async () => {
        const response = await requestResponse('y', plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'Continue?',
          defaultResponse: true,
        }));

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('Continue?') + ' (y/n) ');
        expect(response).toBe(true);
      });

      test('respond "no" to a confirmation prompt', async () => {
        await expect(() => requestResponse('n', plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'Continue?',
          defaultResponse: true,
        }))).rejects.toThrow('Aborted by user');

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('Continue?') + ' (y/n) ');
      });
    });

    describe('string', () => {
      test.each([
        ['bear', 'bear'],
        ['giraffe', 'giraffe'],
        // simulate the enter key
        ['\x0A', 'cat'],
      ])('receives %p and returns %p', async (input, expectedResponse) => {
        const response = await requestResponse(input, plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'Favorite animal',
          defaultResponse: 'cat',
        }));

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('Favorite animal') + ' (cat) ');
        expect(response).toBe(expectedResponse);
      });
    });

    describe('number', () => {
      test.each([
        ['3', 3],
        // simulate the enter key
        ['\x0A', 1],
      ])('receives %p and return %p', async (input, expectedResponse) => {
        const response = await requestResponse(input, plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'How many would you like?',
          defaultResponse: 1,
        }));

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('How many would you like?') + ' (1) ');
        expect(response).toBe(expectedResponse);
      });
    });

    describe('non-promptable data', () => {
      test('logs messages and returns default unchanged', async () => {
        const response = await ioHost.requestResponse(plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'test message',
          defaultResponse: [1, 2, 3],
        }));

        expect(mockStderr).toHaveBeenCalledWith(chalk.white('test message') + '\n');
        expect(response).toEqual([1, 2, 3]);
      });
    });

    describe('non TTY environment', () => {
      beforeEach(() => {
        ioHost.isTTY = false;
        ioHost.isCI = false;
      });

      test('fail for all prompts', async () => {
        await expect(() => ioHost.requestResponse(plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'Continue?',
          defaultResponse: true,
        }))).rejects.toThrow('User input is needed');
      });

      test('fail with specific motivation', async () => {
        await expect(() => ioHost.requestResponse({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'Continue?',
          defaultResponse: true,
          data: {
            motivation: 'Bananas are yellow',
          },
        })).rejects.toThrow('Bananas are yellow');
      });

      test('returns the default for non-promptable requests', async () => {
        const response = await ioHost.requestResponse(plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I0001',
          message: 'test message',
          defaultResponse: [1, 2, 3],
        }));

        expect(mockStderr).toHaveBeenCalledWith('test message\n');
        expect(response).toEqual([1, 2, 3]);
      });
    });

    describe('requireApproval', () => {
      test('require approval by default - respond yes', async () => {
        const response = await requestResponse('y', plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I5060',
          message: 'test message',
          defaultResponse: true,
        }));

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('test message') + ' (y/n) ');
        expect(response).toEqual(true);
      });

      test('require approval by default - respond no', async () => {
        await expect(() => requestResponse('n', plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I5060',
          message: 'test message',
          defaultResponse: true,
        }))).rejects.toThrow('Aborted by user');
      });

      test('never require approval', async () => {
        ioHost.requireDeployApproval = RequireApproval.NEVER;
        const response = await ioHost.requestResponse(plainMessage({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I5060',
          message: 'test message',
          defaultResponse: true,
        }));

        expect(mockStdout).not.toHaveBeenCalledWith(chalk.cyan('test message') + ' (y/n) ');
        expect(response).toEqual(true);
      });

      test('broadening - require approval on broadening changes', async () => {
        ioHost.requireDeployApproval = RequireApproval.BROADENING;
        const response = await requestResponse('y', {
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I5060',
          message: 'test message',
          data: {
            permissionChangeType: 'broadening',
          },
          defaultResponse: true,
        });

        expect(mockStdout).toHaveBeenCalledWith(chalk.cyan('test message') + ' (y/n) ');
        expect(response).toEqual(true);
      });

      test('broadening - do not require approval on non-broadening changes', async () => {
        ioHost.requireDeployApproval = RequireApproval.BROADENING;
        const response = await ioHost.requestResponse({
          time: new Date(),
          level: 'info',
          action: 'synth',
          code: 'CDK_TOOLKIT_I5060',
          message: 'test message',
          data: {
            permissionChangeType: 'non-broadening',
          },
          defaultResponse: true,
        });

        expect(mockStdout).not.toHaveBeenCalledWith(chalk.cyan('test message') + ' (y/n) ');
        expect(response).toEqual(true);
      });
    });
  });
});

/**
 * Do a requestResponse cycle with the global ioHost, while sending input on the global fake input stream
 */
async function requestResponse<DataType, ResponseType>(input: string, msg: IoRequest<DataType, ResponseType>): Promise<ResponseType> {
  const promise = ioHost.requestResponse(msg);
  passThrough.write(input + '\n');
  return promise;
}

function plainMessage<A extends Omit<IoMessage<unknown> | IoRequest<unknown, unknown>, 'data'>>(m: A): A & { data: void } {
  return {
    ...m,
    data: undefined,
  };
}
