import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deploymentConfig } from "./deployment-config.mjs";

const LAMBDA_ASSET_FILES = [
  "index.mjs",
  "query.sql",
  "package.json",
  "pnpm-lock.yaml",
];

function installProductionDependencies(directory) {
  execSync(
    "pnpm install --prod --frozen-lockfile --ignore-workspace --config.node-linker=hoisted --ignore-scripts",
    {
      cwd: directory,
      env: { ...process.env, CI: "true" },
      stdio: "inherit",
    }
  );
}

function copyLambdaSources(directory) {
  for (const file of LAMBDA_ASSET_FILES) {
    cpSync(file, join(directory, file));
  }
}

function contextStringList(scope, key, fallback = []) {
  const value = scope.node.tryGetContext(key);
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export class HiveFiorentiniExportStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const configSecretName =
      this.node.tryGetContext("configSecretName") ??
      deploymentConfig.configSecretName;
    const functionName =
      this.node.tryGetContext("functionName") ?? deploymentConfig.functionName;
    const vpcId = this.node.tryGetContext("vpcId") ?? deploymentConfig.vpc.id;
    const availabilityZones = contextStringList(
      this,
      "availabilityZones",
      deploymentConfig.vpc.availabilityZones
    );
    const subnetIds = contextStringList(
      this,
      "subnetIds",
      deploymentConfig.vpc.subnetIds
    );
    const securityGroupIds = contextStringList(
      this,
      "securityGroupIds",
      deploymentConfig.vpc.securityGroupIds
    );
    const scheduleExpression =
      this.node.tryGetContext("scheduleExpression") ??
      deploymentConfig.schedule.expression;
    const scheduleTimeZone =
      this.node.tryGetContext("scheduleTimeZone") ??
      deploymentConfig.schedule.timeZone;

    const configSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "ConfigSecret",
      configSecretName
    );

    const exportBucket = new s3.Bucket(this, "ExportBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const syncStateTable = new dynamodb.Table(this, "SyncStateTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: "pk",
        type: dynamodb.AttributeType.STRING,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vpc =
      vpcId && subnetIds.length > 0
        ? ec2.Vpc.fromVpcAttributes(this, "Vpc", {
            vpcId,
            availabilityZones,
            privateSubnetIds: subnetIds,
          })
        : undefined;
    const securityGroups = securityGroupIds.map((securityGroupId, index) =>
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        `LambdaSecurityGroup${index + 1}`,
        securityGroupId
      )
    );
    const importedSubnets = subnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `LambdaSubnet${index + 1}`, subnetId)
    );

    const logGroup = new logs.LogGroup(this, "ExportFunctionLogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const exportFunction = new lambda.Function(this, "ExportFunction", {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(".", {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "cp index.mjs query.sql package.json pnpm-lock.yaml /asset-output/",
              "cd /asset-output",
              "corepack enable",
              "CI=true pnpm install --prod --frozen-lockfile --ignore-workspace --config.node-linker=hoisted --ignore-scripts",
            ].join(" && "),
          ],
          local: {
            tryBundle(outputDir) {
              const stagingDir = mkdtempSync(join(tmpdir(), "hive-fiorentini-lambda-"));
              try {
                copyLambdaSources(stagingDir);
                installProductionDependencies(stagingDir);
                for (const entry of readdirSync(stagingDir)) {
                  cpSync(join(stagingDir, entry), join(outputDir, entry), {
                    recursive: true,
                  });
                }
              } finally {
                rmSync(stagingDir, { recursive: true, force: true });
              }
              return true;
            },
          },
        },
      }),
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        CONFIG_SECRET_ID: configSecret.secretName,
        EXPORT_BUCKET: exportBucket.bucketName,
        SYNC_STATE_TABLE: syncStateTable.tableName,
      },
      ...(vpc ? { vpc } : {}),
      ...(vpc && importedSubnets.length > 0
        ? { vpcSubnets: { subnets: importedSubnets } }
        : {}),
      ...(securityGroups.length > 0 ? { securityGroups } : {}),
    });

    configSecret.grantRead(exportFunction);
    exportBucket.grantReadWrite(exportFunction);
    syncStateTable.grantReadWriteData(exportFunction);
    exportFunction.node.addDependency(logGroup);

    const schedule = new scheduler.Schedule(this, "DailyExportSchedule", {
      schedule: scheduler.ScheduleExpression.expression(
        scheduleExpression,
        cdk.TimeZone.of(scheduleTimeZone)
      ),
      target: new schedulerTargets.LambdaInvoke(exportFunction),
    });

    new cdk.CfnOutput(this, "FunctionName", {
      value: exportFunction.functionName,
    });
    new cdk.CfnOutput(this, "ScheduleName", {
      value: schedule.scheduleName,
    });
    new cdk.CfnOutput(this, "ConfigSecretName", {
      value: configSecretName,
    });
    new cdk.CfnOutput(this, "ExportBucketName", {
      value: exportBucket.bucketName,
    });
    new cdk.CfnOutput(this, "SyncStateTableName", {
      value: syncStateTable.tableName,
    });
  }
}
