// STAGE-0 PROBE STUB: in-memory replacement for the Postgres client. Only what
// worker/semantic.ts prepareDocument() touches: select ontology nodes/synonyms, insert ai_runs.
export * as schema from "./schema.js";
export type Database = any;
export function getDb(): any { return (globalThis as any).__fakeDb; }
