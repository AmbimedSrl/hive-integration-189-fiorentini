# Ambimed Hive Fiorentini Export

This repository contains the Ambimed Hive integration that exports medical visit
fitness data for company `189` to the Fiorentini OIC/Salesforce flow.

It replaces the previous Make scenario with an AWS Lambda deployment managed by
CDK. The SQL extraction query is kept in `query.sql`; the Lambda prepares that
query with the configured company id, maps the result rows to the OIC payload,
and sends only rows that have not already been processed successfully.

## What It Does

- Runs the original Hive database export query for Fiorentini.
- Writes a full CSV export to S3 on every run, including dry runs, for audit and
  debugging.
- Sends changed rows to the Fiorentini OIC endpoint.
- Tracks successful rows with a DynamoDB-backed sync state and S3 snapshots.
- Keeps failed OIC rows pending so they can be retried on a later run.
- Logs audit-ready structured JSON with Pino, including request payloads,
  response details, row counts, errors, and state transitions.

## Infrastructure

The CDK stack deploys:

- Lambda function `hive-fiorentini-export` in `eu-west-1`.
- EventBridge Scheduler invocation every day at `04:00 Europe/Rome`.
- S3 bucket for snapshots and full CSV exports.
- DynamoDB table for sync cursor/state.
- CloudWatch log group with 365-day retention.
- IAM permissions for Secrets Manager, S3, DynamoDB, and Scheduler invocation.

The Lambda is attached to the existing Ambimed production VPC/subnets/security
groups by id. The stack imports those network resources and does not modify the
VPC, database, or existing security group rules.

Detailed deployment notes are in `docs/cdk.md`.

## Configuration

Runtime configuration is read from the Secrets Manager JSON secret
`hive-fiorentini-export/env`.

Required secret keys include:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`
- `COMPANY_ID`
- `OIC_ENDPOINT`, `OIC_USERNAME`, `OIC_PASSWORD`
- `DRY_RUN`
- `LOG_LEVEL`

Set `DRY_RUN=true` to query the database and write the full CSV audit export
without calling OIC or advancing the sync state.

Set `LOG_LEVEL` to control Pino output. The default is `info`; use `trace` for
maximum verbosity.

## Local Checks

```bash
pnpm test
pnpm synth --quiet
```

`pnpm synth` bundles production Lambda dependencies and may need network access
to install packages from the npm registry.
