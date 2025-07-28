import { FeatureFlag } from './feature-flags';
import type { Context } from '../../api/context';

/**
 * argv is the output of yargs
 */
export function sanitizeCommandLineArguments(argv: any): { path: string[]; parameters: { [key: string]: string } } {
  // Get the configuration of the arguments

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('../cli-type-registry.json');
  const command = argv._[0];
  const path: string[] = [command];
  const parameters: { [key: string]: string } = {};

  const globalOptions: any[] = Object.keys(config.globalOptions);
  const commandOptions: any[] = Object.keys(config.commands[command]?.options ?? {});
  const commandArg: { name: string; variadic: string } | undefined = config.commands[command]?.arg;

  for (const argName of Object.keys(argv)) {
    if (argName === commandArg?.name) {
      if (commandArg.variadic) {
        for (let i = 0; i < argv[argName].length; i++) {
          path.push(`$${argName}_${i+1}`);
        }
      } else {
        path.push(`$${argName}`);
      }
    }

    // Continue if the arg name is not a global option or command option
    // arg name comes from yargs and could be an alias; we trust that the "normal"
    // name has the same information and that is what we want to record
    if (argv[argName] === undefined || (!globalOptions.includes(argName) && !commandOptions.includes(argName))) {
      continue;
    }
    if (isNumberOrBoolean(argv[argName]) || isKnownEnumValue(argName, argv[argName], command, config)) {
      parameters[argName] = argv[argName];
    } else {
      parameters[argName] = '<redacted>';
    }
  }

  return {
    path,
    parameters,
  };
}

export function sanitizeContext(context: Context) {
  const sanitizedContext: { [K in FeatureFlag]: boolean } = {} as { [K in FeatureFlag]: boolean };
  for (const [flag, value] of Object.entries(context.all)) {
    // Skip if flag is not in the FeatureFlags enum
    if (!isFeatureFlag(flag)) {
      continue;
    }

    // Falsy options include boolean false, string 'false'
    // All other inputs evaluate to true
    const sanitizedValue: boolean = isBoolean(value) ? value : (value !== 'false');
    sanitizedContext[flag] = sanitizedValue;
  }
  return sanitizedContext;
}

function isBoolean(value: any): value is boolean {
  return typeof value === 'boolean';
}

function isNumberOrBoolean(value: any): boolean {
  return typeof value === 'number' || isBoolean(value);
}

function isKnownEnumValue(name: string, value: any, command: string, config: any): boolean {
  const propertyDefiniton = config.globalOptions[name] ?? config.commands[command]?.options[name];
  if (propertyDefiniton.type === 'string') {
    // Even if the property has choices, only record if the value is a valid choice
    return propertyDefiniton.choices?.includes(value);
  }
  return false;
}

function isFeatureFlag(flag: string): flag is FeatureFlag {
  return Object.values(FeatureFlag).includes(flag as FeatureFlag);
}
