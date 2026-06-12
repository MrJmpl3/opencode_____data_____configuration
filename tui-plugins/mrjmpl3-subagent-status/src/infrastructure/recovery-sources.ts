import { createSQLiteRecoverySource } from './recovery/sqlite.ts';
import type { RecoverySource } from './recovery.ts';

export const createRecoverySources = (input: {
  sqliteDatabasePath?: string;
  hardStaleAfterMs: number;
}): RecoverySource[] => {
  return [
    createSQLiteRecoverySource({ databasePath: input.sqliteDatabasePath, hardStaleAfterMs: input.hardStaleAfterMs }),
  ];
};
