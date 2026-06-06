import { createSQLiteRecoverySource } from './recovery/sqlite.ts';
import type { RecoverySource } from './recovery.ts';

export function createRecoverySources(input: { sqliteDatabasePath?: string } = {}): RecoverySource[] {
  return [createSQLiteRecoverySource({ databasePath: input.sqliteDatabasePath })];
}
