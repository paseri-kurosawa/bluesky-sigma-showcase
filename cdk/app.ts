#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BlueskySigmaStack } from './lib/bluesky_sigma_stack';

const app = new cdk.App();

// Force ap-northeast-1 region (東京リージョン固定)
const region = 'ap-northeast-1';
const account = process.env.CDK_DEFAULT_ACCOUNT || '878311109818';

new BlueskySigmaStack(app, 'BlueskySigmaStack', {
  env: {
    account: account,
    region: region,
  },
  description: 'Bluesky Sigma Showcase - Graph Visualization',
});

app.synth();
