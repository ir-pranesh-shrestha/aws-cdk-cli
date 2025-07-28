import type { Duration } from '@aws-cdk/toolkit-lib';
import type { ErrorDetails } from './schema';
import * as make from '../../api-private';
import type { SpanDefinition } from '../../api-private';

export interface EventResult extends Duration {
  error?: ErrorDetails;
}

export interface EventStart {
}

/**
 * Private message types specific to the CLI
 */
export const CLI_PRIVATE_IO = {
  CDK_CLI_I1000: make.trace<EventStart>({
    code: 'CDK_CLI_I1000',
    description: 'Cloud Execution is starting',
    interface: 'EventStart',
  }),
  CDK_CLI_I1001: make.trace<EventResult>({
    code: 'CDK_CLI_I1001',
    description: 'Cloud Executable Result',
    interface: 'EventResult',
  }),
  CDK_CLI_I2000: make.trace<EventStart>({
    code: 'CDK_CLI_I2000',
    description: 'Command has started',
    interface: 'EventStart',
  }),
  CDK_CLI_I2001: make.trace<EventResult>({
    code: 'CDK_CLI_I2001',
    description: 'Command has finished executing',
    interface: 'EventResult',
  }),
  CDK_CLI_I3000: make.trace<EventStart>({
    code: 'CDK_CLI_I3000',
    description: 'Deploy has started',
    interface: 'EventStart',
  }),
  CDK_CLI_I3001: make.trace<EventResult>({
    code: 'CDK_CLI_I3001',
    description: 'Deploy has finished',
    interface: 'EventResult',
  }),
};

/**
 * Payload type of the end message must extend Duration
 */
export const CLI_PRIVATE_SPAN = {
  SYNTH_ASSEMBLY: {
    name: 'Synthesis',
    start: CLI_PRIVATE_IO.CDK_CLI_I1000,
    end: CLI_PRIVATE_IO.CDK_CLI_I1001,
  },
  COMMAND: {
    name: 'Command',
    start: CLI_PRIVATE_IO.CDK_CLI_I2000,
    end: CLI_PRIVATE_IO.CDK_CLI_I2001,
  },
  DEPLOY: {
    name: 'Deploy',
    start: CLI_PRIVATE_IO.CDK_CLI_I3000,
    end: CLI_PRIVATE_IO.CDK_CLI_I3001,
  },
} satisfies Record<string, SpanDefinition<any, any>>;

export const CLI_TELEMETRY_CODES = [
  CLI_PRIVATE_IO.CDK_CLI_I1001,
  CLI_PRIVATE_IO.CDK_CLI_I2001,
  CLI_PRIVATE_IO.CDK_CLI_I3001,
];
