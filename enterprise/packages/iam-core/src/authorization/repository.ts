import { resolveDatabaseConfig } from "../database/config";
import type { PrincipalsRepository } from "../repos/principal-contracts";
import { postgresqlPrincipalsRepository } from "../repos/principals";
import { mysqlPrincipalsRepository } from "../repos/mysql/principals";

export function getPrincipalRepository(): PrincipalsRepository {
  return resolveDatabaseConfig().dialect === "mysql"
    ? mysqlPrincipalsRepository
    : postgresqlPrincipalsRepository;
}
