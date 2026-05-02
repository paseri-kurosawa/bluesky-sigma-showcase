import * as cdk from 'aws-cdk-lib';
import { BlueskySigmaStack } from './bluesky_sigma_stack';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT || '878311109818';

new BlueskySigmaStack(app, 'BlueskySigmaStack', {
  env: { account, region: 'ap-northeast-1' },
});
