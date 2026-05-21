import test from "node:test";
import assert from "node:assert/strict";
import {
  addHashes,
  computeHybridSnapshotRows,
  loadSecretEnv,
  mapRowsToEmployees,
  parseOicResponse,
  prepareSql,
  resolveDryRun,
  runSync,
  rowsToCsv,
} from "./index.mjs";

const env = {
  DB_HOST: "db.example.test",
  DB_NAME: "ambimed",
  DB_USER: "user",
  DB_PASS: "pass",
  COMPANY_ID: "189",
  EXPORT_BUCKET: "snapshots",
  SYNC_STATE_TABLE: "sync-state",
  OIC_ENDPOINT: "https://oic.example.test/sync",
};

const rows = [
  {
    first_name: "Mario",
    last_name: "Rossi",
    fiscal_code: "RSSMRA80A01F205X",
    mansione: "Operaio",
    tipologia: "Periodica",
    base_periodicity: "Annuale",
    risk_factors: "Rumore",
    integrative_tests: "Audiometria",
    result: "Idoneo",
    prescriptions: "",
    last_visit_date: "2026-05-01T10:00:00.000Z",
    expiration_date: "2027-05-01T00:00:00.000Z",
    immuno_judgement: null,
    immuno_expiration: null,
    medico_competente: "Dr Test",
    transmission_to_worker: "2026-05-02T00:00:00.000Z",
    transmission_to_employer: "2026-05-02T00:00:00.000Z",
    judgement_date: "2026-05-01T00:00:00.000Z",
  },
  {
    first_name: "Anna",
    last_name: "Bianchi",
    fiscal_code: "BNCNNA80A41H501Y",
    mansione: "Impiegata",
    tipologia: "Periodica",
    base_periodicity: "Biennale",
    risk_factors: "VDT",
    integrative_tests: "Visiotest",
    result: "Idonea",
    prescriptions: "",
    last_visit_date: "2026-05-03T10:00:00.000Z",
    expiration_date: "2028-05-03T00:00:00.000Z",
    immuno_judgement: null,
    immuno_expiration: null,
    medico_competente: "Dr Test",
    transmission_to_worker: "2026-05-04T00:00:00.000Z",
    transmission_to_employer: "2026-05-04T00:00:00.000Z",
    judgement_date: "2026-05-03T00:00:00.000Z",
  },
];

function fakeDynamoClient(state = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "GetItemCommand") {
        return {
          Item: state.currentVersion
            ? {
                pk: { S: "sync#fiorentini" },
                currentVersion: { S: state.currentVersion },
              }
            : undefined,
        };
      }
      return {};
    },
  };
}

function fakeS3Client(snapshotRows = []) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: Buffer.from(
            JSON.stringify({ version: "v1", rows: snapshotRows }),
            "utf8"
          ),
        };
      }
      return {};
    },
  };
}

function createCaptureLogger() {
  const entries = [];
  const logger = {
    entries,
    child() {
      return logger;
    },
    info(entry) {
      entries.push({ level: "info", ...entry });
    },
    warn(entry) {
      entries.push({ level: "warn", ...entry });
    },
    error(entry) {
      entries.push({ level: "error", ...entry });
    },
    log(message) {
      entries.push({ level: "log", message });
    },
  };
  return logger;
}

const silentLogger = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

test("resolveDryRun accepts event, env, and CLI flags", () => {
  assert.equal(resolveDryRun({ dryRun: true }, {}, []), true);
  assert.equal(resolveDryRun({}, { DRY_RUN: "true" }, []), true);
  assert.equal(resolveDryRun({}, {}, ["--dry-run"]), true);
  assert.equal(resolveDryRun({}, { DRY_RUN: "false" }, []), false);
});

test("loadSecretEnv merges JSON secret values without overriding explicit env", async () => {
  const secretsClient = {
    async send(command) {
      assert.equal(command.input.SecretId, "secret-id");
      return {
        SecretString: JSON.stringify({
          DB_HOST: "db.example.test",
          DB_PORT: 3306,
          EXPORT_BUCKET: "from-secret",
        }),
      };
    },
  };

  const loaded = await loadSecretEnv({
    env: {
      CONFIG_SECRET_ID: "secret-id",
      EXPORT_BUCKET: "from-cdk",
    },
    secretsClient,
  });

  assert.equal(loaded.DB_HOST, "db.example.test");
  assert.equal(loaded.DB_PORT, "3306");
  assert.equal(loaded.EXPORT_BUCKET, "from-cdk");
});

