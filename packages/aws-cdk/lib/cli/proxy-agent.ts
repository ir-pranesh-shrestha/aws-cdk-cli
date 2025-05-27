import * as fs from 'fs-extra';
import { ProxyAgent } from 'proxy-agent';
import type { IoHelper } from '../api-private';

/**
 * Options for proxy-agent SDKs
 */
interface ProxyAgentOptions {
  /**
   * Proxy address to use
   *
   * @default No proxy
   */
  readonly proxyAddress?: string;

  /**
   * A path to a certificate bundle that contains a cert to be trusted.
   *
   * @default No certificate bundle
   */
  readonly caBundlePath?: string;
}

export class ProxyAgentProvider {
  private readonly ioHelper: IoHelper;

  public constructor(ioHelper: IoHelper) {
    this.ioHelper = ioHelper;
  }

  public async create(options: ProxyAgentOptions) {
    // Force it to use the proxy provided through the command line.
    // Otherwise, let the ProxyAgent auto-detect the proxy using environment variables.
    const getProxyForUrl = options.proxyAddress != null
      ? () => Promise.resolve(options.proxyAddress!)
      : undefined;

    return new ProxyAgent({
      ca: await this.tryGetCACert(options.caBundlePath),
      getProxyForUrl,
    });
  }

  private async tryGetCACert(bundlePath?: string) {
    const path = bundlePath || this.caBundlePathFromEnvironment();
    if (path) {
      await this.ioHelper.defaults.debug(`Using CA bundle path: ${path}`);
      try {
        if (!fs.pathExistsSync(path)) {
          return undefined;
        }
        return fs.readFileSync(path, { encoding: 'utf-8' });
      } catch (e: any) {
        await this.ioHelper.defaults.debug(String(e));
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Find and return a CA certificate bundle path to be passed into the SDK.
   */
  private caBundlePathFromEnvironment(): string | undefined {
    if (process.env.aws_ca_bundle) {
      return process.env.aws_ca_bundle;
    }
    if (process.env.AWS_CA_BUNDLE) {
      return process.env.AWS_CA_BUNDLE;
    }
    return undefined;
  }
}
