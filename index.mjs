#!/usr/bin/env node
/**
 * AWS Lambda / CLI sync for Ambimed -> Fiorentini OIC.
 *
 * Runtime flow:
 * 1. Read the last processed snapshot version from DynamoDB.
 * 2. Query the DB and hash each row.
 * 3. Compare against the S3 snapshot referenced by DynamoDB.
 * 4. Send up to CHANGESET_MAX_SIZE pending rows to OIC.
 * 5. Advance the snapshot only for rows OIC reports as successful.
 *
 * Dry run is available via Lambda event { dryRun: true }, DRY_RUN=true, or
 * CLI flag --dry-run. It reads DB/DynamoDB/S3 and logs the OIC request, but
 * does not call OIC and does not write DynamoDB or S3.
 */

import mysql from "mysql2/promise";
import pino from "pino";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export const CHANGESET_MAX_SIZE = 20;
export const STATE_PK = "sync#fiorentini";

const rawQueryPromise = fs.readFile(
  new URL("./query.sql", import.meta.url),
  "utf8"
);

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

const secretsManager = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

const REDACT_PATHS = [
  "env.DB_PASS",
  "env.OIC_PASSWORD",
  "env.OIC_USERNAME",
  "DB_PASS",
  "OIC_PASSWORD",
  "OIC_USERNAME",
  "password",
  "username",
  "headers.Authorization",
  "request.headers.Authorization",
  "oicRequest.headers.Authorization",
];

export function createAuditLogger(env = process.env) {
  return pino({
    level: env.LOG_LEVEL ?? "info",
    base: {
      service: "hive-fiorentini-export",
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "<redacted>",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}

function audit(logger, level, event, data = {}) {
  if (!logger) return;
  const payload = { event, ...data };
  if (typeof logger[level] === "function") {
    logger[level](payload);
    return;
  }
  if (typeof logger.log === "function") {
    logger.log(JSON.stringify({ level, ...payload }));
  }
}

function envAuditSummary(env) {
  return {
    awsRegion: env.AWS_REGION ?? "eu-west-1",
    configSecretId: env.CONFIG_SECRET_ID ?? env.ENV_SECRET_ID ?? env.SECRET_ID ?? null,
    companyId: env.COMPANY_ID ?? null,
    dbHost: env.DB_HOST ?? null,
    dbPort: env.DB_PORT ?? "3306",
    dbName: env.DB_NAME ?? null,
    exportBucket: env.EXPORT_BUCKET ?? null,
    syncStateTable: env.SYNC_STATE_TABLE ?? null,
    oicEndpoint: env.OIC_ENDPOINT ?? null,
    dryRun: resolveDryRun({}, env, []),
  };
}

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

export function resolveDryRun(event = {}, env = process.env, argv = []) {
  return (
    isTruthy(event?.dryRun) ||
    isTruthy(env.DRY_RUN) ||
    argv.includes("--dry-run")
  );
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function decodeSecretValue(response) {
  if (response.SecretString) return response.SecretString;
  if (response.SecretBinary) {
    return Buffer.from(response.SecretBinary).toString("utf8");
  }
  return "{}";
}

export async function loadSecretEnv({
  env = process.env,
  secretsClient = secretsManager,
  logger,
} = {}) {
  const secretId = env.CONFIG_SECRET_ID ?? env.ENV_SECRET_ID ?? env.SECRET_ID;
  if (!secretId) {
    audit(logger, "info", "config_secret_skipped", {
      reason: "missing_secret_id",
    });
    return env;
  }

  audit(logger, "info", "config_secret_read_start", { secretId });
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  const parsed = JSON.parse(decodeSecretValue(response));
  const secretEnv = Object.fromEntries(
    Object.entries(parsed)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );

  audit(logger, "info", "config_secret_read_success", {
    secretId,
    loadedKeys: Object.keys(secretEnv).sort(),
  });

  return { ...secretEnv, ...env };
}

function attrToString(attribute) {
  return attribute?.S ?? null;
}

function attrToNumber(attribute) {
  if (!attribute?.N) return null;
  return Number(attribute.N);
}

function attrToStringArray(attribute) {
  return attribute?.L?.map((item) => item.S).filter(Boolean) ?? [];
}

function stateFromItem(item) {
  if (!item) return {};
  return {
    currentVersion: attrToString(item.currentVersion),
    lastRunAt: attrToString(item.lastRunAt),
    lastStatus: attrToString(item.lastStatus),
    lastTotalRows: attrToNumber(item.lastTotalRows),
    lastChangedRows: attrToNumber(item.lastChangedRows),
    lastReturnedRows: attrToNumber(item.lastReturnedRows),
    lastOicStatusCode: attrToNumber(item.lastOicStatusCode),
    lastFailedTaxIds: attrToStringArray(item.lastFailedTaxIds),
    lastError: attrToString(item.lastError),
  };
}

function stringAttr(value) {
  return value === undefined || value === null ? undefined : { S: String(value) };
}

function numberAttr(value) {
  return value === undefined || value === null ? undefined : { N: String(value) };
}

function stringListAttr(values = []) {
  return { L: values.map((value) => ({ S: String(value) })) };
}

function compactItem(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined)
  );
}

export async function readSyncState({ dynamoClient = dynamodb, tableName }) {
  if (!tableName) return {};
  const response = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: STATE_PK } },
      ConsistentRead: true,
    })
  );
  return stateFromItem(response.Item);
}

