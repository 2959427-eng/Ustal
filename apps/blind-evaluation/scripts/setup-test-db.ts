#!/usr/bin/env node

/**
 * Setup test database for blind evaluation harness.
 *
 * Steps:
 * 1. Create test database (ustal_test) if it doesn't exist
 * 2. Create blind_evaluation schema
 * 3. Copy production schema into blind_evaluation namespace
 * 4. Create holdout_cases table for test data
 * 5. Verify isolation from production database
 *
 * Usage:
 *   npm run blind:setup-db
 *
 * Environment variables:
 *   TEST_DB_HOST (default: localhost)
 *   TEST_DB_PORT (default: 5432)
 *   TEST_DB_NAME (default: ustal_test)
 *   TEST_DB_USER (default: ustal_test)
 *   TEST_DB_PASSWORD (default: test_password)
 */

import { Pool } from "pg";
import { verifyTestDbIsolation, getTestDbConfig } from "../src/test-db-config.js";

async function setupTestDatabase(): Promise<void> {
  console.log("Setting up isolated test database for blind evaluation...\n");

  const config = getTestDbConfig();

  // Step 1: Verify isolation config
  console.log("Step 1: Verifying test database isolation...");
  const { isolated, errors } = verifyTestDbIsolation(config);
  if (!isolated) {
    console.error("✗ Test database configuration is not isolated:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("✓ Test database configuration verified as isolated\n");

  // Step 2: Connect to postgres (admin connection)
  console.log("Step 2: Connecting to PostgreSQL admin database...");
  const adminPool = new Pool({
    host: config.host,
    port: config.port,
    database: "postgres",
    user: process.env.TEST_DB_ADMIN_USER || "postgres",
    password: process.env.TEST_DB_ADMIN_PASSWORD,
    connectionTimeoutMillis: 5000,
    // Credentials are supplied in process memory for the local test server.
  });

  try {
    const result = await adminPool.query("SELECT version()");
    console.log("✓ Connected to PostgreSQL");
    console.log(`  Version: ${(result.rows[0]?.version || "").split(",")[0]}\n`);
  } catch (err) {
    console.error("✗ Failed to connect to PostgreSQL:");
    console.error(`  ${String(err)}`);
    console.error("\nMake sure PostgreSQL is running and credentials are correct:");
    console.error(`  Host: ${config.host}:${config.port}`);
    console.error(`  Admin user: postgres\n`);
    process.exit(1);
  }

  // Step 3: Create test database
  console.log("Step 3: Creating test database...");
  try {
    // Check if database exists
    const checkResult = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.database],
    );

    if (checkResult.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${config.database}"`);
      console.log(`✓ Created database: ${config.database}`);
    } else {
      console.log(`✓ Database already exists: ${config.database}`);
    }
  } catch (err) {
    console.error(`✗ Failed to create database:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  // Step 4: Create test database user
  console.log("\nStep 4: Creating test database user...");
  try {
    // Check if user exists
    const checkResult = await adminPool.query(
      "SELECT 1 FROM pg_user WHERE usename = $1",
      [config.user],
    );

    if (checkResult.rows.length === 0) {
      // Escape single quotes in password
      const escapedPassword = config.password.replace(/'/g, "''");
      await adminPool.query(`CREATE USER "${config.user}" WITH PASSWORD '${escapedPassword}'`);
      console.log(`✓ Created user: ${config.user}`);
    } else {
      console.log(`✓ User already exists: ${config.user}`);
    }

    // Grant privileges
    await adminPool.query(
      `GRANT ALL PRIVILEGES ON DATABASE "${config.database}" TO "${config.user}"`,
    );
    console.log(`✓ Granted privileges to user`);
  } catch (err) {
    console.error(`✗ Failed to create user:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  await adminPool.end();

  // Step 5: Connect to test database
  console.log("\nStep 5: Connecting to test database...");
  const testPool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await testPool.query("SELECT 1");
    console.log(`✓ Connected to test database: ${config.database}\n`);
  } catch (err) {
    console.error(`✗ Failed to connect to test database:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  // Step 6: Create blind_evaluation schema
  console.log("Step 6: Creating isolated schema...");
  try {
    // Create schema
    await testPool.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
    console.log(`✓ Created schema: ${config.schema}`);

    // Grant privileges
    await testPool.query(`GRANT USAGE ON SCHEMA ${config.schema} TO "${config.user}"`);
    await testPool.query(
      `GRANT CREATE ON SCHEMA ${config.schema} TO "${config.user}"`,
    );
    console.log(`✓ Granted privileges on schema\n`);
  } catch (err) {
    console.error(`✗ Failed to create schema:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  // Install pgvector only inside this isolated test database.
  const extensionPool = new Pool({host: config.host, port: config.port, database: config.database,
    user: process.env.TEST_DB_ADMIN_USER || "postgres", password: process.env.TEST_DB_ADMIN_PASSWORD, connectionTimeoutMillis: 5000});
  try { await extensionPool.query("CREATE EXTENSION IF NOT EXISTS vector"); } finally { await extensionPool.end(); }

  // Step 7: Create holdout_cases table
  console.log("Step 7: Creating holdout cases table...");
  try {
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS ${config.schema}.holdout_cases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id VARCHAR NOT NULL UNIQUE,
        skill VARCHAR NOT NULL,
        order_description TEXT NOT NULL,
        profile_json JSONB NOT NULL,
        order_json JSONB NOT NULL,
        expected_label VARCHAR NOT NULL CHECK (expected_label IN ('MATCH', 'REJECT')),
        sealed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log(`✓ Created table: ${config.schema}.holdout_cases`);

    // Create index for case lookup
    await testPool.query(`
      CREATE INDEX IF NOT EXISTS idx_holdout_case_id
      ON ${config.schema}.holdout_cases(case_id)
    `);
    console.log(`✓ Created index on case_id\n`);
  } catch (err) {
    console.error(`✗ Failed to create holdout_cases table:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  // Step 8: Create matching_candidates table (for storing predictions)
  console.log("Step 8: Creating matching candidates table...");
  try {
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS ${config.schema}.matching_candidates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        score NUMERIC(5,2) NOT NULL,
        match_type VARCHAR,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (case_id) REFERENCES ${config.schema}.holdout_cases(case_id)
      )
    `);

    console.log(`✓ Created table: ${config.schema}.matching_candidates`);

    // Create indices
    await testPool.query(`
      CREATE INDEX IF NOT EXISTS idx_matching_case_id
      ON ${config.schema}.matching_candidates(case_id)
    `);
    await testPool.query(`
      CREATE INDEX IF NOT EXISTS idx_matching_score
      ON ${config.schema}.matching_candidates(score DESC)
    `);
    console.log(`✓ Created indices on case_id and score\n`);
  } catch (err) {
    console.error(`✗ Failed to create matching_candidates table:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  // Step 9: Verify isolation
  console.log("Step 9: Verifying database isolation...");
  try {
    // Query should not be able to access other databases
    const result = await testPool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = $1
    `, [config.schema]);

    if (result.rows.length > 0) {
      console.log(`✓ Schema ${config.schema} is isolated and accessible\n`);
    } else {
      throw new Error(`Schema ${config.schema} not found`);
    }
  } catch (err) {
    console.error(`✗ Isolation verification failed:`);
    console.error(`  ${String(err)}\n`);
    process.exit(1);
  }

  await testPool.end();

  // Success message
  console.log("=== TEST DATABASE SETUP COMPLETE ===");
  console.log(`Database: ${config.database}`);
  console.log(`Schema: ${config.schema}`);
  console.log(`User: ${config.user}`);
  console.log(`Host: ${config.host}:${config.port}`);
  console.log("\nNext step: npm run blind:load-data");
  console.log("           Load holdout dataset into test database\n");
}

setupTestDatabase().catch((err) => {
  console.error("Fatal error during test database setup:", err);
  process.exit(1);
});
