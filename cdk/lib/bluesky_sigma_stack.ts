import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

// S3BucketOrigin のインポート
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

export class BlueskySigmaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // === S3 Bucket for Graph Data (Import existing bucket) ===
    const graphDataBucket = s3.Bucket.fromBucketName(
      this,
      'GraphDataBucket',
      `bluesky-sigma-showcase-${cdk.Aws.ACCOUNT_ID}`
    );

    // === S3 Bucket for Frontend (Import existing bucket) ===
    const frontendBucket = s3.Bucket.fromBucketName(
      this,
      'FrontendBucket',
      `bluesky-sigma-frontend-${cdk.Aws.ACCOUNT_ID}`
    );

    // === Lambda Execution Role ===
    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Permissions: S3
    graphDataBucket.grantReadWrite(lambdaExecutionRole);
    frontendBucket.grantRead(lambdaExecutionRole);

    // Permissions: CloudWatch Logs
    lambdaExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Permissions: Secrets Manager
    lambdaExecutionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:bluesky-feed-jp/credentials-*`,
        ],
      })
    );

    // === Lambda Layer (Dependencies) ===
    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/layers/dependencies')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Python dependencies for graph crawler',
    });

    // === Lambda Layer (Fonts) ===
    const fontsLayer = new lambda.LayerVersion(this, 'FontsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/layers/fonts')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Noto Sans JP font for image generation',
    });

    // === Lambda: Graph Crawler ===
    const graphCrawlerLambda = new lambda.Function(this, 'GraphCrawlerLambda', {
      functionName: 'bluesky-sigma-graph-crawler',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/handlers/graph_crawler')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      layers: [dependenciesLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // === Lambda: Scheduler ===
    const schedulerLambda = new lambda.Function(this, 'SchedulerLambda', {
      functionName: 'bluesky-sigma-scheduler',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/handlers/scheduler')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Permissions: Allow Scheduler to invoke Graph Crawler
    schedulerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:bluesky-sigma-graph-crawler`,
        ],
      })
    );

    // === Lambda: API Endpoint (Docker Image with Chromium) ===
    const graphApiLambda = new lambda.DockerImageFunction(this, 'GraphApiLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../lambda/handlers/graph_api')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.minutes(5),  // Extended for Chromium startup (Puppeteer rendering takes time)
      memorySize: 3008,  // 3GB for Chromium + image processing
      reservedConcurrentExecutions: 10,
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // === API Gateway ===
    const api = new apigateway.RestApi(this, 'GraphApi', {
      restApiName: 'bluesky-sigma-graph-api',
      description: 'API for fetching graph data',
      binaryMediaTypes: ['image/png'],  // Support binary PNG images
      defaultCorsPreflightOptions: {
        allowOrigins: [
          'https://d1g3djqpjf3j38.cloudfront.net',  // Production CloudFront domain
          'http://localhost:3000',                   // Development
          'http://localhost:5173',                   // Vite dev server
        ],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      },
    });

    // /api/hashtags
    const apiResource = api.root.addResource('api');
    const hashtagsResource = apiResource.addResource('hashtags');
    hashtagsResource.addMethod('GET', new apigateway.LambdaIntegration(graphApiLambda));

    // /api/user/{handle}/top-post and /api/user/{handle}/share-image
    const userResource = apiResource.addResource('user');
    const handleResource = userResource.addResource('{handle}');
    const topPostResource = handleResource.addResource('top-post');
    topPostResource.addMethod('GET', new apigateway.LambdaIntegration(graphApiLambda));
    const shareImageResource = handleResource.addResource('share-image');
    shareImageResource.addMethod('GET', new apigateway.LambdaIntegration(graphApiLambda));

    // === EventBridge Rule (Hourly Schedule) ===
    const crawlerRule = new events.Rule(this, 'HourlyGraphCrawlerRule', {
      schedule: events.Schedule.cron({
        minute: '0',
      }),
      description: 'Hourly graph crawler execution at every hour',
    });

    crawlerRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // === CloudFront Distribution (Frontend) ===
    const oai = new cloudfront.OriginAccessIdentity(this, 'FrontendOAI', {
      comment: 'OAI for frontend bucket access',
    });
    frontendBucket.grantRead(oai);

    // === OAI for Graph Data Bucket ===
    const graphDataOai = new cloudfront.OriginAccessIdentity(this, 'GraphDataOAI', {
      comment: 'OAI for graph data bucket access',
    });
    // Note: grantRead may not work on imported buckets, so we add explicit bucket policy
    graphDataBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.CanonicalUserPrincipal(graphDataOai.canonic​alUserId)],
        actions: ['s3:GetObject'],
        resources: [graphDataBucket.arnForObjects('*')],
      })
    );

    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(frontendBucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/sigma-graph/*': {
          origin: S3BucketOrigin.withOriginAccessIdentity(graphDataBucket, {
            originAccessIdentity: graphDataOai,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // === Outputs ===
    new cdk.CfnOutput(this, 'GraphDataBucketName', {
      value: graphDataBucket.bucketName,
      description: 'S3 bucket for graph data',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      description: 'S3 bucket for frontend',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain',
    });

    new cdk.CfnOutput(this, 'SchedulerLambdaName', {
      value: schedulerLambda.functionName,
      description: 'Scheduler Lambda function name',
    });

    new cdk.CfnOutput(this, 'GraphCrawlerLambdaName', {
      value: graphCrawlerLambda.functionName,
      description: 'Graph crawler Lambda function name',
    });

    new cdk.CfnOutput(this, 'GraphApiLambdaName', {
      value: graphApiLambda.functionName,
      description: 'Graph API Lambda function name',
    });
  }
}
