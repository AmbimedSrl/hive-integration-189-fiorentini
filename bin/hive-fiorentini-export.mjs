#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { deploymentConfig } from "../lib/deployment-config.mjs";
import { HiveFiorentiniExportStack } from "../lib/hive-fiorentini-export-stack.mjs";

const app = new cdk.App();
const region = app.node.tryGetContext("region") ?? deploymentConfig.region;

new HiveFiorentiniExportStack(app, "HiveFiorentiniExportStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});
