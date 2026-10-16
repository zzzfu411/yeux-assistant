/**
 * Every fixed PostgreSQL advisory lock key. The numbers are part of the deployed contract: a running
 * Worker and a newly started one must agree on them, so a key is never renumbered or reused.
 * Locks derived from text (goal, session, source path) use hashtextextended and are not listed.
 */
export const LOCKS = {
  migrations: 847392001,
  legacyImport: 847392002,
  configWrite: 847392003,
  checkpointSetup: 847392004,
  mail: 847392005,
  maintenance: 847392006,
  workerOwnership: 847392007,
  mailPoll: 847392008,
  agentCredentials: 847392009,
  runSlotA: 847392010,
  runSlotB: 847392011,
  courseImport: 847392020,
  workspace: 847392030,
  knowledgeScan: 847392031,
} as const;
