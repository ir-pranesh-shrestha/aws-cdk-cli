import * as path from 'path';
import * as fs from 'fs-extra';
import { RWLock } from '../../../lib/api/rwlock';
import { contextproviders } from '../../../lib/api/shared-private';
import { Toolkit } from '../../../lib/toolkit/toolkit';
import { ToolkitError } from '../../../lib/toolkit/toolkit-error';
import { appFixture, appFixtureConfig, autoCleanOutDir, builderFixture, builderFunctionFromFixture, cdkOutFixture, TestIoHost } from '../../_helpers';

// these tests often run a bit longer than the default
jest.setTimeout(10_000);

const ioHost = new TestIoHost();
const toolkit = new Toolkit({ ioHost });

beforeEach(() => {
  ioHost.notifySpy.mockClear();
  ioHost.requestSpy.mockClear();
});

describe('fromAssemblyBuilder', () => {
  test('defaults', async () => {
    // WHEN
    const cx = await builderFixture(toolkit, 'two-empty-stacks');
    await using result = await cx.produce();
    const assembly = result.cloudAssembly;

    // THEN
    expect(assembly.stacksRecursively.map(s => s.hierarchicalId)).toEqual(['Stack1', 'Stack2']);
  });

  test('can provide context', async () => {
    // WHEN
    const cx = await builderFixture(toolkit, 'external-context', {
      'externally-provided-bucket-name': 'amzn-s3-demo-bucket',
    });
    await using assembly = await cx.produce();
    const stack = assembly.cloudAssembly.getStackByName('Stack1').template;

    // THEN
    expect(JSON.stringify(stack)).toContain('amzn-s3-demo-bucket');
  });

  test.each(['sync', 'async'] as const)('errors are wrapped as AssemblyError for %s builder', async (sync) => {
    // GIVEN
    const builder = sync === 'sync'
      ? () => {
        throw new Error('a wild error appeared');
      }
      : async () => {
        throw new Error('a wild error appeared');
      };

    const cx = await toolkit.fromAssemblyBuilder(builder);

    // WHEN
    try {
      await cx.produce();
    } catch (err: any) {
      // THEN
      expect(ToolkitError.isAssemblyError(err)).toBe(true);
      expect(err.cause?.message).toContain('a wild error appeared');
    }
  });

  test('disposeOutdir can be used to disappear explicit synth dir', async() => {
    // GIVEN
    await using synthDir = autoCleanOutDir();
    const builder = builderFunctionFromFixture('two-empty-stacks');

    // WHEN
    const cx = await toolkit.fromAssemblyBuilder(builder, {
      outdir: path.join(synthDir.dir, 'relative.dir'),
      disposeOutdir: true,
    });

    const asm = await toolkit.synth(cx);

    expect(await fs.pathExists(asm.cloudAssembly.directory)).toBeTruthy();
    await asm.dispose();

    // THEN
    expect(await fs.pathExists(asm.cloudAssembly.directory)).toBeFalsy();
  });

  test('fromAssemblyBuilder can successfully loop', async () => {
    // GIVEN
    const provideContextValues = jest.spyOn(contextproviders, 'provideContextValues').mockImplementation(async (
      missingValues,
      context,
      _sdk,
      _ioHelper,
    ) => {
      for (const missing of missingValues) {
        context.set(missing.key, 'provided');
      }
    });

    const cx = await appFixture(toolkit, 'uses-context-provider');

    // WHEN
    await using _ = await cx.produce();

    // THEN - no exception

    provideContextValues.mockRestore();
  });

  test('builder directory is locked, and builder failure cleans up the lock', async () => {
    let lock: RWLock;

    // GIVEN
    const cx = await toolkit.fromAssemblyBuilder(async (props) => {
      lock = new RWLock(props.outdir!);
      if (!await (lock as any)._currentWriter()) {
        throw new Error('Expected the directory to be locked during synth');
      }
      throw new Error('a wild error appeared');
    });

    // WHEN
    await expect(cx.produce()).rejects.toThrow();

    // THEN: Don't expect either a read or write lock on the directory afterwards
    expect(await (lock! as any)._currentWriter()).toBeUndefined();
    expect(await (lock! as any)._currentReaders()).toEqual([]);
  });
});

