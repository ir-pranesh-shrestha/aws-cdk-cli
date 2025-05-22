import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CreateTopicCommand, DeleteTopicCommand } from '@aws-sdk/client-sns';
import { integTest, withDefaultFixture } from '../../../lib';

jest.setTimeout(2 * 60 * 60_000); // Includes the time to acquire locks, worst-case single-threaded runtime

integTest('deploy with notification ARN as prop', withDefaultFixture(async (fixture) => {
  const topicName = `${fixture.stackNamePrefix}-test-topic-prop`;

  const response = await fixture.aws.sns.send(new CreateTopicCommand({ Name: topicName }));
  const topicArn = response.TopicArn!;

  try {
    await fixture.cdkDeploy('notification-arns', {
      modEnv: {
        INTEG_NOTIFICATION_ARNS: topicArn,

      },
    });

    // verify that the stack we deployed has our notification ARN
    const describeResponse = await fixture.aws.cloudFormation.send(
      new DescribeStacksCommand({
        StackName: fixture.fullStackName('notification-arns'),
      }),
    );
    expect(describeResponse.Stacks?.[0].NotificationARNs).toEqual([topicArn]);
  } finally {
    await fixture.aws.sns.send(
      new DeleteTopicCommand({
        TopicArn: topicArn,
      }),
    );
  }
}));

// https://github.com/aws/aws-cdk/issues/32153