export async function writeSyncState({
  dynamoClient = dynamodb,
  tableName,
  state,
}) {
  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: compactItem({
        pk: { S: STATE_PK },
        currentVersion: stringAttr(state.currentVersion),
        lastRunAt: stringAttr(state.lastRunAt),
        lastStatus: stringAttr(state.lastStatus),
        lastTotalRows: numberAttr(state.lastTotalRows),
        lastChangedRows: numberAttr(state.lastChangedRows),
        lastReturnedRows: numberAttr(state.lastReturnedRows),
        lastOicStatusCode: numberAttr(state.lastOicStatusCode),
        lastFailedTaxIds: stringListAttr(state.lastFailedTaxIds ?? []),
        lastError: stringAttr(state.lastError),
      }),
    })
  );
}

async function streamToString(body) {
  if (!body) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadSnapshot({
  s3Client = s3,
  bucket,
  version,
  logger,
}) {
  if (!version) {
    audit(logger, "info", "snapshot_load_skipped", {
      reason: "missing_compare_version",
    });
    return { version: null, rows: [], hashes: new Set(), key: null };
  }

  const key = `${version}.json`;
  audit(logger, "info", "snapshot_load_start", { bucket, key, version });
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const body = await streamToString(response.Body);
    const snapshot = JSON.parse(body);
    const rows = snapshot.rows ?? [];
    audit(logger, "info", "snapshot_load_success", {
      bucket,
      key,
      version,
      rowCount: rows.length,
      hashCount: rows.map((row) => row._hash).filter(Boolean).length,
    });
    return {
      version,
      rows,
      hashes: new Set(rows.map((row) => row._hash).filter(Boolean)),
      key,
    };
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      audit(logger, "warn", "snapshot_load_missing", {
        bucket,
        key,
        version,
      });
      return { version, rows: [], hashes: new Set(), key };
    }
    audit(logger, "error", "snapshot_load_failed", {
      bucket,
      key,
      version,
      err: error,
    });
    throw error;
  }
}

export async function writeSnapshot({
  s3Client = s3,
  bucket,
  version,
  rows,
  logger,
}) {
  const key = `${version}.json`;
  audit(logger, "info", "snapshot_write_start", {
    bucket,
    key,
    version,
    rowCount: rows.length,
  });
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify({ version, rows }),
      ContentType: "application/json",
    })
  );
  audit(logger, "info", "snapshot_write_success", {
    bucket,
    key,
    version,
    rowCount: rows.length,
  });
  return key;
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function rowsToCsv(rows) {
  const columns = [
    ...new Set(rows.flatMap((row) => Object.keys(row))),
  ];
  const lines = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];
  return lines.join("\n");
}