test("parseOicResponse returns successful and failed tax IDs", () => {
  const parsed = parseOicResponse({
    saveResultList: [
      { taxIdCode: "OK1", success: true },
      { taxIdCode: "OK2", success: "true" },
      { taxIdCode: "KO1", success: false },
      { taxIdCode: "KO2", success: "false" },
      { taxIdCode: "KO3" },
    ],
  });

  assert.deepEqual(parsed.successfulTaxIds, ["OK1", "OK2"]);
  assert.deepEqual(parsed.failedTaxIds, ["KO1", "KO2", "KO3"]);
});

test("parseOicResponse rejects missing saveResultList", () => {
  assert.throws(() => parseOicResponse({}), /saveResultList/);
});

test("prepareSql replaces only the company variable default value", () => {
  const rawQuery = [
    "SET @company_id = 189;",
    "SELECT * FROM offices WHERE company_id = @company_id;",
  ].join("\n");

  const sql = prepareSql(rawQuery, "132");

  assert.match(sql, /^SET @company_id = 132;/);
  assert.match(sql, /company_id = @company_id/);
  assert.doesNotMatch(sql, /SET 132 = 132/);
});

test("rowsToCsv writes headers and escapes CSV values", () => {
  const csv = rowsToCsv([
    { name: "Mario", note: "comma, quote \" and\nnewline" },
    { name: "Anna", note: null },
  ]);

  assert.equal(
    csv,
    'name,note\nMario,"comma, quote "" and\nnewline"\nAnna,'
  );
});

test("mapRowsToEmployees sends dash when prescriptions are blank", () => {
  const mapped = mapRowsToEmployees([
    { ...rows[0], prescriptions: "" },
    { ...rows[0], prescriptions: null },
    { ...rows[0], prescriptions: "   " },
    { ...rows[0], prescriptions: "Limitazione carichi" },
  ]);

  assert.deepEqual(
    mapped.map((row) => row.prescriptionsLimitations),
    ["-", "-", "-", "Limitazione carichi"]
  );
});

test("computeHybridSnapshotRows keeps failed sent rows pending", () => {
  const previousRows = [{ fiscal_code: "OLD", _hash: "old-hash" }];
  const sentRowsWithHash = [
    { fiscal_code: "OK1", _hash: "ok-hash" },
    { fiscal_code: "KO1", _hash: "ko-hash" },
  ];
  const processed = computeHybridSnapshotRows({
    previousRows,
    currentRowsWithHash: previousRows.concat(sentRowsWithHash),
    sentRowsWithHash,
    successfulTaxIds: ["OK1"],
  });

  assert.deepEqual(
    processed.map((row) => row.fiscal_code),
    ["OLD", "OK1"]
  );
});

test("dry run builds and logs the OIC request without calling OIC or writing state", async () => {
  const dynamoClient = fakeDynamoClient();
  const s3Client = fakeS3Client();
  const logger = createCaptureLogger();
  let fetchCalled = false;

  const result = await runSync({
    event: { dryRun: true, executionId: "test-execution" },
    env,
    dynamoClient,
    s3Client,
    queryRowsImpl: async () => rows,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
    logger,
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.equal(fetchCalled, false);
  const dryRunLog = logger.entries.find(
    (entry) => entry.event === "dry_run_oic_request"
  );
  assert.equal(dryRunLog.request.headers.Authorization, "Basic <redacted>");
  assert.deepEqual(dryRunLog.payload, result.oicRequest.body);
  assert.deepEqual(
    dynamoClient.calls.map((call) => call.constructor.name),
    ["GetItemCommand"]
  );
  assert.deepEqual(
    s3Client.calls.map((call) => call.constructor.name),
    ["PutObjectCommand"]
  );
  assert.match(result.fullExportCsvKey, /^exports\/.+-test-execution\.csv$/);
  assert.equal(s3Client.calls[0].input.Key, result.fullExportCsvKey);
  assert.equal(s3Client.calls[0].input.ContentType, "text/csv; charset=utf-8");
});

test("full OIC success writes snapshot and DynamoDB state", async () => {
  const dynamoClient = fakeDynamoClient();
  const s3Client = fakeS3Client();

  const result = await runSync({
    event: { executionId: "test-execution" },
    env: { ...env, OIC_USERNAME: "u", OIC_PASSWORD: "p" },
    dynamoClient,
    s3Client,
    queryRowsImpl: async () => rows,
    logger: silentLogger,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          saveResultList: rows.map((row) => ({
            taxIdCode: row.fiscal_code,
            success: true,
          })),
        }),
    }),
  });

  assert.equal(result.status, "success");
  assert.equal(result.success, true);
  assert.deepEqual(result.failedTaxIds, []);
  assert.deepEqual(
    s3Client.calls.map((call) => call.constructor.name),
    ["PutObjectCommand", "PutObjectCommand"]
  );
  const fullExportPut = s3Client.calls[0].input;
  assert.match(fullExportPut.Key, /^exports\/.+-test-execution\.csv$/);
  assert.equal(fullExportPut.ContentType, "text/csv; charset=utf-8");
  assert.match(fullExportPut.Body, /first_name,last_name/);
  assert.deepEqual(
    dynamoClient.calls.map((call) => call.constructor.name),
    ["GetItemCommand", "PutItemCommand"]
  );
});

