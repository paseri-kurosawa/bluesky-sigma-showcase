import os
import json
import time
import boto3

lambda_client = boto3.client('lambda')
s3_client = boto3.client('s3')
cloudfront_client = boto3.client('cloudfront')

# Environment variables
CLOUDFRONT_DISTRIBUTION_ID = os.environ.get('CLOUDFRONT_DISTRIBUTION_ID')
S3_BUCKET = os.environ.get('S3_BUCKET')
S3_STATUS_PREFIX = os.environ.get('S3_STATUS_PREFIX', 'crawler-status/')

# Categories configuration
CATEGORIES = {
    "unified_vtuber": [
        "おはようvtuber",
        "vtuber",
        "おはようvライバー",
        "新人vtuber",
        "vtuber準備中",
        "vtuber推し探しにどうぞ"
    ],
    "unified_illustration": [
        "イラスト",
        "aiイラスト",
        "illustration",
        "aiart",
        "aiillustration",
        "絵描きさんと繋がりたい"
    ],
    "unified_food": [
        "青空ごはん部",
        "自炊班",
        "外食班",
        "おうちごはん"
    ]
}


def check_completion_markers(timestamp: int, categories: list) -> bool:
    """
    Check if completion markers exist for all categories
    """
    try:
        for category in categories:
            marker_key = f"{S3_STATUS_PREFIX}{category}-{timestamp}.complete"
            try:
                s3_client.head_object(Bucket=S3_BUCKET, Key=marker_key)
            except Exception:
                # Marker not found (404) is normal during polling, not an error
                return False
        return True
    except Exception as e:
        print(f"[POLLING ERROR] Unexpected error: {str(e)}")
        return False


def delete_completion_markers(timestamp: int, categories: list):
    """
    Delete completion markers (cleanup)
    """
    for category in categories:
        marker_key = f"{S3_STATUS_PREFIX}{category}-{timestamp}.complete"
        try:
            s3_client.delete_object(Bucket=S3_BUCKET, Key=marker_key)
            print(f"[CLEANUP] Deleted marker: {marker_key}")
        except Exception as e:
            print(f"[CLEANUP ERROR] Failed to delete {marker_key}: {str(e)}")


def invalidate_cloudfront_cache():
    """
    Invalidate CloudFront cache for sigma-graph data
    """
    if not CLOUDFRONT_DISTRIBUTION_ID:
        print("[CLOUDFRONT] Warning: CLOUDFRONT_DISTRIBUTION_ID not set")
        return False

    try:
        print(f"[CLOUDFRONT] Creating invalidation for distribution {CLOUDFRONT_DISTRIBUTION_ID}...")

        response = cloudfront_client.create_invalidation(
            DistributionId=CLOUDFRONT_DISTRIBUTION_ID,
            InvalidationBatch={
                'Paths': {
                    'Quantity': 1,
                    'Items': ['/sigma-graph/*']
                },
                'CallerReference': f"scheduler-{int(time.time())}"
            }
        )

        invalidation_id = response['Invalidation']['Id']
        print(f"[CLOUDFRONT] Invalidation created: {invalidation_id}")
        return True

    except Exception as e:
        print(f"[CLOUDFRONT ERROR] Failed to create invalidation: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def lambda_handler(event, context):
    """
    Scheduler Lambda: invoke crawlers → wait for completion → invalidate CloudFront
    """
    print("[SCHEDULER] Starting category-based graph crawler jobs...")

    try:
        categories = CATEGORIES
        timestamp = int(time.time())

        if not categories:
            print("[SCHEDULER] No categories configured, skipping")
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "No categories configured"})
            }

        # === Step 1: Invoke all crawlers asynchronously ===
        invoked_count = 0
        failed_count = 0

        for category_name, hashtags in categories.items():
            try:
                print(f"[SCHEDULER] Invoking graph_crawler for category: {category_name}")

                payload = {
                    "category": category_name,
                    "hashtags": hashtags,
                    "timestamp": timestamp
                }

                response = lambda_client.invoke(
                    FunctionName='bluesky-sigma-graph-crawler',
                    InvocationType='Event',
                    Payload=json.dumps(payload)
                )

                print(f"[SCHEDULER] Successfully invoked for {category_name}: RequestId={response['ResponseMetadata']['RequestId']}")
                invoked_count += 1

            except Exception as e:
                print(f"[SCHEDULER ERROR] Failed to invoke for {category_name}: {str(e)}")
                failed_count += 1
                continue

        if invoked_count == 0:
            print("[SCHEDULER] No crawlers invoked, exiting")
            return {
                "statusCode": 500,
                "body": json.dumps({"error": "Failed to invoke any crawlers"})
            }

        print(f"[SCHEDULER] Invoked {invoked_count} crawlers, now waiting for completion...")

        # === Step 2: Poll for completion (max 13 minutes) ===
        max_wait_time = 13 * 60
        poll_interval = 10
        elapsed = 0

        while elapsed < max_wait_time:
            if check_completion_markers(timestamp, list(categories.keys())):
                print(f"[SCHEDULER] All crawlers completed after {elapsed}s")
                break

            time.sleep(poll_interval)
            elapsed += poll_interval

            if elapsed % 60 == 0:
                print(f"[SCHEDULER] Still waiting... ({elapsed}s elapsed)")
        else:
            print(f"[SCHEDULER] Timeout after {max_wait_time}s, some crawlers may still be running")

        # === Step 3: Invalidate CloudFront cache ===
        print("[SCHEDULER] Invalidating CloudFront cache...")
        invalidate_cloudfront_cache()

        # === Step 4: Cleanup completion markers ===
        delete_completion_markers(timestamp, list(categories.keys()))

        print(f"[SCHEDULER] Completed: {invoked_count} invoked, {failed_count} failed")

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Scheduler completed",
                "invoked": invoked_count,
                "failed": failed_count,
                "elapsed_seconds": elapsed
            })
        }

    except Exception as e:
        print(f"[SCHEDULER ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
