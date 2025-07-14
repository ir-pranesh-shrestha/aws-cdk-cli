import * as fs from 'fs';
import * as path from 'path';
import { ArtifactMetadataEntryType, ArtifactType, type AssetManifest, type AssetMetadataEntry, type AwsCloudFormationStackProperties, type MetadataEntry, type MissingContext } from '@aws-cdk/cloud-assembly-schema';
import { type CloudAssembly, CloudAssemblyBuilder, type CloudFormationStackArtifact, type StackMetadata } from '@aws-cdk/cx-api';
import { cxapiAssemblyWithForcedVersion } from './assembly-versions';
import { TestIoHost } from './io-host';
import { asIoHelper } from '../../lib/api-private';
import type { IIoHost } from '../../lib/cli/io-host';
import { Configuration } from '../../lib/cli/user-configuration';
import { CloudExecutable } from '../../lib/cxapp/cloud-executable';
import { MockSdkProvider } from '../_helpers/mock-sdk';

export const DEFAULT_FAKE_TEMPLATE = { No: 'Resources' };

const SOME_RECENT_SCHEMA_VERSION = '30.0.0';

export interface TestStackArtifact {
  stackName: string;
  template?: any;
  env?: string;
  depends?: string[];
  metadata?: StackMetadata;
  notificationArns?: string[];

  /** Old-style assets */
  assets?: AssetMetadataEntry[];
  properties?: Partial<AwsCloudFormationStackProperties>;
  terminationProtection?: boolean;
  displayName?: string;

  /** New-style assets */
  assetManifest?: AssetManifest;
}

export interface TestAssembly {
  stacks: TestStackArtifact[];
  missing?: MissingContext[];
  nestedAssemblies?: TestAssembly[];
  schemaVersion?: string;
}

export class MockCloudExecutable extends CloudExecutable {
  public static async create(assembly: TestAssembly, sdkProviderArg?: MockSdkProvider, ioHost?: IIoHost) {
    const mockIoHost = ioHost ?? new TestIoHost();
    const configuration = await Configuration.fromArgs(asIoHelper(mockIoHost, 'deploy'));
    const sdkProvider = sdkProviderArg ?? new MockSdkProvider();

    return new MockCloudExecutable(assembly, configuration, sdkProvider, mockIoHost);
  }

  public readonly configuration: Configuration;
  public readonly sdkProvider: MockSdkProvider;

  private constructor(assembly: TestAssembly, configuration: Configuration, sdkProvider: MockSdkProvider, ioHost: IIoHost) {
    super({
      configuration,
      sdkProvider,
      synthesizer: () => Promise.resolve(testAssembly(assembly)),
      ioHelper: asIoHelper(ioHost, 'deploy'),
    });

    this.configuration = configuration;
    this.sdkProvider = sdkProvider;
  }
}

function clone(obj: any) {
  return JSON.parse(JSON.stringify(obj));
}

function addAttributes(assembly: TestAssembly, builder: CloudAssemblyBuilder) {
  for (const stack of assembly.stacks) {
    const templateFile = `${stack.stackName}.template.json`;
    const template = stack.template ?? DEFAULT_FAKE_TEMPLATE;
    fs.writeFileSync(path.join(builder.outdir, templateFile), JSON.stringify(template, undefined, 2));
    addNestedStacks(templateFile, builder.outdir, template);

    // we call patchStackTags here to simulate the tags formatter
    // that is used when building real manifest files.
    const metadata: { [path: string]: MetadataEntry[] } = patchStackTags({ ...stack.metadata });
    for (const asset of stack.assets || []) {
      metadata[asset.id] = [{ type: ArtifactMetadataEntryType.ASSET, data: asset }];
    }

    for (const missing of assembly.missing || []) {
      builder.addMissing(missing);
    }

    const dependencies = [...(stack.depends ?? [])];

    if (stack.assetManifest) {
      const manifestFile = `${stack.stackName}.assets.json`;
      fs.writeFileSync(path.join(builder.outdir, manifestFile), JSON.stringify(stack.assetManifest, undefined, 2));
      dependencies.push(`${stack.stackName}.assets`);
      builder.addArtifact(`${stack.stackName}.assets`, {
        type: ArtifactType.ASSET_MANIFEST,
        environment: stack.env || 'aws://123456789012/here',
        properties: {
          file: manifestFile,
        },
      });
    }

    builder.addArtifact(stack.stackName, {
      type: ArtifactType.AWS_CLOUDFORMATION_STACK,
      environment: stack.env || 'aws://123456789012/here',

      dependencies,
      metadata,
      properties: {
        ...stack.properties,
        templateFile,
        terminationProtection: stack.terminationProtection,
        notificationArns: stack.notificationArns,
      },
      displayName: stack.displayName,
    });
  }
}

function addNestedStacks(templatePath: string, outdir: string, rootStackTemplate?: any) {
  let template = rootStackTemplate;

  if (!template) {
    const templatePathWithDir = path.join('nested-stack-templates', templatePath);
    template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_fixtures', templatePathWithDir)).toString());
    fs.writeFileSync(path.join(outdir, templatePath), JSON.stringify(template, undefined, 2));
  }

  for (const logicalId in template.Resources) {
    if (template.Resources[logicalId].Type === 'AWS::CloudFormation::Stack') {
      if (template.Resources[logicalId].Metadata && template.Resources[logicalId].Metadata['aws:asset:path']) {
        const nestedTemplatePath = template.Resources[logicalId].Metadata['aws:asset:path'];
        addNestedStacks(nestedTemplatePath, outdir);
      }
    }
  }
}

export function testAssembly(assembly: TestAssembly): CloudAssembly {
  const builder = new CloudAssemblyBuilder();
  addAttributes(assembly, builder);

  if (assembly.nestedAssemblies != null && assembly.nestedAssemblies.length > 0) {
    assembly.nestedAssemblies?.forEach((nestedAssembly: TestAssembly, i: number) => {
      const nestedAssemblyBuilder = builder.createNestedAssembly(`nested${i}`, `nested${i}`);
      addAttributes(nestedAssembly, nestedAssemblyBuilder);
      nestedAssemblyBuilder.buildAssembly();
    });
  }

  const asm = builder.buildAssembly();
  return cxapiAssemblyWithForcedVersion(asm, assembly.schemaVersion ?? SOME_RECENT_SCHEMA_VERSION);
}

/**
 * Transform stack tags from how they are decalred in source code (lower cased)
 * to how they are stored on disk (upper cased). In real synthesis this is done
 * by a special tags formatter.
 *
 * @see aws-cdk-lib/lib/stack.ts
 */
function patchStackTags(metadata: { [path: string]: MetadataEntry[] }): {
  [path: string]: MetadataEntry[];
} {
  const cloned = clone(metadata) as { [path: string]: MetadataEntry[] };

  for (const metadataEntries of Object.values(cloned)) {
    for (const metadataEntry of metadataEntries) {
      if (metadataEntry.type === ArtifactMetadataEntryType.STACK_TAGS && metadataEntry.data) {
        const metadataAny = metadataEntry as any;

        metadataAny.data = metadataAny.data.map((t: any) => {
          return { Key: t.key, Value: t.value };
        });
      }
    }
  }
  return cloned;
}

export function testStack(stack: TestStackArtifact): CloudFormationStackArtifact {
  const assembly = testAssembly({ stacks: [stack] });
  return assembly.getStackByName(stack.stackName);
}
