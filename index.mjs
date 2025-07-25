#!/usr/bin/env node
/**
 * AWS Lambda (Node.js 22.x, ES-modules) that:
 *   1. Generates an IAM auth token through an RDS Proxy using @aws-sdk/rds-signer
 *   2. Executes the SQL contained in ../../query.sql against a MySQL/MariaDB database
 *   3. Sends the resulting rows as JSON via HTTP POST to the endpoint defined in `API_ENDPOINT`
 *
 * Environment variables expected by the function:
 *   DB_HOST        – RDS Proxy endpoint (hostname only)
 *   DB_PORT        – TCP port, default `3306`
 *   DB_NAME        – Database name
 *   DB_USER        – Database user mapped to IAM role
 *   API_ENDPOINT   – HTTPS URL that will receive the results
 *   COMPANY_ID     – Value injected into the `@company_id` SQL variable inside query.sql
 *   AWS_REGION     – Provided automatically by Lambda, required by the signer
 *
 * Type annotations are provided via JSDoc so they work in plain JavaScript too.
 */

import { Signer } from "@aws-sdk/rds-signer";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import mysql from "mysql2/promise";
import fs from "node:fs/promises";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────────
// Maximum number of changed rows returned per invocation.
// Adjust here to change the window size everywhere consistently.
const CHANGESET_MAX_SIZE = 20;

// ────────────────────────────────────────────────────────────────────────────────
// Read the SQL file once at cold-start and keep it cached.
// Using URL keeps it working when the file is bundled.
/** @type {Promise<string>} */
const rawQueryPromise = fs.readFile(
  new URL("./query.sql", import.meta.url),
  "utf8"
);

/**
 * Build an auth token for RDS IAM authentication.
 *
 * @param {object} opts
 * @param {string} opts.host     – RDS Proxy host
 * @param {number} opts.port     – RDS Proxy port
 * @param {string} opts.username – Database user
 * @param {string} opts.region   – AWS region
 * @returns {Promise<string>}    – Signed auth token (use as the password)
 */
async function getAuthToken({ host, port, username, region }) {
  const credentials = await fromNodeProviderChain()();
  const signer = new Signer({
    hostname: host,
    port,
    username,
    region,
    credentials,
  });
  return await signer.getAuthToken();
}

// S3 client is expensive to create, reuse it between invocations.
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

/**
 * @typedef {import("mysql2/promise").RowDataPacket} RowDataPacket
 * @typedef {import("mysql2/promise").OkPacket}    OkPacket
 * @typedef {import("mysql2/promise").ResultSetHeader} ResultSetHeader
 *
 * @typedef {Record<string, unknown>} QueryRow – Shape of a single row returned by the query.
 */

/**
 * The Lambda entry point.
 *
 * @type {import("aws-lambda").Handler}
 */
