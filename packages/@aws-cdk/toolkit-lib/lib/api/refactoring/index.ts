import type { TypedMapping } from '@aws-cdk/cloudformation-diff';
import {
  formatAmbiguousMappings as fmtAmbiguousMappings,
  formatTypedMappings as fmtTypedMappings,
} from '@aws-cdk/cloudformation-diff';
import type * as cxapi from '@aws-cdk/cx-api';
import type { StackSummary } from '@aws-sdk/client-cloudformation';
import { deserializeStructure } from '../../util';
import type { SdkProvider } from '../aws-auth/private';
import { Mode } from '../plugin';
import { StringWriteStream } from '../streams';
import type { CloudFormationStack } from './cloudformation';
import { ResourceLocation, ResourceMapping } from './cloudformation';
import { computeResourceDigests, hashObject } from './digest';
import { type ExcludeList, NeverExclude } from './exclude';
import type { MappingGroup } from '../../actions';
import { ToolkitError } from '../../toolkit/toolkit-error';

export * from './exclude';

/**
 * Represents a set of possible movements of a resource from one location
 * to another. In the ideal case, there is only one source and only one
 * destination.
 */
export type ResourceMovement = [ResourceLocation[], ResourceLocation[]];

export class AmbiguityError extends Error {
  constructor(public readonly movements: ResourceMovement[]) {
    super('Ambiguous resource mappings');
  }

  public paths(): [string[], string[]][] {
    return this.movements.map(([a, b]) => [convert(a), convert(b)]);

    function convert(locations: ResourceLocation[]): string[] {
      return locations.map((l) => l.toPath());
    }
  }
}

function groupByKey<A>(entries: [string, A][]): Record<string, A[]> {
  const result: Record<string, A[]> = {};

  for (const [hash, location] of entries) {
    if (hash in result) {
      result[hash].push(location);
    } else {
      result[hash] = [location];
    }
  }

  return result;
}

export async function usePrescribedMappings(
  mappingGroups: MappingGroup[],
  sdkProvider: SdkProvider,
): Promise<ResourceMapping[]> {
  interface StackGroup extends MappingGroup {
    stacks: CloudFormationStack[];
  }

  const stackGroups: StackGroup[] = [];
  for (const group of mappingGroups) {
    stackGroups.push({
      ...group,
      stacks: await getDeployedStacks(sdkProvider, environmentOf(group)),
    });
  }

  // Validate that there are no duplicate destinations
  for (let group of stackGroups) {
    const destinations = new Set<string>();

    for (const destination of Object.values(group.resources)) {
      if (destinations.has(destination)) {
        throw new ToolkitError(
          `Duplicate destination resource '${destination}' in environment ${group.account}/${group.region}`,
        );
      }
      destinations.add(destination);
    }
  }

  const result: ResourceMapping[] = [];
  for (const group of stackGroups) {
    for (const [source, destination] of Object.entries(group.resources)) {
      if (!inUse(source, group.stacks)) {
        throw new ToolkitError(`Source resource '${source}' does not exist in environment ${group.account}/${group.region}`);
      }

      if (inUse(destination, group.stacks)) {
        throw new ToolkitError(
          `Destination resource '${destination}' already in use in environment ${group.account}/${group.region}`,
        );
      }

      const environment = environmentOf(group);
      const src = makeLocation(source, environment, group.stacks);
      const dst = makeLocation(destination, environment);
      result.push(new ResourceMapping(src, dst));
    }
  }
  return result;

  function inUse(location: string, stacks: CloudFormationStack[]): boolean {
    const [stackName, logicalId] = location.split('.');
    if (stackName == null || logicalId == null) {
      throw new ToolkitError(`Invalid location '${location}'`);
    }
    const stack = stacks.find((s) => s.stackName === stackName);
    return stack != null && stack.template.Resources?.[logicalId] != null;
  }

  function environmentOf(group: MappingGroup) {
    return {
      account: group.account,
      region: group.region,
      name: '',
    };
  }

  function makeLocation(
    loc: string,
    environment: cxapi.Environment,
    stacks: CloudFormationStack[] = [],
  ): ResourceLocation {
    const [stackName, logicalId] = loc.split('.');
    const stack = stacks.find((s) => s.stackName === stackName);

    return new ResourceLocation(
      {
        stackName,
        environment,
        template: stack?.template ?? {},
      },
      logicalId,
    );
  }
}

export function resourceMovements(before: CloudFormationStack[], after: CloudFormationStack[]): ResourceMovement[] {
  return Object.values(
    removeUnmovedResources(
      zip(groupByKey(resourceDigests(before)), groupByKey(resourceDigests(after))),
    ),
  );
}

export function ambiguousMovements(movements: ResourceMovement[]) {
  // A movement is considered ambiguous if these two conditions are met:
  //  1. Both sides have at least one element (otherwise, it's just addition or deletion)
  //  2. At least one side has more than one element
  return movements
    .filter(([pre, post]) => pre.length > 0 && post.length > 0)
    .filter(([pre, post]) => pre.length > 1 || post.length > 1);
}

