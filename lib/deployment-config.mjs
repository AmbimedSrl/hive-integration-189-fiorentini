export const deploymentConfig = {
  region: "eu-west-1",
  functionName: "hive-fiorentini-export",
  configSecretName: "hive-fiorentini-export/env",
  schedule: {
    expression: "cron(0 4 * * ? *)",
    timeZone: "Europe/Rome",
  },
  vpc: {
    id: "vpc-0da2c293344b8f7da",
    availabilityZones: ["eu-west-1a", "eu-west-1b"],
    subnetIds: [
      "subnet-0385f0c461ae63d5d",
      "subnet-0831dc8a9d6ba53ce",
    ],
    securityGroupIds: [
      "sg-06720ff23f3da5aa7",
      "sg-0615b1c6ba718f5a2",
      "sg-0b252bd6c6bfbf81c",
    ],
  },
};
