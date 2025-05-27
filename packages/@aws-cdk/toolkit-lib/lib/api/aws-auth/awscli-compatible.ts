import type { Agent } from 'node:https';
import { format } from 'node:util';
import type { SDKv3CompatibleCredentialProvider } from '@aws-cdk/cli-plugin-contract';
import { createCredentialChain, fromEnv, fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { MetadataService } from '@aws-sdk/ec2-metadata-service';
import type { NodeHttpHandlerOptions } from '@smithy/node-http-handler';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { makeCachingProvider } from './provider-caching';
import { ProxyAgentProvider } from './proxy-agent';
import type { ISdkLogger } from './sdk-logger';
import type { SdkHttpOptions } from './types';
import { AuthenticationError } from '../../toolkit/toolkit-error';
import { IO, type IoHelper } from '../io/private';

const DEFAULT_CONNECTION_TIMEOUT = 10000;
const DEFAULT_TIMEOUT = 300000;

/**
 * Behaviors to match AWS CLI
 *
 * See these links:
 *
 * https://docs.aws.amazon.com/cli/latest/topic/config-vars.html
 * https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html
 */
export class AwsCliCompatible {
  private readonly ioHelper: IoHelper;
  private readonly requestHandler: NodeHttpHandlerOptions;
  private readonly logger?: ISdkLogger;

  public constructor(ioHelper: IoHelper, requestHandler: NodeHttpHandlerOptions, logger?: ISdkLogger) {
    this.ioHelper = ioHelper;
    this.requestHandler = requestHandler;
    this.logger = logger;
  }

  public async baseConfig(profile?: string): Promise<{ credentialProvider: SDKv3CompatibleCredentialProvider; defaultRegion: string }> {
    const credentialProvider = await this.credentialChainBuilder({
      profile,
      logger: this.logger,
    });
    const defaultRegion = await this.region(profile);
    return { credentialProvider, defaultRegion };
  }

  /**
   * Build an AWS CLI-compatible credential chain provider
   *
   * The credential chain returned by this function is always caching.
   */
  public async credentialChainBuilder(
    options: CredentialChainOptions = {},
  ): Promise<SDKv3CompatibleCredentialProvider> {
    const clientConfig = {
      requestHandler: this.requestHandler,
      customUserAgent: 'aws-cdk',
      logger: options.logger,
    };

    // Super hacky solution to https://github.com/aws/aws-cdk/issues/32510, proposed by the SDK team.
    //
    // Summary of the problem: we were reading the region from the config file and passing it to
    // the credential providers. However, in the case of SSO, this makes the credential provider
    // use that region to do the SSO flow, which is incorrect. The region that should be used for
    // that is the one set in the sso_session section of the config file.
    //
    // The idea here: the "clientConfig" is for configuring the inner auth client directly,
    // and has the highest priority, whereas "parentClientConfig" is the upper data client
    // and has lower priority than the sso_region but still higher priority than STS global region.
    const parentClientConfig = {
      region: await this.region(options.profile),
    };
    /**
     * The previous implementation matched AWS CLI behavior:
     *
     * If a profile is explicitly set using `--profile`,
     * we use that to the exclusion of everything else.
     *
     * Note: this does not apply to AWS_PROFILE,
     * environment credentials still take precedence over AWS_PROFILE
     */
    if (options.profile) {
      return makeCachingProvider(fromIni({
        profile: options.profile,
        ignoreCache: true,
        mfaCodeProvider: this.tokenCodeFn.bind(this),
        clientConfig,
        parentClientConfig,
        logger: options.logger,
      }));
    }

    const envProfile = process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE;

    /**
     * Env AWS - EnvironmentCredentials with string AWS
     * Env Amazon - EnvironmentCredentials with string AMAZON
     * Profile Credentials - PatchedSharedIniFileCredentials with implicit profile, credentials file, http options, and token fn
     *    SSO with implicit profile only
     *    SharedIniFileCredentials with implicit profile and preferStaticCredentials true (profile with source_profile)
     *    Shared Credential file that points to Environment Credentials with AWS prefix
     *    Shared Credential file that points to EC2 Metadata
     *    Shared Credential file that points to ECS Credentials
     * SSO Credentials - SsoCredentials with implicit profile and http options
     * ProcessCredentials with implicit profile
     * ECS Credentials - ECSCredentials with no input OR Web Identity - TokenFileWebIdentityCredentials with no input OR EC2 Metadata - EC2MetadataCredentials with no input
     *
     * These translate to:
     * fromEnv()
     * fromSSO()/fromIni()
     * fromProcess()
     * fromContainerMetadata()
     * fromTokenFile()
     * fromInstanceMetadata()
     *
     * The NodeProviderChain is already cached.
     */
    const nodeProviderChain = fromNodeProviderChain({
      profile: envProfile,
      clientConfig,
      parentClientConfig,
      logger: options.logger,
      mfaCodeProvider: this.tokenCodeFn.bind(this),
      ignoreCache: true,
    });

    return shouldPrioritizeEnv()
      ? createCredentialChain(fromEnv(), nodeProviderChain).expireAfter(60 * 60_000)
      : nodeProviderChain;
  }

  /**
   * Attempts to get the region from a number of sources and falls back to us-east-1 if no region can be found,
   * as is done in the AWS CLI.
   *
   * The order of priority is the following:
   *
   * 1. Environment variables specifying region, with both an AWS prefix and AMAZON prefix
   *    to maintain backwards compatibility, and without `DEFAULT` in the name because
   *    Lambda and CodeBuild set the $AWS_REGION variable.
   * 2. Regions listed in the Shared Ini Files - First checking for the profile provided
   *    and then checking for the default profile.
   * 3. IMDS instance identity region from the Metadata Service.
   * 4. us-east-1
   */
  public async region(maybeProfile?: string): Promise<string> {
    const defaultRegion = 'us-east-1';
    const profile = maybeProfile || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || 'default';

    const region =
      process.env.AWS_REGION ||
      process.env.AMAZON_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      process.env.AMAZON_DEFAULT_REGION ||
      (await this.getRegionFromIni(profile)) ||
      (await this.regionFromMetadataService());

    if (!region) {
      const usedProfile = !profile ? '' : ` (profile: "${profile}")`;
      await this.ioHelper.defaults.debug(
        `Unable to determine AWS region from environment or AWS configuration${usedProfile}, defaulting to '${defaultRegion}'`,
      );
      return defaultRegion;
    }

    return region;
  }

  /**
   * The MetadataService class will attempt to fetch the instance identity document from
   * IMDSv2 first, and then will attempt v1 as a fallback.
   *
   * If this fails, we will use us-east-1 as the region so no error should be thrown.
   * @returns The region for the instance identity
   */
  private async regionFromMetadataService() {
    await this.ioHelper.defaults.debug('Looking up AWS region in the EC2 Instance Metadata Service (IMDS).');
    try {
      const metadataService = new MetadataService({
        httpOptions: {
          timeout: 1000,
        },
      });

      await metadataService.fetchMetadataToken();
      const document = await metadataService.request('/latest/dynamic/instance-identity/document', {});
      return JSON.parse(document).region;
    } catch (e) {
      await this.ioHelper.defaults.debug(`Unable to retrieve AWS region from IMDS: ${e}`);
    }
  }

  /**
   * Looks up the region of the provided profile. If no region is present,
   * it will attempt to lookup the default region.
   * @param profile The profile to use to lookup the region
   * @returns The region for the profile or default profile, if present. Otherwise returns undefined.
   */
  private async getRegionFromIni(profile: string): Promise<string | undefined> {
    const sharedFiles = await loadSharedConfigFiles({ ignoreCache: true });

    // Priority:
    //
    // credentials come before config because aws-cli v1 behaves like that.
    //
    // 1. profile-region-in-credentials
    // 2. profile-region-in-config
    // 3. default-region-in-credentials
    // 4. default-region-in-config

    return this.getRegionFromIniFile(profile, sharedFiles.credentialsFile)
    ?? this.getRegionFromIniFile(profile, sharedFiles.configFile)
    ?? this.getRegionFromIniFile('default', sharedFiles.credentialsFile)
    ?? this.getRegionFromIniFile('default', sharedFiles.configFile);
  }

  private getRegionFromIniFile(profile: string, data?: any) {
    return data?.[profile]?.region;
  }

  /**
   * Ask user for MFA token for given MFA device
   *
   * Result is send to callback function for SDK to authorize the request
   */
  private async tokenCodeFn(deviceArn: string): Promise<string> {
    const debugFn = (msg: string, ...args: any[]) => this.ioHelper.defaults.debug(format(msg, ...args));
    await debugFn('Require MFA token from MFA device with ARN', deviceArn);
    try {
      const token: string = await this.ioHelper.requestResponse(IO.CDK_SDK_I1100.req(`MFA token for ${deviceArn}`, {
        deviceArn,
      }, ''));

      await debugFn('Successfully got MFA token from user');
      return token;
    } catch (err: any) {
      await debugFn('Failed to get MFA token', err);
      const e = new AuthenticationError(`Error fetching MFA token: ${err.message ?? err}`);
      e.name = 'SharedIniFileCredentialsProviderFailure';
      throw e;
    }
  }
}

/**
 * We used to support both AWS and AMAZON prefixes for these environment variables.
 *
 * Adding this for backward compatibility.
 */
function shouldPrioritizeEnv() {
  const id = process.env.AWS_ACCESS_KEY_ID || process.env.AMAZON_ACCESS_KEY_ID;
  const key = process.env.AWS_SECRET_ACCESS_KEY || process.env.AMAZON_SECRET_ACCESS_KEY;

  if (!!id && !!key) {
    process.env.AWS_ACCESS_KEY_ID = id;
    process.env.AWS_SECRET_ACCESS_KEY = key;

    const sessionToken = process.env.AWS_SESSION_TOKEN ?? process.env.AMAZON_SESSION_TOKEN;
    if (sessionToken) {
      process.env.AWS_SESSION_TOKEN = sessionToken;
    }

    return true;
  }

  return false;
}

export interface CredentialChainOptions {
  readonly profile?: string;
  readonly logger?: ISdkLogger;
}

export function sdkRequestHandler(agent?: Agent): NodeHttpHandlerOptions {
  return {
    connectionTimeout: DEFAULT_CONNECTION_TIMEOUT,
    requestTimeout: DEFAULT_TIMEOUT,
    httpsAgent: agent,
    httpAgent: agent,
  };
}

export async function makeRequestHandler(ioHelper: IoHelper, options: SdkHttpOptions = {}): Promise<NodeHttpHandlerOptions> {
  const agent = await new ProxyAgentProvider(ioHelper).create(options);
  return sdkRequestHandler(agent);
}
