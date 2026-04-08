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

export class BlueskySigmaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // === S3 Bucket for Graph Data ===
    const graphDataBucket = new s3.Bucket(this, 'GraphDataBucket', {
      bucketName: `bluesky-sigma-showcase-${cdk.Aws.ACCOUNT_ID}`,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // === S3 Bucket for Frontend ===
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `bluesky-sigma-frontend-${cdk.Aws.ACCOUNT_ID}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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

    // === Lambda Layer (Dependencies) ===
    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/layers/dependencies')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Python dependencies for graph crawler',
    });

    // === Lambda: Graph Crawler ===
    const graphCrawlerLambda = new lambda.Function(this, 'GraphCrawlerLambda', {
      functionName: 'bluesky-sigma-graph-crawler',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/handlers/graph_crawler')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      layers: [dependenciesLayer],
      logRetention: logs.RetentionDays.THIRTY,
    });

    // === Lambda: API Endpoint ===
    const graphApiLambda = new lambda.Function(this, 'GraphApiLambda', {
      functionName: 'bluesky-sigma-graph-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/handlers/graph_api')),
      role: lambdaExecutionRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        S3_BUCKET: graphDataBucket.bucketName,
        S3_PREFIX: 'sigma-graph/',
      },
      layers: [dependenciesLayer],
      logRetention: logs.RetentionDays.THIRTY,
    });

    // === API Gateway ===
    const api = new apigateway.RestApi(this, 'GraphApi', {
      restApiName: 'bluesky-sigma-graph-api',
      description: 'API for fetching graph data',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // /api/graph/latest
    const graphResource = api.root.addResource('api').addResource('graph');
    const latestResource = graphResource.addResource('latest');
    latestResource.addMethod('GET', new apigateway.LambdaIntegration(graphApiLambda));

    // /api/graph/{hashtag}/latest
    const hashtagResource = graphResource.addResource('{hashtag}');
    const hashtagLatestResource = hashtagResource.addResource('latest');
    hashtagLatestResource.addMethod('GET', new apigateway.LambdaIntegration(graphApiLambda));

    // === EventBridge Rule (Daily Schedule) ===
    const crawlerRule = new events.Rule(this, 'DailyGraphCrawlerRule', {
      schedule: events.Schedule.cron({
        hour: '0',        // 00:00 UTC (09:00 JST)
        minute: '0',
      }),
      description: 'Daily graph crawler execution at 00:00 UTC',
    });

    crawlerRule.addTarget(new targets.LambdaFunction(graphCrawlerLambda));

    // === CloudFront Distribution (Frontend) ===
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