export const handler = async (_event, _context) => {
  // Grab and validate env vars early – it helps with debugging.
  const {
    DB_HOST,
    DB_PORT = "3306",
    DB_NAME,
    DB_USER,
    DB_PASS,
    COMPANY_ID,
    EXPORT_BUCKET,
  } = process.env;

  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASS || !COMPANY_ID || !EXPORT_BUCKET) {
    throw new Error("Missing required environment variables.");
  }

  // Extract compareVersion from the event (direct or API Gateway payload).
  const compareVersion = _event.compareVersion ?? null;
  console.log("Invocation parameters", { compareVersion });

  // Build the IAM auth token.
  const password = await getAuthToken({
    host: DB_HOST,
    port: Number(DB_PORT),
    username: DB_USER,
    region: process.env.AWS_REGION ?? "eu-west-1",
  });

  console.log("Generated auth token.", { DB_USER });

  // Fetch and tailor the SQL string.
  const rawQuery = await rawQueryPromise;
  const sql = rawQuery.replace(/@company_id/gi, `${Number(COMPANY_ID)}`);

  /** @type {mysql.Connection} */
  let connection;
  try {
    // Establish the connection using the token as the password.
    connection = await mysql.createConnection({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      // ssl: {
      //   // Amazon Root CA trust – the MySQL client will fill in defaults when set to "Amazon RDS".
      //   rejectUnauthorized: true,
      // },
    });

    // Run the multi-statement script (setting variable + select).
    /** @type {[QueryRow[], RowDataPacket[] | OkPacket | ResultSetHeader]} */
    const [rows] = await connection.query(sql);
    console.log(`Fetched ${rows.length} rows from database starting from.`);

    // Enrich rows with a deterministic hash used for diffing.
    /** @type {(QueryRow & { _hash: string })[]} */
    const rowsWithHash = rows.map((row) => {
      const hash = createHash("sha1").update(JSON.stringify(row)).digest("hex");
      return { ...row, _hash: hash };
    });
    console.log(`Computed hashes for ${rowsWithHash.length} rows.`);

    // ── Handle comparison with previous version ───────────────────────────────
    let previousHashes = new Set();
    if (compareVersion) {
      try {
        const key = `${compareVersion}.json`;
        const getRes = await s3.send(
          new GetObjectCommand({ Bucket: EXPORT_BUCKET, Key: key })
        );
        console.log("Fetched previous version object from S3", {
          bucket: EXPORT_BUCKET,
          key,
          contentLength: getRes.ContentLength,
          bodyType: typeof getRes.Body,
        });

        // Convert Body to buffer then string
        let bodyBuffer;
        if (Buffer.isBuffer(getRes.Body)) {
          bodyBuffer = getRes.Body;
        } else {
          const chunks = [];
          for await (const chunk of getRes.Body) chunks.push(chunk);
          bodyBuffer = Buffer.concat(chunks);
        }

        const bodyString = bodyBuffer.toString("utf-8");
        const { rows: prevRows = [] } = JSON.parse(bodyString);
        previousHashes = new Set(prevRows.map((r) => r._hash));
        console.log(
          `Loaded ${previousHashes.size} hashes from previous version ${compareVersion}`
        );
      } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          console.log(`Previous version ${compareVersion} not found – returning all rows.`);
        } else {
          console.error("Error retrieving previous version from S3:", err);
          // Still continue – treat as no previous data.
        }
      }
    }

    const allChangedRowsWithHash = previousHashes.size
      ? rowsWithHash.filter((row) => !previousHashes.has(row._hash))
      : rowsWithHash;

    const totalRows = rowsWithHash.length;
    const totalChangedRows = allChangedRowsWithHash.length;

    console.log("Diff statistics before limit", {
      previousHashes: previousHashes.size,
      totalCurrent: totalRows,
      changedOrNew: totalChangedRows,
    });

    // Limit to at most CHANGESET_MAX_SIZE rows to act as a cursor window.
    const changedRowsWithHash = allChangedRowsWithHash.slice(0, CHANGESET_MAX_SIZE);

    console.log(`After applying ${CHANGESET_MAX_SIZE}-row limit`, {
      willReturn: changedRowsWithHash.length,
    });

    // Strip hash before returning to the caller.
    const changedRows = changedRowsWithHash.map(({ _hash, ...rest }) => rest);

    // ── Persist current version to S3 for future comparisons ──────────────────
    if (changedRowsWithHash.length > 0) {
      const currentVersion = new Date().toISOString();
      const putKey = `${currentVersion}.json`;
      const putRes = await s3.send(
        new PutObjectCommand({
          Bucket: EXPORT_BUCKET,
          Key: putKey,
          Body: JSON.stringify({ version: currentVersion, rows: changedRowsWithHash }),
          ContentType: "application/json",
        })
      );
      console.log(`Stored current version at s3://${EXPORT_BUCKET}/${putKey}`, {
        etag: putRes.ETag,
      });

      // Directly return the changed rows as JSON.
      return {
        success: true,
        count: changedRows.length,
        currentVersion,
        comparedTo: compareVersion ?? null,
        totalRows,
        totalChangedRows,
        returnedRows: changedRows.length,
        limit: CHANGESET_MAX_SIZE,
        result: changedRows,
      };
    }

    // No new rows → nothing to store or return.
    console.log("No new rows after diff – returning empty result set.");
    return {
      success: true,
      count: 0,
      currentVersion: null,
      comparedTo: compareVersion ?? null,
      totalRows,
      totalChangedRows,
      returnedRows: 0,
      limit: CHANGESET_MAX_SIZE,
      result: [],
    };
  } catch (error) {
    console.error("Error fetching data:", error);
    return { result: [], success: false, count: 0, error: error.message };
  } finally {
    if (connection) await connection.end();
  }
};
