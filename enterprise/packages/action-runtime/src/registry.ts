import type { ActionDefinition, PublicAction } from "./types";

export class ActionNotFoundError extends Error {
  public readonly code = "ACTION_NOT_FOUND";
  public constructor(actionId: string) {
    super(`action is not registered: ${actionId}`);
    this.name = "ActionNotFoundError";
  }
}

export class DuplicateActionError extends Error {
  public readonly code = "ACTION_DUPLICATE";
  public constructor(actionId: string) {
    super(`action is already registered: ${actionId}`);
    this.name = "DuplicateActionError";
  }
}

/**
 * Process local registry.  Definitions are code owned; clients only submit
 * an id and JSON arguments.  A registry instance may be constructed per
 * application to make tests and tenant-specific action packs explicit.
 */
export class ActionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>();

  public constructor(definitions: readonly ActionDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  public register(definition: ActionDefinition): this {
    const id = definition.id.trim();
    if (!id || !/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(id)) {
      throw new Error("action id must use dot-separated lowercase segments");
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error("action version must be a positive integer");
    }
    if (!definition.label.trim() || !definition.description.trim()) {
      throw new Error("action label and description are required");
    }
    if (this.definitions.has(id)) throw new DuplicateActionError(id);
    this.definitions.set(id, { ...definition, id });
    return this;
  }

  public get(actionId: string): ActionDefinition | null {
    const id = actionId.trim();
    return this.definitions.get(id) ?? null;
  }

  public require(actionId: string): ActionDefinition {
    const action = this.get(actionId);
    if (!action) throw new ActionNotFoundError(actionId);
    return action;
  }

  public list(): ActionDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public publicList(): PublicAction[] {
    return this.list().map(({ handler: _handler, requiredScopes: _scopes, version: _version, policy: _policy, capabilityTargets: _capabilityTargets, capabilityId: _capabilityId, ...publicAction }) => publicAction);
  }
}

export function createActionRegistry(definitions: readonly ActionDefinition[]): ActionRegistry {
  return new ActionRegistry(definitions);
}
