import * as child_process from 'child_process';
import { RequireApproval } from '@aws-cdk/cloud-assembly-schema/lib/integ-tests';
import { CdkCliWrapper } from '../lib/cdk-wrapper';
import { StackActivityProgress } from '../lib/commands';
let spawnSyncMock: jest.SpyInstance;
let spawnMock: jest.SpyInstance;

// Necessary to make the spyOn below work
jest.mock('child_process', () => ({ __esModule: true, ...jest.requireActual('child_process') }));

beforeEach(() => {
  spawnSyncMock = jest.spyOn(child_process, 'spawnSync').mockReturnValue({
    status: 0,
    stderr: Buffer.from('stderr'),
    stdout: Buffer.from('stdout'),
    pid: 123,
    output: ['stdout', 'stderr'],
    signal: null,
  });
  spawnMock = jest.spyOn(child_process, 'spawn').mockImplementation(jest.fn(() => {
    return {
      on: jest.fn(() => {
      }),
    } as unknown as child_process.ChildProcess;
  }));
});

afterEach(() => {
  jest.resetAllMocks();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('default deploy', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['deploy', '--progress', 'events', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.anything(),
      cwd: '/project',
    }),
  );
});

test('deploy with all arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    ci: false,
    json: true,
    color: false,
    debug: false,
    force: true,
    proxy: 'https://proxy',
    trace: false,
    output: 'cdk.out',
    strict: false,
    execute: true,
    lookups: false,
    notices: true,
    profile: 'my-profile',
    roleArn: 'arn:aws:iam::1111111111:role/my-role',
    staging: false,
    verbose: true,
    ec2Creds: true,
    rollback: false,
    exclusively: true,
    outputsFile: 'outputs.json',
    reuseAssets: [
      'asset1234',
      'asset5678',
    ],
    caBundlePath: '/some/path',
    ignoreErrors: false,
    pathMetadata: false,
    assetMetadata: true,
    changeSetName: 'my-change-set',
    requireApproval: RequireApproval.NEVER,
    toolkitStackName: 'Toolkit',
    versionReporting: true,
    usePreviousParameters: true,
    progress: StackActivityProgress.BAR,
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    expect.arrayContaining([
      'deploy',
      '--no-strict',
      '--no-trace',
      '--no-lookups',
      '--no-ignore-errors',
      '--json',
      '--verbose',
      '--no-debug',
      '--ec2creds',
      '--version-reporting',
      '--no-path-metadata',
      '--asset-metadata',
      '--notices',
      '--no-color',
      '--profile', 'my-profile',
      '--proxy', 'https://proxy',
      '--ca-bundle-path', '/some/path',
      '--role-arn', 'arn:aws:iam::1111111111:role/my-role',
      '--output', 'cdk.out',
      '--no-ci',
      '--execute',
      '--exclusively',
      '--force',
      '--no-rollback',
      '--no-staging',
      '--reuse-assets', 'asset1234',
      '--reuse-assets', 'asset5678',
      '--outputs-file', 'outputs.json',
      '--require-approval', 'never',
      '--change-set-name', 'my-change-set',
      '--toolkit-stack-name', 'Toolkit',
      '--previous-parameters',
      '--progress', 'bar',
      '--app',
      'node bin/my-app.js',
      'test-stack1',
    ]),
    expect.objectContaining({
      env: expect.anything(),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/project',
    }),
  );
});

test('can parse boolean arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    json: true,
    color: false,
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    [
      'deploy',
      '--progress', 'events',
      '--app',
      'node bin/my-app.js',
      '--json',
      '--no-color',
      'test-stack1',
    ],
    expect.objectContaining({
      env: expect.anything(),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/project',
    }),
  );
});

