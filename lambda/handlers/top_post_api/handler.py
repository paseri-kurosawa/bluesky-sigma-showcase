import os
import json
import boto3
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional
from atproto import Client
from atproto_client.models.app.bsky.feed.search_posts import Params as SearchParams

# AWS Clients
secrets_client = boto3.client('secretsmanager')

# JST timezone
JST = timezone(timedelta(hours=9))


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


# === API Handlers ===
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
        query = f"lang:ja from:@{handle} -mentions"

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

        # Check if post has images
        has_images = False
        if hasattr(post, 'embed') and post.embed is not None:
            if hasattr(post.embed, 'images') and post.embed.images:
                has_images = True

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
            "hasImages": has_images,
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
    Main Lambda handler for top post API.

    Routes:
    - GET /api/user/{handle}/top-post → Top post for a user
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

            # Reject requests to other paths (should not reach Lambda)
            else:
                return build_response(404, {
                    "error": "Not found",
                    "path": path
                })

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