export async function writeFullExportCsv({
  s3Client = s3,
  bucket,
  executionId,
  rows,
  logger,
}) {
  const key = `exports/${new Date().toISOString()}-${executionId}.csv`;
  const csv = rowsToCsv(rows);
  audit(logger, "info", "full_export_csv_write_start", {
    bucket,
    key,
    rowCount: rows.length,
  });
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: csv,
      ContentType: "text/csv; charset=utf-8",
    })
  );
  audit(logger, "info", "full_export_csv_write_success", {
    bucket,
    key,
    rowCount: rows.length,
  });
  return key;
}

function hashRow(row) {
  return createHash("sha1").update(JSON.stringify(row)).digest("hex");
}

export function addHashes(rows) {
  return rows.map((row) => ({ ...row, _hash: hashRow(row) }));
}

function dateOnly(date) {
  if (!date) return null;
  return new Date(date).toISOString().split("T")[0];
}

export function prepareSql(rawQuery, companyId) {
  const numericCompanyId = Number(companyId);
  if (!Number.isFinite(numericCompanyId)) {
    throw new Error(`Invalid COMPANY_ID: ${companyId}`);
  }

  return rawQuery.replace(
    /^(\s*SET\s+@company_id\s*=\s*)\d+(\s*;)/im,
    `$1${numericCompanyId}$2`
  );
}

function toGmtIso(date) {
  if (!date) return null;
  return new Date(new Date(date).getTime() - 2 * 60 * 60 * 1000).toISOString();
}

function prescriptionForOic(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" && value.trim() === "") return "-";
  return value;
}

export function mapRowsToEmployees(rowsWithHash) {
  return rowsWithHash.map(({ _hash, ...row }) => ({
    firstName: row.first_name,
    lastName: row.last_name,
    taxIdCode: row.fiscal_code,
    jobTitle: row.mansione,
    type: row.tipologia,
    visitFrequency: row.base_periodicity,
    riskFactorsEvaluated: row.risk_factors,
    additionalExaminations: row.integrative_tests,
    fitnessJudgement: row.result,
    prescriptionsLimitations: prescriptionForOic(row.prescriptions),
    lastVisitDateTime: toGmtIso(row.last_visit_date),
    fitnessExpirationDate: dateOnly(row.expiration_date),
    immunologicalCoverageStatus: row.immuno_judgement,
    immunologicalCoverageExpiration: row.immuno_expiration,
    competentDoctor: row.medico_competente,
    sentToWorkerDate: dateOnly(row.transmission_to_worker),
    sentToEmployerDate: dateOnly(row.transmission_to_employer),
    judgementDate: dateOnly(row.judgement_date),
  }));
}

export function buildOicPayload({ executionId, employeeDataList }) {
  return {
    executionId,
    employeeDataList,
  };
}

export function parseOicResponse(data) {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  if (!Array.isArray(parsed?.saveResultList)) {
    throw new Error("OIC response is missing saveResultList.");
  }

  const successfulTaxIds = [];
  const failedTaxIds = [];

  for (const result of parsed.saveResultList) {
    const taxIdCode = result?.taxIdCode;
    if (!taxIdCode) continue;
    if (result.success === true || result.success === "true") {
      successfulTaxIds.push(taxIdCode);
    } else {
      failedTaxIds.push(taxIdCode);
    }
  }

  return {
    raw: parsed,
    successfulTaxIds,
    failedTaxIds,
  };
}

export function computeHybridSnapshotRows({
  previousRows,
  currentRowsWithHash,
  sentRowsWithHash,
  successfulTaxIds,
}) {
  const sentHashes = new Set(sentRowsWithHash.map((row) => row._hash));
  const successfulTaxIdSet = new Set(successfulTaxIds);
  const successfulHashes = new Set(
    sentRowsWithHash
      .filter((row) => successfulTaxIdSet.has(row.fiscal_code))
      .map((row) => row._hash)
  );
  const currentByHash = new Map(currentRowsWithHash.map((row) => [row._hash, row]));
  const processedRows = [];
  const seenHashes = new Set();

  for (const row of previousRows) {
    if (!row?._hash || sentHashes.has(row._hash)) continue;
    const currentRow = currentByHash.get(row._hash) ?? row;
    processedRows.push(currentRow);
    seenHashes.add(currentRow._hash);
  }

  for (const row of sentRowsWithHash) {
    if (!successfulHashes.has(row._hash) || seenHashes.has(row._hash)) continue;
    processedRows.push(row);
    seenHashes.add(row._hash);
  }

  return processedRows;
}

