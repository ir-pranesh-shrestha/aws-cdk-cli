import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cxschema from '@aws-cdk/cloud-assembly-schema';
import type { CloudFormationStackArtifact } from '@aws-cdk/cx-api';
import type { DescribeChangeSetCommandOutput } from '@aws-sdk/client-cloudformation';
import type { NestedStackTemplates } from '../../lib/api';
import { Deployments } from '../../lib/api';
import type { IoHelper } from '../../lib/api-private';
import { cfnApi } from '../../lib/api-private';
import { CdkToolkit } from '../../lib/cli/cdk-toolkit';
import { CliIoHost } from '../../lib/cli/io-host';
import { instanceMockFrom, MockCloudExecutable } from '../_helpers';

let cloudExecutable: MockCloudExecutable;
let cloudFormation: jest.Mocked<Deployments>;
let toolkit: CdkToolkit;
let oldDir: string;
let tmpDir: string;
let ioHost = CliIoHost.instance();
let notifySpy: jest.SpyInstance<Promise<void>>;

beforeAll(() => {
  // The toolkit writes and checks for temporary files in the current directory,
  // so run these tests in a tempdir so they don't interfere with each other
  // and other tests.
  oldDir = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cdk-test'));
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(oldDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  notifySpy = jest.spyOn(ioHost, 'notify');
  notifySpy.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fixed template', () => {
  const templatePath = 'oldTemplate.json';
  beforeEach(() => {
    const oldTemplate = {
      Resources: {
        SomeResource: {
          Type: 'AWS::SomeService::SomeResource',
          Properties: {
            Something: 'old-value',
          },
        },
      },
    };

    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: {
            Resources: {
              SomeResource: {
                Type: 'AWS::SomeService::SomeResource',
                Properties: {
                  Something: 'new-value',
                },
              },
            },
          },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    fs.writeFileSync(templatePath, JSON.stringify(oldTemplate));
  });

  afterEach(() => fs.rmSync(templatePath));

  test('fixed template with valid templates', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: undefined,
      templatePath,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls.map(x => x[0].message).join('\n').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput).toContain(`Resources
[~] AWS::SomeService::SomeResource SomeResource
 └─ [~] Something
     ├─ [-] old-value
     └─ [+] new-value
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });
});

describe('import existing resources', () => {
  let createDiffChangeSet: jest.SpyInstance<
    Promise<DescribeChangeSetCommandOutput | undefined>,
    [ioHelper: IoHelper, options: cfnApi.PrepareChangeSetOptions],
    any
  >;

  beforeEach(() => {
    // Default implementations
    cloudFormation = instanceMockFrom(Deployments);
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation(
      (_stackArtifact: CloudFormationStackArtifact) => {
        return Promise.resolve({
          deployedRootTemplate: {
            Resources: {
              MyTable: {
                Type: 'AWS::DynamoDB::Table',
                Properties: {
                  TableName: 'MyTableName-12345ABC',
                },
                DeletionPolicy: 'Retain',
              },
            },
          },
          nestedStacks: {},
        });
      },
    );
    cloudFormation.stackExists = jest.fn().mockReturnValue(Promise.resolve(true));
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: {
            Resources: {
              MyGlobalTable: {
                Type: 'AWS::DynamoDB::GlobalTable',
                Properties: {
                  TableName: 'MyTableName-12345ABC',
                },
              },
            },
          },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });
  });

  test('import action in change set output', async () => {
    createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet').mockImplementationOnce(async () => {
      return {
        $metadata: {},
        Changes: [
          {
            ResourceChange: {
              Action: 'Import',
              LogicalResourceId: 'MyGlobalTable',
            },
          },
        ],
      };
    });

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: true,
      importExistingResources: true,
    });

    expect(createDiffChangeSet).toHaveBeenCalled();

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')).toContain(`
Resources
[-] AWS::DynamoDB::Table MyTable orphan
[←] AWS::DynamoDB::GlobalTable MyGlobalTable import
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });

  test('import action in change set output when not using --import-exsting-resources', async () => {
    createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet').mockImplementationOnce(async () => {
      return {
        $metadata: {},
        Changes: [
          {
            ResourceChange: {
              Action: 'Add',
              LogicalResourceId: 'MyGlobalTable',
            },
          },
        ],
      };
    });

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: true,
      importExistingResources: false,
    });

    expect(createDiffChangeSet).toHaveBeenCalled();

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')).toContain(`
Resources
[-] AWS::DynamoDB::Table MyTable orphan
[+] AWS::DynamoDB::GlobalTable MyGlobalTable
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });

  test('when invoked with no changeSet flag', async () => {
    // WHEN
    createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet').mockImplementationOnce(async () => {
      return {
        $metadata: {},
        Changes: [
          {
            ResourceChange: {
              Action: 'Add',
              LogicalResourceId: 'MyGlobalTable',
            },
          },
        ],
      };
    });

    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: undefined,
      importExistingResources: true,
    });

    expect(createDiffChangeSet).not.toHaveBeenCalled();

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')).toContain(`
Resources
[-] AWS::DynamoDB::Table MyTable orphan
[+] AWS::DynamoDB::GlobalTable MyGlobalTable
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });

  test('when invoked with local template path', async () => {
    const templatePath = 'oldTemplate.json';
    const oldTemplate = {
      Resources: {
        SomeResource: {
          Type: 'AWS::SomeService::SomeResource',
          Properties: {
            Something: 'old-value',
          },
        },
      },
    };
    fs.writeFileSync(templatePath, JSON.stringify(oldTemplate));
    // WHEN
    await expect(async () => {
      await toolkit.diff({
        stackNames: ['A'],
        changeSet: undefined,
        templatePath: templatePath,
        importExistingResources: true,
      });
    }).rejects.toThrow(/Can only use --import-existing-resources flag when comparing against deployed stacks/);
  });
});

