import { join } from 'path';
import * as core from 'aws-cdk-lib/core';
import { AwsCdkCli } from '../lib';
import * as cli from '../lib/aws-cdk';

// These tests synthesize an actual CDK app and take a bit longer
jest.setTimeout(60_000);

jest.mock('../lib/aws-cdk', () => {
  const original = jest.requireActual('../lib/aws-cdk');
  return {
    ...original,
    exec: jest.fn(original.exec),
  };
});
const stdoutMock = jest.spyOn(process.stdout, 'write').mockImplementation(() => {
  return true;
});

beforeEach(() => {
  stdoutMock.mockClear();
  jest.mocked(cli.exec).mockClear();
});

afterAll(() => jest.clearAllMocks());

describe('fromCloudAssemblyDirectoryProducer', () => {
  const testEnv = jest.fn();
  const cdk = AwsCdkCli.fromCloudAssemblyDirectoryProducer({
    produce: async () => {
      const app = new core.App();
      new core.Stack(app, 'Stack1');
      new core.Stack(app, 'Stack2');

      testEnv(process.env);

      return app.synth().directory;
    },
  });

  beforeEach(() => {
    testEnv.mockClear();
  });

  test('can list all stacks in app', async () => {
    // WHEN
    await cdk.list();

    // THEN
    expect(jest.mocked(cli.exec)).toHaveBeenCalledWith(
      ['ls', '--all'],
      expect.anything(),
    );
    expect(stdoutMock.mock.calls[0][0]).toContain('Stack1');
    expect(stdoutMock.mock.calls[1][0]).toContain('Stack2');
  });

  test('does set CDK_DEBUG', async () => {
    // WHEN
    await cdk.list({ debug: true });

    // THEN
    expect(testEnv.mock.calls[0][0]).toHaveProperty('CDK_DEBUG', 'true');
  });

  test('does not set CDK_DEBUG when ', async () => {
    // WHEN
    await cdk.list({ debug: false });

    // THEN
    expect(testEnv.mock.calls[0][0]).not.toHaveProperty('CDK_DEBUG');
  });
});

describe('fromDirectory', () => {
  const cdk = AwsCdkCli.fromCdkAppDirectory(join(__dirname, 'test-app'));

  test('can list all stacks in cdk app', async () => {
    // WHEN
    await cdk.list();

    // THEN
    expect(jest.mocked(cli.exec)).toHaveBeenCalledWith(
      ['ls', '--all'],
    );
    expect(stdoutMock.mock.calls[0][0]).toContain('AppStack1');
    expect(stdoutMock.mock.calls[1][0]).toContain('AppStack2');
  });
});

describe('fromDirectory with config', () => {
  const cdk = AwsCdkCli.fromCdkAppDirectory(join(__dirname, 'test-app'), {
    app: 'node -r ts-node/register app.ts',
    output: 'cdk.out',
  });

  test('can list all stacks in cdk app', async () => {
    // WHEN
    await cdk.list();

    // THEN
    expect(jest.mocked(cli.exec)).toHaveBeenCalledWith(
      [
        'ls', '--all',
        '--app', 'node -r ts-node/register app.ts',
        '--output', 'cdk.out',
      ],
    );
    expect(stdoutMock.mock.calls[0][0]).toContain('AppStack1');
    expect(stdoutMock.mock.calls[1][0]).toContain('AppStack2');
  });
});