export async function callOic({
  endpoint,
  username,
  password,
  payload,
  fetchImpl = fetch,
  logger,
}) {
  audit(logger, "info", "oic_request_start", {
    endpoint,
    method: "POST",
    employeeCount: payload.employeeDataList?.length ?? 0,
    payload,
  });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`OIC request failed with HTTP ${response.status}: ${text}`);
    error.statusCode = response.status;
    error.responseBody = text;
    audit(logger, "error", "oic_request_failed", {
      endpoint,
      statusCode: response.status,
      responseBody: text,
      err: error,
    });
    throw error;
  }
  audit(logger, "info", "oic_request_success", {
    endpoint,
    statusCode: response.status,
    responseBody: text,
  });
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    audit(logger, "error", "oic_response_json_parse_failed", {
      endpoint,
      statusCode: response.status,
      responseBody: text,
      err: error,
    });
    throw error;
  }
  return {
    statusCode: response.status,
    data,
  };
}

function logDryRunRequest({ endpoint, payload, pretty, logger = console }) {
  const request = {
    method: "POST",
    url: endpoint,
    headers: {
      Authorization: "Basic <redacted>",
      "Content-Type": "application/json",
    },
    body: payload,
  };
  audit(logger, "info", "dry_run_oic_request", {
    request,
    payload,
  });
  if (pretty && typeof logger.log === "function") {
    logger.log(JSON.stringify({ dryRunOicRequest: request }, null, 2));
  }
}

async function queryRows(env, logger) {
  const rawQuery = await rawQueryPromise;
  const sql = prepareSql(rawQuery, env.COMPANY_ID);
  const dbPort = Number(env.DB_PORT ?? "3306");
  let connection;

  try {
    audit(logger, "info", "db_query_start", {
      dbHost: env.DB_HOST,
      dbPort,
      dbName: env.DB_NAME,
      companyId: env.COMPANY_ID,
      querySha1: createHash("sha1").update(sql).digest("hex"),
    });
    connection = await mysql.createConnection({
      host: env.DB_HOST,
      port: dbPort,
      user: env.DB_USER,
      password: env.DB_PASS,
      database: env.DB_NAME,
      multipleStatements: true,
    });

    const [result] = await connection.query(sql);
    if (Array.isArray(result) && Array.isArray(result[result.length - 1])) {
      audit(logger, "info", "db_query_success", {
        rowCount: result[result.length - 1].length,
        resultSetCount: result.length,
      });
      return result[result.length - 1];
    }
    audit(logger, "info", "db_query_success", {
      rowCount: Array.isArray(result) ? result.length : null,
      resultSetCount: 1,
    });
    return result;
  } catch (error) {
    audit(logger, "error", "db_query_failed", {
      dbHost: env.DB_HOST,
      dbPort,
      dbName: env.DB_NAME,
      companyId: env.COMPANY_ID,
      err: error,
    });
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      audit(logger, "info", "db_connection_closed", {
        dbHost: env.DB_HOST,
        dbPort,
        dbName: env.DB_NAME,
      });
    }
  }
}

function getExecutionId(event, context) {
  return (
    event?.executionId ??
    context?.awsRequestId ??
    `local-${new Date().toISOString()}-${randomUUID()}`
  );
}

