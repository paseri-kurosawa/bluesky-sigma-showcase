import os
import json
import boto3
import re
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

# AWS Clients
s3_client = boto3.client('s3')

# JST timezone
JST = timezone(timedelta(hours=9))

# === Configuration ===
S3_BUCKET = os.environ.get('S3_BUCKET', 'bluesky-sigma-showcase-878311109818')
S3_PREFIX = os.environ.get('S3_PREFIX', 'sigma-graph/')

# Allowed hashtags (whitelist)
ALLOWED_HASHTAGS = ["おはようvtuber", "青空ごはん部", "イラスト", "統合"]


# === Helper Functions ===
def get_jst_now():
    """Get current time in JST"""
    return datetime.now(JST)


def build_response(status_code: int, body: Dict) -> Dict:
    """Build API response with CORS headers"""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
        "body": json.dumps(body, ensure_ascii=False)
    }


def get_graph_from_s3(s3_key: str) -> Optional[Dict]:
    """
    Fetch graph JSON from S3.

    Args:
        s3_key: S3 object key

    Returns:
        Graph JSON dict or None if not found
    """
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
        body = response['Body'].read().decode('utf-8')
        return json.loads(body)
    except s3_client.exceptions.NoSuchKey:
        print(f"[S3] Key not found: {s3_key}")
        return None
    except Exception as e:
        print(f"[S3 ERROR] Failed to fetch {s3_key}: {str(e)}")
        return None


def list_hashtags() -> list:
    """
    List all available hashtags in S3.

    Returns:
        List of hashtag names
    """
    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(
            Bucket=S3_BUCKET,
            Prefix=S3_PREFIX,
            Delimiter='/'
        )

        hashtags = []
        for page in pages:
            if 'CommonPrefixes' in page:
                for prefix in page['CommonPrefixes']:
                    # Extract hashtag from prefix (e.g., "sigma-graph/おはようvtuber/" -> "おはようvtuber")
                    hashtag = prefix['Prefix'].replace(S3_PREFIX, '').rstrip('/')
                    if hashtag:
                        hashtags.append(hashtag)

        return sorted(hashtags)
    except Exception as e:
        print(f"[S3 ERROR] Failed to list hashtags: {str(e)}")
        return []


# === API Handlers ===
def handle_get_latest(path_parameters: Optional[Dict]) -> Dict:
    """
    Handle GET /api/graph/latest or GET /api/graph/{hashtag}/latest

    Args:
        path_parameters: Path parameters from API Gateway

    Returns:
        API response
    """
    try:
        if not path_parameters or 'hashtag' not in path_parameters:
            # No hashtag specified - return first available hashtag's latest graph
            hashtags = list_hashtags()
            if not hashtags:
                return build_response(404, {
                    "error": "No graph data available",
                    "message": "No hashtag graphs have been generated yet"
                })

            hashtag = hashtags[0]
            print(f"[API] No hashtag specified, using first available: {hashtag}")
        else:
            hashtag = path_parameters['hashtag']
            # URL decode if necessary
            import urllib.parse
            hashtag = urllib.parse.unquote(hashtag)

            # Validate hashtag (whitelist)
            if hashtag not in ALLOWED_HASHTAGS:
                return build_response(404, {
                    "error": "Hashtag not found",
                    "hashtag": hashtag
                })

        # Fetch accumulated merged graph (蓄積されたユーザー情報を使用)
        # Special case: unified graph is stored at /統合/graph.json instead of /統合/users_merged.json
        if hashtag == "統合":
            s3_key = f"{S3_PREFIX}{hashtag}/graph.json"
        else:
            s3_key = f"{S3_PREFIX}{hashtag}/users_merged.json"
        graph = get_graph_from_s3(s3_key)

        if not graph:
            return build_response(404, {
                "error": "Graph not found",
                "hashtag": hashtag,
                "message": f"No graph data found for #{hashtag}"
            })

        print(f"[API] Successfully fetched latest graph for #{hashtag}")
        return build_response(200, graph)

    except Exception as e:
        print(f"[API ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return build_response(500, {
            "error": "Internal server error",
            "message": str(e)
        })


def handle_list_hashtags() -> Dict:
    """
    Handle GET /api/hashtags or /api/graph/list

    Returns:
        List of available hashtags
    """
    try:
        hashtags = list_hashtags()
        print(f"[API] Listed {len(hashtags)} hashtags")
        return build_response(200, {
            "hashtags": hashtags,
            "count": len(hashtags)
        })
    except Exception as e:
        print(f"[API ERROR] {str(e)}")
        return build_response(500, {
            "error": "Internal server error",
            "message": str(e)
        })


def handle_options() -> Dict:
    """Handle CORS preflight request"""
    return {
        "statusCode": 200,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
        "body": ""
    }


# === Main Lambda Handler ===
def lambda_handler(event, context):
    """
    Main Lambda handler for graph API.

    Routes:
    - GET /api/graph/latest → Latest graph (first available hashtag)
    - GET /api/graph/{hashtag}/latest → Latest graph for specific hashtag
    - GET /api/hashtags → List all available hashtags
    - OPTIONS /* → CORS preflight
    """
    print(f"[HANDLER] Event: {json.dumps(event)}")

    try:
        http_method = event.get('httpMethod', 'GET')
        path = event.get('path', '/')
        path_parameters = event.get('pathParameters')

        # Handle CORS preflight
        if http_method == 'OPTIONS':
            return handle_options()

        # Handle GET requests
        if http_method == 'GET':
            # Route: /api/graph/latest or /api/graph/{hashtag}/latest
            if 'graph' in path and 'latest' in path:
                return handle_get_latest(path_parameters)

            # Route: /api/hashtags
            elif 'hashtags' in path:
                return handle_list_hashtags()

            # Default: list hashtags
            else:
                return handle_list_hashtags()

        # Method not allowed
        return build_response(405, {
            "error": "Method not allowed",
            "method": http_method
        })

    except Exception as e:
        print(f"[HANDLER ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return build_response(500, {
            "error": "Internal server error",
            "message": str(e)
        })