test("partial OIC success reports failed tax IDs", async () => {
  const dynamoClient = fakeDynamoClient();
  const s3Client = fakeS3Client();

  const result = await runSync({
    event: { executionId: "test-execution" },
    env: { ...env, OIC_USERNAME: "u", OIC_PASSWORD: "p" },
    dynamoClient,
    s3Client,
    queryRowsImpl: async () => rows,
    logger: silentLogger,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          saveResultList: [
            { taxIdCode: rows[0].fiscal_code, success: true },
            { taxIdCode: rows[1].fiscal_code, success: false },
          ],
        }),
    }),
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.success, false);
  assert.deepEqual(result.failedTaxIds, [rows[1].fiscal_code]);
});

test("OIC HTTP failure advances nothing", async () => {
  const dynamoClient = fakeDynamoClient();
  const s3Client = fakeS3Client();

  await assert.rejects(
    runSync({
      event: { executionId: "test-execution" },
      env: { ...env, OIC_USERNAME: "u", OIC_PASSWORD: "p" },
      dynamoClient,
      s3Client,
      queryRowsImpl: async () => rows,
      logger: silentLogger,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => "failure",
      }),
    }),
    /HTTP 500/
  );

  assert.deepEqual(
    s3Client.calls.map((call) => call.constructor.name),
    ["PutObjectCommand"]
  );
  assert.match(s3Client.calls[0].input.Key, /^exports\/.+-test-execution\.csv$/);
  assert.deepEqual(
    dynamoClient.calls.map((call) => call.constructor.name),
    ["GetItemCommand"]
  );
});

test("missing OIC saveResultList advances nothing", async () => {
  const dynamoClient = fakeDynamoClient();
  const s3Client = fakeS3Client();

  await assert.rejects(
    runSync({
      event: { executionId: "test-execution" },
      env: { ...env, OIC_USERNAME: "u", OIC_PASSWORD: "p" },
      dynamoClient,
      s3Client,
      queryRowsImpl: async () => rows,
      logger: silentLogger,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ unexpected: true }),
      }),
    }),
    /saveResultList/
  );

  assert.deepEqual(
    s3Client.calls.map((call) => call.constructor.name),
    ["PutObjectCommand"]
  );
  assert.match(s3Client.calls[0].input.Key, /^exports\/.+-test-execution\.csv$/);
  assert.deepEqual(
    dynamoClient.calls.map((call) => call.constructor.name),
    ["GetItemCommand"]
  );
});

test("no changed rows skips OIC and records no_changes", async () => {
  const previousRows = addHashes(rows);
  const dynamoClient = fakeDynamoClient({ currentVersion: "v1" });
  const s3Client = fakeS3Client(previousRows);

  const result = await runSync({
    event: { executionId: "test-execution" },
    env: { ...env, OIC_USERNAME: "u", OIC_PASSWORD: "p" },
    dynamoClient,
    s3Client,
    queryRowsImpl: async () =>
      previousRows.map(({ _hash, ...row }) => row),
    logger: silentLogger,
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.status, "no_changes");
  assert.equal(result.count, 0);
  assert.match(result.fullExportCsvKey, /^exports\/.+-test-execution\.csv$/);
  assert.deepEqual(
    dynamoClient.calls.map((call) => call.constructor.name),
    ["GetItemCommand", "PutItemCommand"]
  );
});
