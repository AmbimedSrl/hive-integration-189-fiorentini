# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS Lambda function (Node.js 22.x, ES modules) that extracts medical examination data from a MySQL/MariaDB database (via RDS Proxy with IAM auth) and exports incremental changesets as JSON to S3. Part of the AMBIMED healthcare ecosystem — a "hive" sync service for the Fiorentini company.

## Build & Deploy

```bash
# Install dependencies
npm install

# Build deployment zip (no compilation — ES modules run directly)
./build.sh
```

There are no test or lint commands configured.

## Architecture

**Single-file Lambda** (`index.mjs`) with this flow:

1. Validate environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `COMPANY_ID`, `EXPORT_BUCKET`)
2. Generate temporary RDS auth token via IAM (no hardcoded passwords)
3. Execute `query.sql` against MySQL/MariaDB
4. SHA1-hash each row and diff against previous S3 snapshot
5. Return only changed rows (max `CHANGESET_MAX_SIZE = 20` per invocation)
6. Transform DB schema → API schema (17 output fields)
7. Persist updated state snapshot to S3

**Key files:**
- `index.mjs` — Lambda handler, diffing logic, field mapping
- `query.sql` — Complex CTE-based query joining ~11 tables to extract latest exam per employee
- `build.sh` — Zips project for Lambda deployment
- `docs/db.sql` — Full database schema reference
- `docs/create-user.sql` — Read-only `report_user` setup
- `NOTE` — Domain-specific business rules (in Italian)

## Key Dependencies

- `@aws-sdk/rds-signer` — IAM auth tokens for RDS Proxy
- `@aws-sdk/client-s3` — State snapshot storage/retrieval
- `mysql2` — MySQL driver (promise API, raw SQL, no ORM)

## Domain Rules (from NOTE)

- If exam result is "idoneo" (fit), prescriptions must be forced empty
- Prescriptions must contain company-level requirements
- Base assessments should be replaced with "visita medica base"
- Timezone: database stores UTC, converted to Europe/Rome in SQL via `CONVERT_TZ()`

## Conventions

- ES modules (`"type": "module"` in package.json, `.mjs` extension)
- No TypeScript, no linter, no formatter configured
- Raw SQL queries in separate `.sql` files
- Italian-language business documentation
- Commits are GPG-signed
