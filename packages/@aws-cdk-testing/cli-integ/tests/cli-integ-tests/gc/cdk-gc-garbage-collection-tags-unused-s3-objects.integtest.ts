import { GetObjectTaggingCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { integTest, withoutBootstrap, randomString } from '../../../lib';

jest.setTimeout(2 * 60 * 60_000); // Includes the time to acquire locks, worst-case single-threaded runtime

integTest(
  'Garbage Collection tags unused s3 objects',
  withoutBootstrap(async (fixture) => {
    const toolkitStackName = fixture.bootstrapStackName;
    const bootstrapBucketName = `aws-cdk-garbage-collect-integ-test-bckt-${randomString()}`;
    fixture.rememberToDeleteBucket(bootstrapBucketName); // just in case

    await fixture.cdkBootstrapModern({
      toolkitStackName,
      bootstrapBucketName,
    });

    await fixture.cdkDeploy('lambda', {
      options: [
        '--context', `bootstrapBucket=${bootstrapBucketName}`,
        '--context', `@aws-cdk/core:bootstrapQualifier=${fixture.qualifier}`,
        '--toolkit-stack-name', toolkitStackName,
        '--force',
      ],
    });
    fixture.log('Setup complete!');

    await fixture.cdkDestroy('lambda', {
      options: [
        '--context', `bootstrapBucket=${bootstrapBucketName}`,
        '--context', `@aws-cdk/core:bootstrapQualifier=${fixture.qualifier}`,
        '--toolkit-stack-name', toolkitStackName,
        '--force',
      ],
    });

    await fixture.cdkGarbageCollect({
      rollbackBufferDays: 100, // this will ensure that we do not delete assets immediately (and just tag them)
      type: 's3',
      bootstrapStackName: toolkitStackName,
    });
    fixture.log('Garbage collection complete!');

    // assert that the bootstrap bucket has the object and is tagged
    await fixture.aws.s3.send(new ListObjectsV2Command({ Bucket: bootstrapBucketName }))
      .then(async (result) => {
        expect(result.Contents).toHaveLength(2); // also the CFN template
        const key = result.Contents![0].Key;
        const tags = await fixture.aws.s3.send(new GetObjectTaggingCommand({ Bucket: bootstrapBucketName, Key: key }));
        expect(tags.TagSet).toHaveLength(1);
      });

    await fixture.cdkDestroy('lambda', {
      options: [
        '--context', `bootstrapBucket=${bootstrapBucketName}`,
        '--context', `@aws-cdk/core:bootstrapQualifier=${fixture.qualifier}`,
        '--toolkit-stack-name', toolkitStackName,
        '--force',
      ],
    });
  }),
);

