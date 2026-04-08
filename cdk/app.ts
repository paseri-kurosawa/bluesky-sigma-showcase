#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BlueskySigmaStack } from './lib/bluesky_sigma_stack';

const app = new cdk.App();

new BlueskySigmaStack(app, 'BlueskySigmaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
  description: 'Bluesky Sigma Showcase - Graph Visualization',
});

app.synth();
