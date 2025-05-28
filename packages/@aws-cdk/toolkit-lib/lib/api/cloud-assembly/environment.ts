import * as path from 'path';
import * as cxapi from '@aws-cdk/cx-api';
import * as fs from 'fs-extra';
import type { SdkProvider } from '../aws-auth/private';
import type { Settings } from '../settings';

export type Env = { [key: string]: string | undefined };
export type Context = { [key: string]: unknown };

/**
 * If we don't have region/account defined in context, we fall back to the default SDK behavior
 * where region is retrieved from ~/.aws/config and account is based on default credentials provider
 * chain and then STS is queried.
 *
 * This is done opportunistically: for example, if we can't access STS for some reason or the region
 * is not configured, the context value will be 'null' and there could failures down the line. In
 * some cases, synthesis does not require region/account information at all, so that might be perfectly
 * fine in certain scenarios.
 *
 * @param context The context key/value bash.
 */
export async function prepareDefaultEnvironment(
  aws: SdkProvider,
  debugFn: (msg: string) => Promise<void>,
): Promise<Env> {
  const env: Env = {};

  env[cxapi.DEFAULT_REGION_ENV] = aws.defaultRegion;
  await debugFn(`Setting "${cxapi.DEFAULT_REGION_ENV}" environment variable to ${env[cxapi.DEFAULT_REGION_ENV]}`);

  const accountId = (await aws.defaultAccount())?.accountId;
  if (accountId) {
    env[cxapi.DEFAULT_ACCOUNT_ENV] = accountId;
    await debugFn(`Setting "${cxapi.DEFAULT_ACCOUNT_ENV}" environment variable to ${env[cxapi.DEFAULT_ACCOUNT_ENV]}`);
  }

  return env;
}

/**
 * Create context from settings.
 *
 * Mutates the `context` object and returns it.
 */
export function contextFromSettings(
  settings: Settings,
) {
  const context: Record<string, unknown> = {};

  const pathMetadata: boolean = settings.get(['pathMetadata']) ?? true;
  if (pathMetadata) {
    context[cxapi.PATH_METADATA_ENABLE_CONTEXT] = true;
  }

  const assetMetadata: boolean = settings.get(['assetMetadata']) ?? true;
  if (assetMetadata) {
    context[cxapi.ASSET_RESOURCE_METADATA_ENABLED_CONTEXT] = true;
  }

  const versionReporting: boolean = settings.get(['versionReporting']) ?? true;
  if (versionReporting) {
    context[cxapi.ANALYTICS_REPORTING_ENABLED_CONTEXT] = true;
  }
  // We need to keep on doing this for framework version from before this flag was deprecated.
  if (!versionReporting) {
    context['aws:cdk:disable-version-reporting'] = true;
  }

  const stagingEnabled = settings.get(['staging']) ?? true;
  if (!stagingEnabled) {
    context[cxapi.DISABLE_ASSET_STAGING_CONTEXT] = true;
  }

  const bundlingStacks = settings.get(['bundlingStacks']) ?? ['**'];
  context[cxapi.BUNDLING_STACKS] = bundlingStacks;

  return context;
}

/**
 * Convert settings to context/environment variables
 */
export function synthParametersFromSettings(settings: Settings): {
  context: Context;
  env: Env;
} {
  return {
    context: contextFromSettings(settings),
    env: {
      // An environment variable instead of a context variable, so it can also
      // be accessed in framework code where we don't have access to a construct tree.
      ...settings.get(['debug']) ? { CDK_DEBUG: 'true' } : {},
    },
  };
}

export function spaceAvailableForContext(env: Env, limit: number) {
  const size = (value?: string) => value != null ? Buffer.byteLength(value) : 0;

  const usedSpace = Object.entries(env)
    .map(([k, v]) => k === cxapi.CONTEXT_ENV ? size(k) : size(k) + size(v))
    .reduce((a, b) => a + b, 0);

  return Math.max(0, limit - usedSpace);
}

/**
 * Guess the executable from the command-line argument
 *
 * Only do this if the file is NOT marked as executable. If it is,
 * we'll defer to the shebang inside the file itself.
 *
 * If we're on Windows, we ALWAYS take the handler, since it's hard to
 * verify if registry associations have or have not been set up for this
 * file type, so we'll assume the worst and take control.
 */
export async function guessExecutable(app: string, debugFn: (msg: string) => Promise<void>) {
  const commandLine = appToArray(app);
  if (commandLine.length === 1) {
    let fstat;

    try {
      fstat = await fs.stat(commandLine[0]);
    } catch {
      await debugFn(`Not a file: '${commandLine[0]}'. Using '${commandLine}' as command-line`);
      return commandLine;
    }

    // eslint-disable-next-line no-bitwise
    const isExecutable = (fstat.mode & fs.constants.X_OK) !== 0;
    const isWindows = process.platform === 'win32';

    const handler = EXTENSION_MAP.get(path.extname(commandLine[0]));
    if (handler && (!isExecutable || isWindows)) {
      return handler(commandLine[0]);
    }
  }
  return commandLine;
}

/**
 * Mapping of extensions to command-line generators
 */
const EXTENSION_MAP = new Map<string, CommandGenerator>([
  ['.js', executeNode],
]);

type CommandGenerator = (file: string) => string[];

/**
 * Execute the given file with the same 'node' process as is running the current process
 */
function executeNode(scriptFile: string): string[] {
  return [process.execPath, scriptFile];
}

/**
 * Make sure the 'app' is an array
 *
 * If it's a string, split on spaces as a trivial way of tokenizing the command line.
 */
function appToArray(app: any) {
  return typeof app === 'string' ? app.split(' ') : app;
}