describe('imports', () => {
  let createDiffChangeSet: jest.SpyInstance<
    Promise<DescribeChangeSetCommandOutput | undefined>,
    [ioHelper: IoHelper, options: cfnApi.PrepareChangeSetOptions],
    any
  >;

  beforeEach(() => {
    const outputToJson = {
      '//': 'This file is generated by cdk migrate. It will be automatically deleted after the first successful deployment of this app to the environment of the original resources.',
      'Source': 'localfile',
      'Resources': [],
    };
    fs.writeFileSync('migrate.json', JSON.stringify(outputToJson, null, 2));
    createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet').mockImplementationOnce(async () => {
      return {
        $metadata: {},
        Changes: [
          {
            ResourceChange: {
              Action: 'Import',
              LogicalResourceId: 'Queue',
            },
          },
          {
            ResourceChange: {
              Action: 'Import',
              LogicalResourceId: 'Bucket',
            },
          },
          {
            ResourceChange: {
              Action: 'Import',
              LogicalResourceId: 'Queue2',
            },
          },
        ],
      };
    });
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: {
            Resources: {
              Queue: {
                Type: 'AWS::SQS::Queue',
              },
              Queue2: {
                Type: 'AWS::SQS::Queue',
              },
              Bucket: {
                Type: 'AWS::S3::Bucket',
              },
            },
          },
        },
      ],
    }, undefined, ioHost);

    cloudFormation = instanceMockFrom(Deployments);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    // Default implementations
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation(
      (_stackArtifact: CloudFormationStackArtifact) => {
        return Promise.resolve({
          deployedRootTemplate: {},
          nestedStacks: {},
        });
      },
    );
    cloudFormation.deployStack.mockImplementation((options) =>
      Promise.resolve({
        type: 'did-deploy-stack',
        noOp: true,
        outputs: {},
        stackArn: '',
        stackArtifact: options.stack,
      }),
    );
  });

  afterEach(() => {
    fs.rmSync('migrate.json');
  });

  test('imports render correctly for a nonexistant stack without creating a changeset', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[1][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(createDiffChangeSet).not.toHaveBeenCalled();
    expect(plainTextOutput).toContain(`Stack A
Parameters and rules created during migration do not affect resource configuration.
Resources
[←] AWS::SQS::Queue Queue import
[←] AWS::SQS::Queue Queue2 import
[←] AWS::S3::Bucket Bucket import
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });

  test('imports render correctly for an existing stack and diff creates a changeset', async () => {
    // GIVEN
    cloudFormation.stackExists = jest.fn().mockReturnValue(Promise.resolve(true));

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      changeSet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(createDiffChangeSet).toHaveBeenCalled();
    expect(plainTextOutput).toContain(`Stack A
Parameters and rules created during migration do not affect resource configuration.
Resources
[←] AWS::SQS::Queue Queue import
[←] AWS::SQS::Queue Queue2 import
[←] AWS::S3::Bucket Bucket import
`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });
});

describe('non-nested stacks', () => {
  beforeEach(() => {
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: { resource: 'A' },
        },
        {
          stackName: 'B',
          depends: ['A'],
          template: { resource: 'B' },
        },
        {
          stackName: 'C',
          depends: ['A'],
          template: { resource: 'C' },
          metadata: {
            '/resource': [
              {
                type: cxschema.ArtifactMetadataEntryType.ERROR,
                data: 'this is an error',
              },
            ],
          },
        },
        {
          stackName: 'D',
          template: { resource: 'D' },
        },
      ],
    }, undefined, ioHost);

    cloudFormation = instanceMockFrom(Deployments);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    // Default implementations
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation(
      (stackArtifact: CloudFormationStackArtifact) => {
        if (stackArtifact.stackName === 'D') {
          return Promise.resolve({
            deployedRootTemplate: { resource: 'D' },
            nestedStacks: {},
          });
        }
        return Promise.resolve({
          deployedRootTemplate: {},
          nestedStacks: {},
        });
      },
    );
    cloudFormation.deployStack.mockImplementation((options) =>
      Promise.resolve({
        type: 'did-deploy-stack',
        noOp: true,
        outputs: {},
        stackArn: '',
        stackArtifact: options.stack,
      }),
    );
  });

  test('diff can diff multiple stacks', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['B'],
    });

    // THEN
    const plainTextOutputA = notifySpy.mock.calls[1][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutputA).toContain('Stack A');
    const plainTextOutputB = notifySpy.mock.calls[2][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutputB).toContain('Stack B');

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 2'),
    }));
    expect(exitCode).toBe(0);
  });

  test('diff number of stack diffs, not resource diffs', async () => {
    // GIVEN
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: { resourceA: 'A', resourceB: 'B' },
        },
        {
          stackName: 'B',
          template: { resourceC: 'C' },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A', 'B'],
    });

    // THEN
    const plainTextOutputA = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutputA).toContain('Stack A');
    const plainTextOutputB = notifySpy.mock.calls[1][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutputB).toContain('Stack B');

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 2'),
    }));
    expect(exitCode).toBe(0);
  });

  test('exits with 1 with diffs and fail set to true', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      fail: true,
    });

    // THEN
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(1);
  });

  test('throws an error if no valid stack names given', async () => {
    // WHEN
    await expect(() =>
      toolkit.diff({
        stackNames: ['X', 'Y', 'Z'],
      }),
    ).rejects.toThrow('No stacks match the name(s) X,Y,Z');
  });

  test('exits with 1 with diff in first stack, but not in second stack and fail set to true', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A', 'D'],
      fail: true,
    });

    // THEN
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(1);
  });

  test('throws an error during diffs on stack with error metadata', async () => {
    // WHEN
    await expect(() =>
      toolkit.diff({
        stackNames: ['C'],
      }),
    ).rejects.toThrow(/Found errors/);
  });

  test('when quiet mode is enabled, stacks with no diffs should not print stack name & no differences to stdout', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['D'],
      fail: false,
      quiet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput).not.toContain('Stack D');
    expect(plainTextOutput).not.toContain('There were no differences');
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 0'),
    }));
    expect(exitCode).toBe(0);
  });

  test('when quiet mode is enabled, stacks with diffs should print stack name to stdout', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      fail: false,
      quiet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput).toContain('Stack A');
    expect(plainTextOutput).not.toContain('There were no differences');
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });
});

describe('stack exists checks', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: { resource: 'A' },
        },
        {
          stackName: 'B',
          depends: ['A'],
          template: { resource: 'B' },
        },
        {
          stackName: 'C',
          depends: ['A'],
          template: { resource: 'C' },
          metadata: {
            '/resource': [
              {
                type: cxschema.ArtifactMetadataEntryType.ERROR,
                data: 'this is an error',
              },
            ],
          },
        },
        {
          stackName: 'D',
          template: { resource: 'D' },
        },
      ],
    }, undefined, ioHost);

    cloudFormation = instanceMockFrom(Deployments);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    // Default implementations
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation(
      (stackArtifact: CloudFormationStackArtifact) => {
        if (stackArtifact.stackName === 'D') {
          return Promise.resolve({
            deployedRootTemplate: { resource: 'D' },
            nestedStacks: {},
          });
        }
        return Promise.resolve({
          deployedRootTemplate: {},
          nestedStacks: {},
        });
      },
    );
    cloudFormation.deployStack.mockImplementation((options) =>
      Promise.resolve({
        type: 'did-deploy-stack',
        noOp: true,
        outputs: {},
        stackArn: '',
        stackArtifact: options.stack,
      }),
    );
  });

  test('diff does not check for stack existence when --no-change-set is passed', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A', 'A'],
      fail: false,
      quiet: true,
      changeSet: false,
    });

    // THEN
    expect(exitCode).toBe(0);
    expect(cloudFormation.stackExists).not.toHaveBeenCalled();
  });

  test('diff falls back to classic diff when stack does not exist', async () => {
    // GIVEN
    const stackExists = jest.spyOn(cloudFormation, 'stackExists').mockReturnValue(Promise.resolve(false));
    const createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet');

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A', 'A'],
      fail: false,
      quiet: true,
      changeSet: true,
    });

    // THEN
    expect(exitCode).toBe(0);
    expect(stackExists).toHaveBeenCalled();
    expect(createDiffChangeSet).not.toHaveBeenCalled();
  });

  test('diff falls back to classic diff when stackExists call fails', async () => {
    // GIVEN
    const stackExists = jest.spyOn(cloudFormation, 'stackExists');
    const createDiffChangeSet = jest.spyOn(cfnApi, 'createDiffChangeSet');

    stackExists.mockImplementation(() => {
      throw new Error('Fail fail fail');
    });

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A', 'A'],
      fail: false,
      quiet: true,
      changeSet: true,
    });

    // THEN
    expect(exitCode).toBe(0);
    expect(stackExists).toHaveBeenCalled();
    expect(createDiffChangeSet).not.toHaveBeenCalled();
  });
});

describe('nested stacks', () => {
  beforeEach(() => {
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'Parent',
          template: {},
        },
        {
          stackName: 'UnchangedParent',
          template: {},
        },
      ],
    }, undefined, ioHost);

    cloudFormation = instanceMockFrom(Deployments);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation(
      (stackArtifact: CloudFormationStackArtifact) => {
        if (stackArtifact.stackName === 'Parent') {
          stackArtifact.template.Resources = {
            AdditionChild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {
                TemplateURL: 'addition-child-url-old',
              },
            },
            DeletionChild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {
                TemplateURL: 'deletion-child-url-old',
              },
            },
            ChangedChild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {
                TemplateURL: 'changed-child-url-old',
              },
            },
            UnchangedChild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {
                TemplateURL: 'changed-child-url-constant',
              },
            },
          };
          return Promise.resolve({
            deployedRootTemplate: {
              Resources: {
                AdditionChild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: {
                    TemplateURL: 'addition-child-url-new',
                  },
                },
                DeletionChild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: {
                    TemplateURL: 'deletion-child-url-new',
                  },
                },
                ChangedChild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: {
                    TemplateURL: 'changed-child-url-new',
                  },
                },
                UnchangedChild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: {
                    TemplateURL: 'changed-child-url-constant',
                  },
                },
              },
            },
            nestedStacks: {
              AdditionChild: {
                deployedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                    },
                  },
                },
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'added-value',
                      },
                    },
                  },
                },
                nestedStackTemplates: {},
                physicalName: 'AdditionChild',
              },
              DeletionChild: {
                deployedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'value-to-be-removed',
                      },
                    },
                  },
                },
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                    },
                  },
                },
                nestedStackTemplates: {},
                physicalName: 'DeletionChild',
              },
              ChangedChild: {
                deployedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'old-value',
                      },
                    },
                  },
                },
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'new-value',
                      },
                    },
                  },
                },
                nestedStackTemplates: {},
                physicalName: 'ChangedChild',
              },
              newChild: {
                deployedTemplate: {},
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'new-value',
                      },
                    },
                  },
                },
                nestedStackTemplates: {
                  newGrandChild: {
                    deployedTemplate: {},
                    generatedTemplate: {
                      Resources: {
                        SomeResource: {
                          Type: 'AWS::Something',
                          Properties: {
                            Prop: 'new-value',
                          },
                        },
                      },
                    },
                    physicalName: undefined,
                    nestedStackTemplates: {},
                  } as NestedStackTemplates,
                },
                physicalName: undefined,
              },
              UnChangedChild: {
                deployedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'unchanged',
                      },
                    },
                  },
                },
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'unchanged',
                      },
                    },
                  },
                },
                nestedStackTemplates: {},
                physicalName: 'UnChangedChild',
              },
            },
          });
        }
        if (stackArtifact.stackName === 'UnchangedParent') {
          stackArtifact.template.Resources = {
            UnchangedChild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {
                TemplateURL: 'child-url',
              },
            },
          };
          return Promise.resolve({
            deployedRootTemplate: {
              Resources: {
                UnchangedChild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: {
                    TemplateURL: 'child-url',
                  },
                },
              },
            },
            nestedStacks: {
              UnchangedChild: {
                deployedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'unchanged',
                      },
                    },
                  },
                },
                generatedTemplate: {
                  Resources: {
                    SomeResource: {
                      Type: 'AWS::Something',
                      Properties: {
                        Prop: 'unchanged',
                      },
                    },
                  },
                },
                nestedStackTemplates: {},
                physicalName: 'UnchangedChild',
              },
            },
          });
        }
        return Promise.resolve({
          deployedRootTemplate: {},
          nestedStacks: {},
        });
      },
    );
  });

  test('diff can diff nested stacks and display the nested stack logical ID if has not been deployed or otherwise has no physical name', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['Parent'],
      changeSet: false,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[ \t]+$/gm, '');
    expect(plainTextOutput.trim()).toEqual(`Stack Parent
Resources
[~] AWS::CloudFormation::Stack AdditionChild
 └─ [~] TemplateURL
     ├─ [-] addition-child-url-new
     └─ [+] addition-child-url-old
[~] AWS::CloudFormation::Stack DeletionChild
 └─ [~] TemplateURL
     ├─ [-] deletion-child-url-new
     └─ [+] deletion-child-url-old
[~] AWS::CloudFormation::Stack ChangedChild
 └─ [~] TemplateURL
     ├─ [-] changed-child-url-new
     └─ [+] changed-child-url-old

Stack AdditionChild
Resources
[~] AWS::Something SomeResource
 └─ [+] Prop
     └─ added-value

Stack DeletionChild
Resources
[~] AWS::Something SomeResource
 └─ [-] Prop
     └─ value-to-be-removed

Stack ChangedChild
Resources
[~] AWS::Something SomeResource
 └─ [~] Prop
     ├─ [-] old-value
     └─ [+] new-value

Stack newChild
Resources
[+] AWS::Something SomeResource

Stack newGrandChild
Resources
[+] AWS::Something SomeResource

Stack UnChangedChild
There were no differences`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 6'),
    }));

    expect(exitCode).toBe(0);
  });

  test('diff falls back to non-changeset diff for nested stacks', async () => {
    // GIVEN
    const changeSetSpy = jest.spyOn(cfnApi, 'waitForChangeSet');

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['Parent'],
      changeSet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[1][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[ \t]+$/gm, '');
    expect(plainTextOutput.trim()).toEqual(`Stack Parent
Resources
[~] AWS::CloudFormation::Stack AdditionChild
 └─ [~] TemplateURL
     ├─ [-] addition-child-url-new
     └─ [+] addition-child-url-old
[~] AWS::CloudFormation::Stack DeletionChild
 └─ [~] TemplateURL
     ├─ [-] deletion-child-url-new
     └─ [+] deletion-child-url-old
[~] AWS::CloudFormation::Stack ChangedChild
 └─ [~] TemplateURL
     ├─ [-] changed-child-url-new
     └─ [+] changed-child-url-old

Stack AdditionChild
Resources
[~] AWS::Something SomeResource
 └─ [+] Prop
     └─ added-value

Stack DeletionChild
Resources
[~] AWS::Something SomeResource
 └─ [-] Prop
     └─ value-to-be-removed

Stack ChangedChild
Resources
[~] AWS::Something SomeResource
 └─ [~] Prop
     ├─ [-] old-value
     └─ [+] new-value

Stack newChild
Resources
[+] AWS::Something SomeResource

Stack newGrandChild
Resources
[+] AWS::Something SomeResource

Stack UnChangedChild
There were no differences`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 6'),
    }));

    expect(exitCode).toBe(0);
    expect(changeSetSpy).not.toHaveBeenCalled();
  });

  test('when quiet mode is enabled, nested stacks with no diffs should not print stack name & no differences to stdout', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['UnchangedParent'],
      fail: false,
      quiet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[ \t]+$/gm, '');
    expect(plainTextOutput).not.toContain('Stack UnchangedParent');
    expect(plainTextOutput).not.toContain('There were no differences');
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 0'),
    }));
    expect(exitCode).toBe(0);
  });

  test('when quiet mode is enabled, nested stacks with diffs should print stack name to stdout', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['Parent'],
      fail: false,
      quiet: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[ \t]+$/gm, '');
    expect(plainTextOutput).toContain(`Stack Parent
Resources
[~] AWS::CloudFormation::Stack AdditionChild
 └─ [~] TemplateURL
     ├─ [-] addition-child-url-new
     └─ [+] addition-child-url-old
[~] AWS::CloudFormation::Stack DeletionChild
 └─ [~] TemplateURL
     ├─ [-] deletion-child-url-new
     └─ [+] deletion-child-url-old
[~] AWS::CloudFormation::Stack ChangedChild
 └─ [~] TemplateURL
     ├─ [-] changed-child-url-new
     └─ [+] changed-child-url-old

Stack AdditionChild
Resources
[~] AWS::Something SomeResource
 └─ [+] Prop
     └─ added-value

Stack DeletionChild
Resources
[~] AWS::Something SomeResource
 └─ [-] Prop
     └─ value-to-be-removed

Stack ChangedChild
Resources
[~] AWS::Something SomeResource
 └─ [~] Prop
     ├─ [-] old-value
     └─ [+] new-value

Stack newChild
Resources
[+] AWS::Something SomeResource

Stack newGrandChild
Resources
[+] AWS::Something SomeResource`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 6'),
    }));
    expect(plainTextOutput).not.toContain('Stack UnChangedChild');
    expect(exitCode).toBe(0);
  });
});

describe('--strict', () => {
  const templatePath = 'oldTemplate.json';
  beforeEach(() => {
    const oldTemplate = {};

    cloudFormation = instanceMockFrom(Deployments);
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation((_stackArtifact: CloudFormationStackArtifact) => {
      return Promise.resolve({
        deployedRootTemplate: {},
        nestedStacks: {},
      });
    });

    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'A',
          template: {
            Resources: {
              MetadataResource: {
                Type: 'AWS::CDK::Metadata',
                Properties: {
                  newMeta: 'newData',
                },
              },
              SomeOtherResource: {
                Type: 'AWS::Something::Amazing',
              },
            },
            Rules: {
              CheckBootstrapVersion: {
                newCheck: 'newBootstrapVersion',
              },
            },
          },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    fs.writeFileSync(templatePath, JSON.stringify(oldTemplate));
  });

  afterEach(() => fs.rmSync(templatePath));

  test('--strict does not obscure CDK::Metadata or CheckBootstrapVersion', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
      strict: true,
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput.trim()).toEqual(`Stack A
Resources
[+] AWS::CDK::Metadata MetadataResource
[+] AWS::Something::Amazing SomeOtherResource

Other Changes
[+] Unknown Rules: {\"CheckBootstrapVersion\":{\"newCheck\":\"newBootstrapVersion\"}}`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });

  test('--no-strict obscures CDK::Metadata and CheckBootstrapVersion', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['A'],
    });

    // THEN
    const plainTextOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(plainTextOutput.trim()).toEqual(`Stack A
Resources
[+] AWS::Something::Amazing SomeOtherResource`);

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 1'),
    }));
    expect(exitCode).toBe(0);
  });
});

