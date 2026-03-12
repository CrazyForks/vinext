import * as migration_20260312_205130 from './20260312_205130';

export const migrations = [
  {
    up: migration_20260312_205130.up,
    down: migration_20260312_205130.down,
    name: '20260312_205130'
  },
];