test('can parse parameters', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    parameters: {
      'myparam': 'test',
      'test-stack1:myotherparam': 'test',
    },
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    [
      'deploy',
      '--parameters', 'myparam=test',
      '--parameters', 'test-stack1:myotherparam=test',
      '--progress', 'events',
      '--app',
      'node bin/my-app.js',
      'test-stack1',
    ],
    expect.objectContaining({
      env: expect.anything(),
      cwd: '/project',
    }),
  );
});

test('can parse context', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    context: {
      'myContext': 'value',
      'test-stack1:OtherContext': 'otherValue',
    },
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    [
      'deploy',
      '--progress', 'events',
      '--app',
      'node bin/my-app.js',
      '--context', 'myContext=value',
      '--context', 'test-stack1:OtherContext=otherValue',
      'test-stack1',
    ],
    expect.objectContaining({
      env: expect.anything(),
      cwd: '/project',
    }),
  );
});

test('can parse array arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    notificationArns: [
      'arn:aws:us-east-1:1111111111:some:resource',
      'arn:aws:us-east-1:1111111111:some:other-resource',
    ],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    [
      'deploy',
      '--notification-arns', 'arn:aws:us-east-1:1111111111:some:resource',
      '--notification-arns', 'arn:aws:us-east-1:1111111111:some:other-resource',
      '--progress', 'events',
      '--app',
      'node bin/my-app.js',
      'test-stack1',
    ],
    expect.objectContaining({
      env: expect.anything(),
      cwd: '/project',
    }),
  );
});

test('can provide additional environment', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.deploy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['deploy', '--progress', 'events', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('default synth', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.synth({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['synth', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('watch arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.watch({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
  });

  // THEN
  expect(spawnMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['deploy', '--watch', '--hotswap-fallback', '--progress', 'events', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('destroy arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.destroy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['destroy', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('destroy arguments', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.destroy({
    app: 'node bin/my-app.js',
    stacks: ['test-stack1'],
    force: true,
    exclusively: false,
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['destroy', '--force', '--no-exclusively', '--app', 'node bin/my-app.js', 'test-stack1'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('default ls', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.list({
    app: 'node bin/my-app.js',
    stacks: ['*'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['ls', '--app', 'node bin/my-app.js', '*'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );
});

test('ls arguments', async () => {
  // WHEN
  spawnSyncMock = jest.spyOn(child_process, 'spawnSync').mockReturnValue({
    status: 0,
    stderr: Buffer.from('stderr'),
    stdout: Buffer.from('test-stack1\ntest-stack2'),
    pid: 123,
    output: ['stdout', 'stderr'],
    signal: null,
  });
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  const list = await cdk.list({
    app: 'node bin/my-app.js',
    stacks: ['*'],
    long: true,
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    expect.stringMatching(/cdk/),
    ['ls', '--long', '--app', 'node bin/my-app.js', '*'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
      }),
      cwd: '/project',
    }),
  );

  expect(list).toEqual(['test-stack1', 'test-stack2']);
});

test('can synth fast', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    env: {
      KEY: 'value',
    },
  });
  await cdk.synthFast({
    execCmd: ['node', 'bin/my-app.js'],
    output: 'cdk.output',
    env: {
      OTHERKEY: 'othervalue',
    },
    context: {
      CONTEXT: 'value',
    },
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    'node',
    ['bin/my-app.js'],
    expect.objectContaining({
      env: expect.objectContaining({
        KEY: 'value',
        OTHERKEY: 'othervalue',
        CDK_OUTDIR: 'cdk.output',
        CDK_CONTEXT_JSON: '{\"CONTEXT\":\"value\"}',
      }),
      cwd: '/project',
    }),
  );
});

test('can show output', async () => {
  // WHEN
  const cdk = new CdkCliWrapper({
    directory: '/project',
    showOutput: true,
  });
  await cdk.synthFast({
    execCmd: ['node', 'bin/my-app.js'],
  });

  // THEN
  expect(spawnSyncMock).toHaveBeenCalledWith(
    'node',
    ['bin/my-app.js'],
    expect.objectContaining({
      env: expect.anything(),
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: '/project',
    }),
  );
});
