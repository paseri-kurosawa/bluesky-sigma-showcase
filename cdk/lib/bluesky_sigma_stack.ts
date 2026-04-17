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
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        CLOUDFRONT_DISTRIBUTION_ID: '',  // Set after distribution is created
        S3_BUCKET: graphDataBucket.bucketName,
        S3_STATUS_PREFIX: 'crawler-status/',
      },
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

    // Permissions: S3 for status markers
    graphDataBucket.grantReadWrite(schedulerLambda);

    // Permissions: CloudFront Cache Invalidation
    schedulerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/*`,
        ],
      })
    );

    // === Lambda: Top Post API (Lightweight) ===
    const topPostLambda = new lambda.Function(this, 'TopPostLambda', {
      functionName: 'bluesky-sigma-top-post',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/handlers/top_post_api')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: 10,  // Limit to 10 concurrent executions
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      layers: [dependenciesLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // === Lambda: Share Image API (Docker Image with Chromium) ===
    const shareImageLambda = new lambda.DockerImageFunction(this, 'ShareImageLambda', {
      functionName: 'bluesky-sigma-share-image',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../lambda/handlers/share_image_api')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,  // 2GB for Chromium + image processing
      reservedConcurrentExecutions: 10,  // Limit to 10 concurrent executions
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // === API Gateway ===
    const api = new apigateway.RestApi(this, 'UserApi', {
      restApiName: 'bluesky-sigma-user-api',
      description: 'API for user-specific operations',
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

    // /api/user/{handle}/top-post and /api/user/{handle}/share-image
    const apiResource = api.root.addResource('api');
    const userResource = apiResource.addResource('user');
    const handleResource = userResource.addResource('{handle}');
    const topPostResource = handleResource.addResource('top-post');
    topPostResource.addMethod('GET', new apigateway.LambdaIntegration(topPostLambda));
    const shareImageResource = handleResource.addResource('share-image');
    shareImageResource.addMethod('GET', new apigateway.LambdaIntegration(shareImageLambda));

    // === EventBridge Rule (Hourly Schedule) ===
    const crawlerRule = new events.Rule(this, 'HourlyGraphCrawlerRule', {
      schedule: events.Schedule.cron({
        minute: '0',
      }),
      description: 'Hourly graph crawler execution at every hour',
    });

    crawlerRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    // === CloudFront Origin Access Identities ===
    const frontendOai = new cloudfront.OriginAccessIdentity(this, 'FrontendOAI', {
      comment: 'OAI for frontend bucket access',
    });
    frontendBucket.grantRead(frontendOai);

    const graphDataOai = new cloudfront.OriginAccessIdentity(this, 'GraphDataOAI', {
      comment: 'OAI for graph data bucket access',
    });
    graphDataBucket.grantRead(graphDataOai);


    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(frontendBucket, {
          originAccessIdentity: frontendOai,
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
        '/api/*': {
          origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url)), {
            originPath: '/prod',
            readTimeout: cdk.Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
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

    // Set Scheduler environment variable with distribution ID
    schedulerLambda.addEnvironment('CLOUDFRONT_DISTRIBUTION_ID', distribution.distributionId);

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

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID for cache invalidation',
    });

    new cdk.CfnOutput(this, 'SchedulerLambdaName', {
      value: schedulerLambda.functionName,
      description: 'Scheduler Lambda function name',
    });

    new cdk.CfnOutput(this, 'GraphCrawlerLambdaName', {
      value: graphCrawlerLambda.functionName,
      description: 'Graph crawler Lambda function name',
    });

    new cdk.CfnOutput(this, 'TopPostLambdaName', {
      value: topPostLambda.functionName,
      description: 'Top post API Lambda function name',
    });

    new cdk.CfnOutput(this, 'ShareImageLambdaName', {
      value: shareImageLambda.functionName,
      description: 'Share image API Lambda function name',
    });
  }
}