describe('fromCdkApp', () => {
  test('defaults', async () => {
    // WHEN
    const cx = await appFixture(toolkit, 'two-empty-stacks');
    await using assembly = await cx.produce();

    // THEN
    expect(assembly.cloudAssembly.stacksRecursively.map(s => s.hierarchicalId)).toEqual(['Stack1', 'Stack2']);
  });

  test('synth succeeds when working directory is given and outdir is relative', async () => {
    // GIVEN
    await using synthDir = autoCleanOutDir();
    const oldWorking = process.cwd();
    process.chdir(synthDir.dir);
    try {
      // WHEN
      const app = await appFixtureConfig('two-empty-stacks');
      const cx = await toolkit.fromCdkApp(app.app, {
        workingDirectory: app.workingDirectory,
        outdir: 'relative.dir',
        disposeOutdir: true,
      });

      await using assembly = await cx.produce();

      // THEN - synth succeeds
      expect(assembly.cloudAssembly.stacksRecursively.map(s => s.hierarchicalId)).toEqual(['Stack1', 'Stack2']);

      // asm directory is relative to the dir containing the app
      expect(assembly.cloudAssembly.directory.startsWith(app.workingDirectory));
    } finally {
      process.chdir(oldWorking);
    }
  });

  test('disposeOutdir can be used to disappear explicit synth dir', async() => {
    // GIVEN
    await using synthDir = autoCleanOutDir();
    const app = await appFixtureConfig('two-empty-stacks');

    // WHEN
    const cx = await toolkit.fromCdkApp(app.app, {
      workingDirectory: app.workingDirectory,
      outdir: path.join(synthDir.dir, 'relative.dir'),
      disposeOutdir: true,
    });

    const asm = await toolkit.synth(cx);

    expect(await fs.pathExists(asm.cloudAssembly.directory)).toBeTruthy();
    await asm.dispose();

    // THEN
    expect(await fs.pathExists(asm.cloudAssembly.directory)).toBeFalsy();
  });

  test('can provide context', async () => {
    // WHEN
    const cx = await appFixture(toolkit, 'external-context', {
      context: {
        'externally-provided-bucket-name': 'amzn-s3-demo-bucket',
      },
    });
    await using assembly = await cx.produce();
    const stack = assembly.cloudAssembly.getStackByName('Stack1').template;

    // THEN
    expect(JSON.stringify(stack)).toContain('amzn-s3-demo-bucket');
  });

  test('can set environment variables', async () => {
    // WHEN
    const cx = await appFixture(toolkit, 'environment-variable', {
      env: {
        STACK_NAME: 'SomeStackName',
      },
    });
    await using assembly = await cx.produce();
    const stack = assembly.cloudAssembly.getStackByName('SomeStackName').template;

    // THEN
    expect(stack).toBeDefined();
  });

  test('will capture error output', async () => {
    // WHEN
    const cx = await appFixture(toolkit, 'validation-error');
    try {
      await cx.produce();
    } catch {
      // we are just interested in the output for this test
    }

    // THEN
    expect(ioHost.notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      code: 'CDK_ASSEMBLY_E1002',
      message: expect.stringContaining('ValidationError'),
    }));
  });

  test('will capture all output', async () => {
    // WHEN
    const cx = await appFixture(toolkit, 'console-output');
    await using _ = await cx.produce();

    // THEN
    ['one', 'two', 'three', 'four'].forEach((line) => {
      expect(ioHost.notifySpy).toHaveBeenCalledWith(expect.objectContaining({
        level: 'info',
        code: 'CDK_ASSEMBLY_I1001',
        message: `line ${line}`,
      }));
    });
  });

  test('cdk app failure leaves the directory unlocked', async () => {
    using out = autoCleanOutDir();
    const lock = new RWLock(out.dir);

    // GIVEN
    const cx = await toolkit.fromCdkApp('false', { outdir: out.dir });

    // WHEN
    await expect(cx.produce()).rejects.toThrow(/error 1/);

    // THEN: Don't expect either a read or write lock on the directory afterwards
    expect(await (lock! as any)._currentWriter()).toBeUndefined();
    expect(await (lock! as any)._currentReaders()).toEqual([]);
  });
});

describe('fromAssemblyDirectory', () => {
  test('defaults', async () => {
    // WHEN
    const cx = await cdkOutFixture(toolkit, 'two-empty-stacks');
    await using assembly = await cx.produce();

    // THEN
    expect(assembly.cloudAssembly.stacksRecursively.map(s => s.hierarchicalId)).toEqual(['Stack1', 'Stack2']);
  });

  test('validates manifest version', async () => {
    // WHEN
    const cx = await cdkOutFixture(toolkit, 'manifest-from-the-future');

    // THEN
    await expect(() => cx.produce()).rejects.toThrow('This AWS CDK Toolkit is not compatible with the AWS CDK library used by your application');
  });

  test('can disable manifest version validation', async () => {
    // WHEN
    const cx = await cdkOutFixture(toolkit, 'manifest-from-the-future', {
      loadAssemblyOptions: {
        checkVersion: false,
      },
    });
    await using assembly = await cx.produce();

    // THEN
    expect(assembly.cloudAssembly.stacksRecursively.map(s => s.hierarchicalId)).toEqual(['Stack1']);
  });
});
