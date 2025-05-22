/* eslint-disable import/order */
import * as path from 'path';
import type { ConstructTreeNode } from '../../lib/api/tree';
import { loadTreeFromDir, some } from '../../lib/api/tree';

describe('some', () => {
  const tree: ConstructTreeNode = {
    id: 'App',
    path: '',
    children: {
      Tree: {
        id: 'Tree',
        path: 'Tree',
        constructInfo: {
          fqn: 'aws-cdk-lib.Construct',
          version: '1.162.0',
        },
      },
      stack: {
        id: 'stack',
        path: 'stack',
        children: {
          bucket: {
            id: 'bucket',
            path: 'stack/bucket',
            children: {
              Resource: {
                id: 'Resource',
                path: 'stack/bucket/Resource',
                attributes: {
                  'aws:cdk:cloudformation:type': 'AWS::S3::Bucket',
                  'aws:cdk:cloudformation:props': {},
                },
                constructInfo: {
                  fqn: '@aws-cdk/aws-s3.CfnBucket',
                  version: '1.162.0',
                },
              },
            },
            constructInfo: {
              fqn: '@aws-cdk/aws-s3.Bucket',
              version: '1.162.0',
            },
          },
          CDKMetadata: {
            id: 'CDKMetadata',
            path: 'stack/CDKMetadata',
            children: {
              Default: {
                id: 'Default',
                path: 'stack/CDKMetadata/Default',
                constructInfo: {
                  fqn: 'aws-cdk-lib.CfnResource',
                  version: '1.162.0',
                },
              },
              Condition: {
                id: 'Condition',
                path: 'stack/CDKMetadata/Condition',
                constructInfo: {
                  fqn: 'aws-cdk-lib.CfnCondition',
                  version: '1.162.0',
                },
              },
            },
            constructInfo: {
              fqn: 'aws-cdk-lib.Construct',
              version: '1.162.0',
            },
          },
        },
        constructInfo: {
          fqn: 'aws-cdk-lib.Stack',
          version: '1.162.0',
        },
      },
    },
    constructInfo: {
      fqn: 'aws-cdk-lib.App',
      version: '1.162.0',
    },
  };

  test('tree matches predicate', () => {
    expect(some(tree, node => node.constructInfo?.fqn === '@aws-cdk/aws-s3.Bucket')).toBe(true);
  });

  test('tree does not match predicate', () => {
    expect(some(tree, node => node.constructInfo?.fqn === '@aws-cdk/aws-lambda.Function')).toBe(false);
  });

  test('childless tree', () => {
    const childless = {
      id: 'App',
      path: '',
      constructInfo: {
        fqn: 'aws-cdk-lib.App',
        version: '1.162.0',
      },
    };

    expect(some(childless, node => node.path.length > 0)).toBe(false);
  });
});

describe('loadTreeFromDir', () => {
  test('can find tree', async () => {
    const tree = await loadTreeFromDir(path.join(__dirname, '..', '_fixtures', 'cloud-assembly-trees', 'built-with-1_144_0'), async () => {
    });
    expect(tree?.id).toEqual('App');
  });

  test('cannot find tree', async () => {
    const tree = await loadTreeFromDir(path.join(__dirname, '..', '_fixtures', 'cloud-assembly-trees', 'foo'), async () => {
    });
    expect(tree).toEqual(undefined);
  });
});
