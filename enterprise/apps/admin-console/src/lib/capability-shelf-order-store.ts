import { resolveDatabaseConfig } from "@agenticx/iam-core";

import * as mysql from "./db-stores/mysql/capability-shelf-order-store";
import * as postgresql from "./db-stores/postgresql/capability-shelf-order-store";

export type * from "./db-stores/postgresql/capability-shelf-order-store";
export {
  MAX_CAPABILITY_SHELF_ITEMS,
  CapabilityShelfMembershipValidationError,
  CapabilityShelfOrderValidationError,
  normalizeCapabilityShelfOrder,
} from "./capability-shelf-order-contract";

function implementation(): typeof postgresql {
  return resolveDatabaseConfig().dialect === "mysql" ? mysql : postgresql;
}

export const getCapabilityShelfOrder: typeof postgresql.getCapabilityShelfOrder = (...args) =>
  implementation().getCapabilityShelfOrder(...args);

export const replaceCapabilityShelfOrder: typeof postgresql.replaceCapabilityShelfOrder = (...args) =>
  implementation().replaceCapabilityShelfOrder(...args);

export const addCapabilityToShelf: typeof postgresql.addCapabilityToShelf = (...args) =>
  implementation().addCapabilityToShelf(...args);

export const removeCapabilityFromShelf: typeof postgresql.removeCapabilityFromShelf = (...args) =>
  implementation().removeCapabilityFromShelf(...args);
