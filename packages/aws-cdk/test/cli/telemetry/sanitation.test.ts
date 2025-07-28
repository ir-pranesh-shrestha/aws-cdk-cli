import { Context } from '../../../lib/api/context';
import { Settings } from '../../../lib/api/settings';
import { sanitizeCommandLineArguments, sanitizeContext } from '../../../lib/cli/telemetry/sanitation';

describe(sanitizeContext, () => {
  test('boolean values are kept', () => {
    const bag = { '@aws-cdk/core:newStyleStackSynthesis': true, '@aws-cdk/core:stackRelativeExports': false };
    const context = new Context({
      fileName: 'n/a',
      bag: new Settings(bag, true),
    });
    expect(sanitizeContext(context)).toEqual(bag);
  });

  test('string boolean values are booleanized', () => {
    const bag = { '@aws-cdk/core:newStyleStackSynthesis': 'true', '@aws-cdk/core:stackRelativeExports': 'false' };
    const context = new Context({
      fileName: 'n/a',
      bag: new Settings(bag, true),
    });
    expect(sanitizeContext(context)).toEqual({ '@aws-cdk/core:newStyleStackSynthesis': true, '@aws-cdk/core:stackRelativeExports': false });
  });

  test('strings values are booleanized', () => {
    const bag = { '@aws-cdk/core:newStyleStackSynthesis': 'fancy-value' };
    const context = new Context({
      fileName: 'n/a',
      bag: new Settings(bag, true),
    });
    expect(sanitizeContext(context)).toEqual({ '@aws-cdk/core:newStyleStackSynthesis': true });
  });

  test('list values are booleanized', () => {
    const bag = { '@aws-cdk/core:newStyleStackSynthesis': [true, false] };
    const context = new Context({
      fileName: 'n/a',
      bag: new Settings(bag, true),
    });
    expect(sanitizeContext(context)).toEqual({ '@aws-cdk/core:newStyleStackSynthesis': true });
  });

  test('non feature flag keys are dropped', () => {
    const bag = { 'my-special-key': true, '@aws-cdk/core:newStyleStackSynthesis': true };
    const context = new Context({
      fileName: 'n/a',
      bag: new Settings(bag, true),
    });
    expect(sanitizeContext(context)).toEqual({ '@aws-cdk/core:newStyleStackSynthesis': true });
  });
});

describe(sanitizeCommandLineArguments, () => {
  test('arguments are sanitized', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: {},
    });
  });

  test('multiple arguments are sanitized with a counter', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStackA', 'MyStackB'],
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1', '$STACKS_2'],
      parameters: {},
    });
  });

  test('boolean and number options are recorded', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
      all: true,
      concurrency: 4,
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: { all: true, concurrency: 4 },
    });
  });

  test('unknown and aliased options are dropped', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
      all: true,
      a: true,
      blah: false,
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: { all: true },
    });
  });

  test('non-boolean options are redacted', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
      ['build-exclude']: ['something'],
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: { 'build-exclude': '<redacted>' },
    });
  });

  test('enum options are allowed', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
      ['require-approval']: 'broadening',
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: { 'require-approval': 'broadening' },
    });
  });

  test('invalid enum options are redacted', () => {
    const argv = {
      _: ['deploy'],
      STACKS: ['MyStack'],
      ['require-approval']: 'invalid',
    };
    expect(sanitizeCommandLineArguments(argv)).toEqual({
      path: ['deploy', '$STACKS_1'],
      parameters: { 'require-approval': '<redacted>' },
    });
  });
});
