import os
import json
import boto3
import re
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

# AWS Clients
s3_client = boto3.client('s3')
secrets_client = boto3.client('secretsmanager')

# AT Protocol Client
from atproto import Client
from atproto_client.models.app.bsky.feed.search_posts import Params as SearchParams

# JST timezone
JST = timezone(timedelta(hours=9))

# === Configuration ===
S3_BUCKET = os.environ.get('S3_BUCKET', 'bluesky-sigma-showcase-878311109818')
S3_PREFIX = os.environ.get('S3_PREFIX', 'sigma-graph/')

# Allowed hashtags (whitelist) - individual hashtags only
# Category-unified graphs (unified_*) are allowed dynamically
ALLOWED_HASHTAGS = ["おはようvtuber", "青空ごはん部", "イラスト"]


# === Helper Functions ===
def get_jst_now():
    """Get current time in JST"""
    return datetime.now(JST)


def get_bluesky_credentials() -> Optional[Dict]:
    """Get Bluesky credentials from Secrets Manager"""
    try:
        response = secrets_client.get_secret_value(
            SecretId='bluesky-feed-jp/credentials'
        )
        return json.loads(response['SecretString'])
    except Exception as e:
        print(f"[SECRETS] Failed to get credentials: {str(e)}")
        return None


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
    List all available hashtags in S3, filtered by whitelist.
    Returns only hashtags in ALLOWED_HASHTAGS or unified_* categories.

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
                        # Filter by whitelist: allowed individual hashtags or unified_* categories
                        if hashtag in ALLOWED_HASHTAGS or hashtag.startswith('unified_'):
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

            # Validate hashtag (whitelist) - allow individual hashtags or unified_* categories
            if hashtag not in ALLOWED_HASHTAGS and not hashtag.startswith('unified_'):
                return build_response(404, {
                    "error": "Hashtag not found",
                    "hashtag": hashtag
                })

        # Fetch accumulated merged graph (蓄積されたユーザー情報を使用)
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
    Returns whitelisted hashtags only (for header dropdown)

    Returns:
        List of available whitelisted hashtags
    """
    try:
        hashtags = list_hashtags()
        print(f"[API] Listed {len(hashtags)} whitelisted hashtags")
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


def handle_get_top_post(handle: str) -> Dict:
    """
    Handle GET /api/user/{handle}/top-post
    Fetches the top post for a user matching: lang:ja from:@{handle} sort:top limit:1

    Args:
        handle: Bluesky handle (without @)

    Returns:
        Top post data or error
    """
    try:
        # Initialize AT Protocol client
        client = Client()

        # Try to authenticate with credentials (optional)
        credentials = get_bluesky_credentials()
        if credentials:
            try:
                client.login(
                    login=credentials.get('handle'),
                    password=credentials.get('appPassword')
                )
                print(f"[API] Authenticated as {credentials.get('handle')}")
            except Exception as auth_err:
                print(f"[API] Could not authenticate: {str(auth_err)}")
                print("[API] Proceeding with unauthenticated client...")
        else:
            print("[API] No credentials found, proceeding with unauthenticated client...")

        # Build search query (exclude mentions)
        query = f"lang:ja from:{handle} -mentions"

        print(f"[API] Searching for top post: {query}")

        # Search for posts with sort parameter
        search_params = SearchParams(q=query, limit=1, sort='top')
        response = client.app.bsky.feed.search_posts(search_params)

        if not response.posts or len(response.posts) == 0:
            return build_response(404, {
                "error": "No posts found",
                "handle": handle,
                "message": f"No top posts found for @{handle}"
            })

        post = response.posts[0]

        # Filter out replies (posts with reply_parent)
        if hasattr(post.record, 'reply') and post.record.reply is not None:
            return build_response(404, {
                "error": "No posts found",
                "handle": handle,
                "message": f"No top posts found for @{handle}"
            })

        # Extract relevant post data
        post_data = {
            "uri": post.uri,
            "cid": post.cid,
            "author": {
                "handle": post.author.handle,
                "displayName": getattr(post.author, 'display_name', post.author.handle),
                "avatar": getattr(post.author, 'avatar', None),
            },
            "record": {
                "text": post.record.text,
                "createdAt": post.record.created_at if hasattr(post.record, 'created_at') else post.record.createdAt,
            },
            "likeCount": getattr(post, 'like_count', 0),
            "replyCount": getattr(post, 'reply_count', 0),
            "repostCount": getattr(post, 'repost_count', 0),
        }

        print(f"[API] Found top post for @{handle}")
        return build_response(200, post_data)

    except Exception as e:
        print(f"[API ERROR] Failed to fetch top post for @{handle}: {str(e)}")
        import traceback
        traceback.print_exc()
        return build_response(500, {
            "error": "Failed to fetch top post",
            "handle": handle,
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
    - GET /api/user/{handle}/top-post → Top post for a user
    - GET /api/hashtags → List whitelisted hashtags
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
            # Route: /api/user/{handle}/top-post
            if 'user' in path and 'top-post' in path:
                handle = path_parameters.get('handle') if path_parameters else None
                if not handle:
                    return build_response(400, {
                        "error": "Bad request",
                        "message": "handle parameter required"
                    })
                return handle_get_top_post(handle)

            # Route: /api/graph/latest or /api/graph/{hashtag}/latest
            elif 'graph' in path and 'latest' in path:
                return handle_get_latest(path_parameters)

            # Route: /api/hashtags (whitelisted list for header)
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