/**
 * Converts a list of unambiguous resource movements into a list of resource mappings.
 *
 */
export function resourceMappings(movements: ResourceMovement[], stacks?: CloudFormationStack[]): ResourceMapping[] {
  const stacksPredicate =
    stacks == null
      ? () => true
      : (m: ResourceMapping) => {
        // Any movement that involves one of the selected stacks (either moving from or to)
        // is considered a candidate for refactoring.
        const stackNames = [m.source.stack.stackName, m.destination.stack.stackName];
        return stacks.some((stack) => stackNames.includes(stack.stackName));
      };

  return movements
    .filter(([pre, post]) => pre.length === 1 && post.length === 1 && !pre[0].equalTo(post[0]))
    .map(([pre, post]) => new ResourceMapping(pre[0], post[0]))
    .filter(stacksPredicate);
}

function removeUnmovedResources(m: Record<string, ResourceMovement>): Record<string, ResourceMovement> {
  const result: Record<string, ResourceMovement> = {};
  for (const [hash, [before, after]] of Object.entries(m)) {
    const common = before.filter((b) => after.some((a) => a.equalTo(b)));
    result[hash] = [
      before.filter((b) => !common.some((c) => b.equalTo(c))),
      after.filter((a) => !common.some((c) => a.equalTo(c))),
    ];
  }

  return result;
}

/**
 * For each hash, identifying a single resource, zip the two lists of locations,
 * producing a resource movement
 */
function zip(
  m1: Record<string, ResourceLocation[]>,
  m2: Record<string, ResourceLocation[]>,
): Record<string, ResourceMovement> {
  const result: Record<string, ResourceMovement> = {};

  for (const [hash, locations] of Object.entries(m1)) {
    if (hash in m2) {
      result[hash] = [locations, m2[hash]];
    } else {
      result[hash] = [locations, []];
    }
  }

  for (const [hash, locations] of Object.entries(m2)) {
    if (!(hash in m1)) {
      result[hash] = [[], locations];
    }
  }

  return result;
}

/**
 * Computes a list of pairs [digest, location] for each resource in the stack.
 */
function resourceDigests(stacks: CloudFormationStack[]): [string, ResourceLocation][] {
  // index stacks by name
  const stacksByName = new Map<string, CloudFormationStack>();
  for (const stack of stacks) {
    stacksByName.set(stack.stackName, stack);
  }

  const digests = computeResourceDigests(stacks);

  return Object.entries(digests).map(([loc, digest]) => {
    const [stackName, logicalId] = loc.split('.');
    const location: ResourceLocation = new ResourceLocation(stacksByName.get(stackName)!, logicalId);
    return [digest, location];
  });
}

/**
 * Compares the deployed state to the cloud assembly state, and finds all resources
 * that were moved from one location (stack + logical ID) to another. The comparison
 * is done per environment.
 */
export async function findResourceMovements(
  stacks: CloudFormationStack[],
  sdkProvider: SdkProvider,
  exclude: ExcludeList = new NeverExclude(),
): Promise<ResourceMovement[]> {
  const stackGroups: Map<string, [CloudFormationStack[], CloudFormationStack[]]> = new Map();

  // Group stacks by environment
  for (const stack of stacks) {
    const environment = stack.environment;
    const key = hashObject(environment);
    if (stackGroups.has(key)) {
      stackGroups.get(key)![1].push(stack);
    } else {
      // The first time we see an environment, we need to fetch all stacks deployed to it.
      const before = await getDeployedStacks(sdkProvider, environment);
      stackGroups.set(key, [before, [stack]]);
    }
  }

  const result: ResourceMovement[] = [];
  for (const [_, [before, after]] of stackGroups) {
    result.push(...resourceMovements(before, after));
  }

  return result.filter((mov) => {
    const after = mov[1];
    return after.every((l) => !exclude.isExcluded(l));
  });
}

async function getDeployedStacks(
  sdkProvider: SdkProvider,
  environment: cxapi.Environment,
): Promise<CloudFormationStack[]> {
  const cfn = (await sdkProvider.forEnvironment(environment, Mode.ForReading)).sdk.cloudFormation();

  const summaries = await cfn.paginatedListStacks({
    StackStatusFilter: [
      'CREATE_COMPLETE',
      'UPDATE_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
      'IMPORT_COMPLETE',
      'ROLLBACK_COMPLETE',
    ],
  });

  const normalize = async (summary: StackSummary) => {
    const templateCommandOutput = await cfn.getTemplate({ StackName: summary.StackName! });
    const template = deserializeStructure(templateCommandOutput.TemplateBody ?? '{}');
    return {
      environment,
      stackName: summary.StackName!,
      template,
    };
  };

  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  return Promise.all(summaries.map(normalize));
}

export function formatTypedMappings(mappings: TypedMapping[]): string {
  const stream = new StringWriteStream();
  fmtTypedMappings(stream, mappings);
  return stream.toString();
}

export function formatAmbiguousMappings(paths: [string[], string[]][]): string {
  const stream = new StringWriteStream();
  fmtAmbiguousMappings(stream, paths);
  return stream.toString();
}