describe('stack display names', () => {
  beforeEach(() => {
    cloudFormation = instanceMockFrom(Deployments);
    cloudFormation.readCurrentTemplateWithNestedStacks.mockImplementation((_stackArtifact: CloudFormationStackArtifact) => {
      return Promise.resolve({
        deployedRootTemplate: {},
        nestedStacks: {},
      });
    });
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'MyParent',
          displayName: 'Parent/NestedStack',
          template: { resource: 'ParentStack' },
        },
        {
          stackName: 'MyChild',
          displayName: 'Parent/NestedStack/MyChild',
          template: { resource: 'ChildStack' },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });
  });

  test('diff should display stack paths instead of logical IDs', async () => {
    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['Parent/NestedStack', 'Parent/NestedStack/MyChild'],
    });

    // THEN
    const parentOutput = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const childOutput = notifySpy.mock.calls[1][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

    // Verify that the display name (path) is shown instead of the logical ID
    expect(parentOutput).toContain('Stack Parent/NestedStack/MyChild');
    expect(parentOutput).not.toContain('Stack MyChild');

    expect(childOutput).toContain('Stack Parent/NestedStack');
    expect(childOutput).not.toContain('Stack MyParent');

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('✨  Number of stacks with differences: 2'),
    }));
    expect(exitCode).toBe(0);
  });

  test('diff should fall back to logical ID if display name is not available', async () => {
    // Create a new cloud executable with stacks that don't have display names
    cloudExecutable = new MockCloudExecutable({
      stacks: [
        {
          stackName: 'NoDisplayNameStack',
          // No displayName provided
          template: { resource: 'ParentStack' },
        },
      ],
    }, undefined, ioHost);

    toolkit = new CdkToolkit({
      cloudExecutable,
      deployments: cloudFormation,
      configuration: cloudExecutable.configuration,
      sdkProvider: cloudExecutable.sdkProvider,
    });

    // WHEN
    const exitCode = await toolkit.diff({
      stackNames: ['NoDisplayNameStack'],
    });

    // THEN
    const output = notifySpy.mock.calls[0][0].message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

    // Verify that the logical ID is shown when display name is not available
    expect(output).toContain('Stack NoDisplayNameStack');

    expect(exitCode).toBe(0);
  });
});
