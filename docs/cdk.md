# CDK deployment

The stack deploys the Lambda in `eu-west-1` with function name `hive-fiorentini-export`.
The default VPC configuration is stored in `lib/deployment-config.mjs`.

Create a Secrets Manager JSON secret named `hive-fiorentini-export/env` before deploying:

```json
{
  "DB_HOST": "your-rds-proxy-or-db-host",
  "DB_PORT": "3306",
  "DB_NAME": "your_database",
  "DB_USER": "your_database_user",
  "DB_PASS": "your_database_password",
  "COMPANY_ID": "189",
  "OIC_ENDPOINT": "https://example.com/ic/api/integration/v1/flows/rest/PF_PEOP_HIVE_SFDC_SYNC_EMPL_MEDI/1.0/",
  "OIC_USERNAME": "your_oic_username",
  "OIC_PASSWORD": "your_oic_password",
  "DRY_RUN": "false",
  "LOG_LEVEL": "info"
}
```

The stack creates the snapshot S3 bucket and DynamoDB sync-state table, then passes
their names to the function as `EXPORT_BUCKET` and `SYNC_STATE_TABLE`.
It also creates `/aws/lambda/hive-fiorentini-export` with 365-day CloudWatch
Logs retention.
The stack creates an EventBridge Scheduler schedule that invokes the Lambda
daily at 04:00 in the `Europe/Rome` timezone.

Runtime logging uses Pino structured JSON logs. Audit events include secret
load status, DynamoDB state reads/writes, snapshot reads/writes, DB query
counts, exact OIC payloads, OIC responses, and error details. Credentials and
authorization headers are redacted.

By default the Lambda is attached to:

- VPC: `vpc-0da2c293344b8f7da`
- Subnets: `subnet-0385f0c461ae63d5d`, `subnet-0831dc8a9d6ba53ce`
- Security groups: `sg-06720ff23f3da5aa7`, `sg-0615b1c6ba718f5a2`, `sg-0b252bd6c6bfbf81c`

To override the network configuration for a different deployment, pass these context values:

```bash
pnpm cdk deploy \
  -c vpcId=vpc-xxxxxxxx \
  -c availabilityZones=eu-west-1a,eu-west-1b \
  -c subnetIds=subnet-aaaa,subnet-bbbb \
  -c securityGroupIds=sg-xxxxxxxx
```

To use a different secret name:

```bash
pnpm cdk deploy -c configSecretName=my/secret/name
```