export async function runSync({
  event = {},
  context = {},
  env = process.env,
  s3Client = s3,
  dynamoClient = dynamodb,
  secretsClient = secretsManager,
  fetchImpl = fetch,
  queryRowsImpl = queryRows,
  logger = createAuditLogger(env),
  argv = [],
} = {}) {
  env = await loadSecretEnv({ env, secretsClient, logger });
  if (env.LOG_LEVEL && "level" in logger) {
    logger.level = env.LOG_LEVEL;
  }
  const dryRun = resolveDryRun(event, env, argv);
  const pretty = argv.includes("--pretty") || isTruthy(event?.pretty);
  const executionId = getExecutionId(event, context);
  const runLogger =
    typeof logger.child === "function"
      ? logger.child({
          executionId,
          awsRequestId: context?.awsRequestId ?? null,
        })
      : logger;

  audit(runLogger, "info", "sync_run_start", {
    dryRun,
    compareVersion: event.compareVersion ?? null,
    env: envAuditSummary(env),
  });

  requireEnv(env, [
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
    "DB_PASS",
    "COMPANY_ID",
    "EXPORT_BUCKET",
    "SYNC_STATE_TABLE",
    "OIC_ENDPOINT",
  ]);

  if (!dryRun) {
    requireEnv(env, ["OIC_USERNAME", "OIC_PASSWORD"]);
  }

  const state = await readSyncState({
    dynamoClient,
    tableName: env.SYNC_STATE_TABLE,
  });
  audit(runLogger, "info", "sync_state_read", {
    tableName: env.SYNC_STATE_TABLE,
    state,
  });
  const compareVersion = event.compareVersion ?? state.currentVersion ?? null;
  const snapshot = await loadSnapshot({
    s3Client,
    bucket: env.EXPORT_BUCKET,
    version: compareVersion,
    logger: runLogger,
  });

  const rows = await queryRowsImpl(env, runLogger);
  const fullExportCsvKey = await writeFullExportCsv({
    s3Client,
    bucket: env.EXPORT_BUCKET,
    executionId,
    rows,
    logger: runLogger,
  });
  const rowsWithHash = addHashes(rows);
  const pendingRowsWithHash = snapshot.hashes.size
    ? rowsWithHash.filter((row) => !snapshot.hashes.has(row._hash))
    : rowsWithHash;
  const sentRowsWithHash = pendingRowsWithHash.slice(0, CHANGESET_MAX_SIZE);
  const employeeDataList = mapRowsToEmployees(sentRowsWithHash);
  const payload = buildOicPayload({ executionId, employeeDataList });
  audit(runLogger, "info", "changeset_computed", {
    comparedTo: compareVersion,
    snapshotHashCount: snapshot.hashes.size,
    totalRows: rowsWithHash.length,
    totalChangedRows: pendingRowsWithHash.length,
    returnedRows: sentRowsWithHash.length,
    changeLimit: CHANGESET_MAX_SIZE,
    sentTaxIds: sentRowsWithHash.map((row) => row.fiscal_code),
  });
  audit(runLogger, "info", "oic_payload_prepared", {
    endpoint: env.OIC_ENDPOINT,
    employeeCount: employeeDataList.length,
    payload,
  });

  const baseResult = {
    executionId,
    dryRun,
    comparedTo: compareVersion,
    totalRows: rowsWithHash.length,
    totalChangedRows: pendingRowsWithHash.length,
    count: sentRowsWithHash.length,
    fullExportCsvKey,
  };

  if (sentRowsWithHash.length === 0) {
    const runState = {
      currentVersion: compareVersion,
      lastRunAt: new Date().toISOString(),
      lastStatus: "no_changes",
      lastTotalRows: rowsWithHash.length,
      lastChangedRows: 0,
      lastReturnedRows: 0,
      lastOicStatusCode: null,
      lastFailedTaxIds: [],
      lastError: null,
    };
    if (!dryRun) {
      audit(runLogger, "info", "sync_state_write_start", {
        tableName: env.SYNC_STATE_TABLE,
        state: runState,
      });
      await writeSyncState({
        dynamoClient,
        tableName: env.SYNC_STATE_TABLE,
        state: runState,
      });
      audit(runLogger, "info", "sync_state_write_success", {
        tableName: env.SYNC_STATE_TABLE,
        state: runState,
      });
    }
    audit(runLogger, "info", "sync_run_complete", {
      status: "no_changes",
      success: true,
      dryRun,
      ...baseResult,
    });
    return {
      ...baseResult,
      employeeDataList: [],
      currentVersion: null,
      status: "no_changes",
      success: true,
    };
  }

  if (dryRun) {
    logDryRunRequest({
      endpoint: env.OIC_ENDPOINT,
      payload,
      pretty,
      logger: runLogger,
    });
    audit(runLogger, "info", "sync_run_complete", {
      status: "dry_run",
      success: true,
      dryRun,
      ...baseResult,
    });
    return {
      ...baseResult,
      currentVersion: compareVersion,
      status: "dry_run",
      success: true,
      employeeDataList,
      oicRequest: {
        method: "POST",
        url: env.OIC_ENDPOINT,
        headers: {
          Authorization: "Basic <redacted>",
          "Content-Type": "application/json",
        },
        body: payload,
      },
    };
  }

  const oicResponse = await callOic({
    endpoint: env.OIC_ENDPOINT,
    username: env.OIC_USERNAME,
    password: env.OIC_PASSWORD,
    payload,
    fetchImpl,
    logger: runLogger,
  });
  const parsedOic = parseOicResponse(oicResponse.data);
  audit(runLogger, "info", "oic_response_parsed", {
    statusCode: oicResponse.statusCode,
    successfulTaxIds: parsedOic.successfulTaxIds,
    failedTaxIds: parsedOic.failedTaxIds,
    raw: parsedOic.raw,
  });
  const successfulTaxIdSet = new Set(parsedOic.successfulTaxIds);
  const failedTaxIds = [
    ...new Set(
      parsedOic.failedTaxIds.concat(
        sentRowsWithHash
          .map((row) => row.fiscal_code)
          .filter((taxIdCode) => !successfulTaxIdSet.has(taxIdCode))
      )
    ),
  ];
  const processedRows = computeHybridSnapshotRows({
    previousRows: snapshot.rows,
    currentRowsWithHash: rowsWithHash,
    sentRowsWithHash,
    successfulTaxIds: parsedOic.successfulTaxIds,
  });

  const currentVersion = compareVersion ?? new Date().toISOString();
  await writeSnapshot({
    s3Client,
    bucket: env.EXPORT_BUCKET,
    version: currentVersion,
    rows: processedRows,
    logger: runLogger,
  });

  const status = failedTaxIds.length > 0 ? "partial_failure" : "success";
  const nextState = {
    currentVersion,
    lastRunAt: new Date().toISOString(),
    lastStatus: status,
    lastTotalRows: rowsWithHash.length,
    lastChangedRows: pendingRowsWithHash.length,
    lastReturnedRows: sentRowsWithHash.length,
    lastOicStatusCode: oicResponse.statusCode,
    lastFailedTaxIds: failedTaxIds,
    lastError: null,
  };
  audit(runLogger, "info", "sync_state_write_start", {
    tableName: env.SYNC_STATE_TABLE,
    state: nextState,
  });
  await writeSyncState({
    dynamoClient,
    tableName: env.SYNC_STATE_TABLE,
    state: nextState,
  });
  audit(runLogger, "info", "sync_state_write_success", {
    tableName: env.SYNC_STATE_TABLE,
    state: nextState,
  });

  audit(runLogger, "info", "sync_run_complete", {
    status,
    success: failedTaxIds.length === 0,
    dryRun,
    ...baseResult,
    currentVersion,
    oicStatusCode: oicResponse.statusCode,
    successfulTaxIds: parsedOic.successfulTaxIds,
    failedTaxIds,
  });

  return {
    ...baseResult,
    currentVersion,
    status,
    success: failedTaxIds.length === 0,
    oicStatusCode: oicResponse.statusCode,
    successfulTaxIds: parsedOic.successfulTaxIds,
    failedTaxIds,
  };
}

export const handler = async (event = {}, context = {}) => {
  const logger = createAuditLogger(process.env);
  try {
    return await runSync({ event, context, logger });
  } catch (error) {
    audit(logger, "error", "sync_run_failed", {
      awsRequestId: context?.awsRequestId ?? null,
      err: error,
    });
    return {
      success: false,
      status: "failed",
      count: 0,
      error: error.message,
    };
  }
};

async function main() {
  const logger = createAuditLogger(process.env);
  const result = await runSync({ argv: process.argv.slice(2), logger });
  const pretty = process.argv.includes("--pretty");
  console.log(pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
