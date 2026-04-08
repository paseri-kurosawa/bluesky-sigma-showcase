import os
import json
import time
import boto3
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from typing import List, Dict, Set, Tuple, Optional

# AT Protocol
from atproto import Client, client_utils
from atproto.models import AppBskyActorProfile

# AWS Clients
s3_client = boto3.client('s3')

# JST timezone
JST = timezone(timedelta(hours=9))

# === Configuration ===
def load_config():
    """Load configuration from config.json"""
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)

config = load_config()

# === Constants ===
TARGET_HASHTAGS = config.get("target_hashtags", ["おはようvtuber"])
USERS_PER_HASHTAG = config.get("crawler", {}).get("users_per_hashtag", 500)
RATE_LIMIT_PER_SECOND = config.get("crawler", {}).get("rate_limit_per_second", 5)
S3_BUCKET = config.get("storage", {}).get("s3_bucket", "bluesky-sigma-showcase")
S3_PREFIX = config.get("storage", {}).get("s3_prefix", "sigma-graph/")


# === Helper Functions ===
def get_jst_now():
    """Get current time in JST"""
    return datetime.now(JST)


def rate_limited_call(func, *args, **kwargs):
    """Rate-limited API call wrapper"""
    time.sleep(1.0 / RATE_LIMIT_PER_SECOND)
    return func(*args, **kwargs)


# === Step 1: Search for hashtag posts and extract DIDs ===
def search_hashtag_posts(client: Client, hashtag: str, limit: int = 100) -> List[str]:
    """
    Search for posts with specific hashtag and extract author DIDs.

    Args:
        client: AT Protocol client
        hashtag: Hashtag to search (e.g., "おはようvtuber")
        limit: Number of posts to retrieve

    Returns:
        List of unique DIDs
    """
    print(f"[SEARCH] Searching for #{hashtag} posts...")

    dids = set()
    try:
        # Search query: lang:ja #<hashtag>
        search_query = f"lang:ja #{hashtag}"
        print(f"[SEARCH] Query: {search_query}")

        # Search posts
        posts = client.app.bsky.feed.search_posts(
            q=search_query,
            limit=min(limit, 100),  # API limits to 100 per call
            sort="latest"
        )

        if posts and posts.posts:
            for post in posts.posts:
                if hasattr(post, 'author') and hasattr(post.author, 'did'):
                    dids.add(post.author.did)
                    print(f"  [FOUND] {post.author.handle} ({post.author.did})")

        print(f"[SEARCH] Found {len(dids)} unique DIDs for #{hashtag}")
        return list(dids)

    except Exception as e:
        print(f"[SEARCH ERROR] Failed to search hashtag: {str(e)}")
        import traceback
        traceback.print_exc()
        return []


# === Step 2: Fetch user profiles ===
def fetch_user_profiles(client: Client, dids: List[str]) -> Dict[str, Dict]:
    """
    Fetch detailed user profile information for each DID.

    Args:
        client: AT Protocol client
        dids: List of user DIDs

    Returns:
        Dict mapping DID -> profile data
    """
    print(f"[PROFILES] Fetching profiles for {len(dids)} users...")

    profiles = {}
    for i, did in enumerate(dids):
        try:
            # Rate limiting
            profile = rate_limited_call(client.app.bsky.actor.get_profile, actor=did)

            # Extract relevant fields
            profiles[did] = {
                "did": profile.did,
                "handle": profile.handle,
                "displayName": getattr(profile, 'display_name', ''),
                "followersCount": getattr(profile, 'followers_count', 0),
                "followsCount": getattr(profile, 'follows_count', 0),
                "postsCount": getattr(profile, 'posts_count', 0),
                "createdAt": getattr(profile, 'created_at', ''),
                "avatar": getattr(profile, 'avatar', '')
            }

            if (i + 1) % 10 == 0:
                print(f"  [PROGRESS] {i + 1}/{len(dids)} profiles fetched")

        except Exception as e:
            print(f"[PROFILES ERROR] Failed to fetch profile for {did}: {str(e)}")
            continue

    print(f"[PROFILES] Successfully fetched {len(profiles)} profiles")
    return profiles


# === Step 3: Build graph edges (follow relationships) ===
def build_graph_edges(client: Client, dids: List[str], profiles: Dict[str, Dict]) -> List[Dict]:
    """
    Build graph edges by fetching follow relationships between users.

    Args:
        client: AT Protocol client
        dids: List of user DIDs in community
        profiles: Dict of user profiles

    Returns:
        List of edge dicts: [{"source": did1, "target": did2, "type": "follows"}]
    """
    print(f"[GRAPH] Building follow relationships...")

    edges = []
    dids_set = set(dids)  # For fast lookup

    for i, did in enumerate(dids):
        try:
            # Get who this user follows (within community)
            follows = rate_limited_call(
                client.app.bsky.graph.get_follows,
                actor=did,
                limit=100
            )

            if follows and follows.follows:
                for follow in follows.follows:
                    if follow.did in dids_set:
                        edges.append({
                            "source": did,
                            "target": follow.did,
                            "type": "follows"
                        })

            if (i + 1) % 10 == 0:
                print(f"  [PROGRESS] {i + 1}/{len(dids)} users processed, {len(edges)} edges found")

        except Exception as e:
            print(f"[GRAPH ERROR] Failed to get follows for {did}: {str(e)}")
            continue

    print(f"[GRAPH] Built {len(edges)} edges")
    return edges


# === Step 4: Generate graph JSON ===
def generate_graph_json(
    hashtag: str,
    profiles: Dict[str, Dict],
    edges: List[Dict]
) -> Dict:
    """
    Generate graph JSON structure for Sigma.js visualization.

    Args:
        hashtag: Source hashtag
        profiles: User profiles dict
        edges: List of edges

    Returns:
        Graph JSON structure
    """
    print(f"[GRAPH JSON] Generating graph structure...")

    # Create nodes
    nodes = [
        {
            "id": did,
            "label": profile.get("handle", did),
            "displayName": profile.get("displayName", ""),
            "followersCount": profile.get("followersCount", 0),
            "followsCount": profile.get("followsCount", 0),
            "postsCount": profile.get("postsCount", 0),
            "createdAt": profile.get("createdAt", ""),
            "avatar": profile.get("avatar", ""),
            "size": max(5, min(50, profile.get("followersCount", 0) / 10))  # Node size based on followers
        }
        for did, profile in profiles.items()
    ]

    graph_json = {
        "nodes": nodes,
        "edges": edges,
        "metadata": {
            "hashtag": hashtag,
            "timestamp": get_jst_now().isoformat(),
            "nodeCount": len(nodes),
            "edgeCount": len(edges),
            "generatedAt": get_jst_now().isoformat()
        }
    }

    print(f"[GRAPH JSON] Generated graph: {len(nodes)} nodes, {len(edges)} edges")
    return graph_json


# === Step 5: Save to S3 ===
def save_graph_to_s3(graph_json: Dict, hashtag: str):
    """
    Save graph JSON to S3.

    Args:
        graph_json: Graph data structure
        hashtag: Hashtag name (for filename)
    """
    try:
        now = get_jst_now()
        timestamp = now.strftime("%Y%m%d_%H%M%S")

        # Sanitize hashtag for filename
        safe_hashtag = hashtag.replace("#", "").replace("/", "_")
        s3_key = f"{S3_PREFIX}{safe_hashtag}/{timestamp}.json"

        # Also save as "latest"
        s3_key_latest = f"{S3_PREFIX}{safe_hashtag}/latest.json"

        # Save to S3
        body = json.dumps(graph_json, ensure_ascii=False, indent=2)

        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=body.encode('utf-8'),
            ContentType="application/json; charset=utf-8"
        )
        print(f"[S3] Saved graph to s3://{S3_BUCKET}/{s3_key}")

        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key_latest,
            Body=body.encode('utf-8'),
            ContentType="application/json; charset=utf-8"
        )
        print(f"[S3] Saved latest graph to s3://{S3_BUCKET}/{s3_key_latest}")

    except Exception as e:
        print(f"[S3 ERROR] Failed to save graph: {str(e)}")
        import traceback
        traceback.print_exc()
        raise


# === Main Lambda Handler ===
def lambda_handler(event, context):
    """
    Main Lambda handler for graph crawler.

    Fetches hashtag posts, extracts users, builds follow graph, saves to S3.
    """
    print("[HANDLER] Starting graph crawler...")
    print(f"[HANDLER] Target hashtags: {TARGET_HASHTAGS}")

    try:
        # Initialize AT Protocol client
        client = Client()
        print("[CLIENT] AT Protocol client initialized")

        # Process each hashtag
        for hashtag in TARGET_HASHTAGS:
            print(f"\n[HANDLER] Processing hashtag: #{hashtag}")

            # Step 1: Search for posts and extract DIDs
            dids = search_hashtag_posts(client, hashtag, limit=USERS_PER_HASHTAG)

            if not dids:
                print(f"[HANDLER] No DIDs found for #{hashtag}, skipping")
                continue

            # Step 2: Fetch user profiles
            profiles = fetch_user_profiles(client, dids)

            if not profiles:
                print(f"[HANDLER] No profiles fetched for #{hashtag}, skipping")
                continue

            # Step 3: Build graph edges
            edges = build_graph_edges(client, dids, profiles)

            # Step 4: Generate graph JSON
            graph_json = generate_graph_json(hashtag, profiles, edges)

            # Step 5: Save to S3
            save_graph_to_s3(graph_json, hashtag)

        print("[HANDLER] Graph crawler completed successfully")
        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Graph crawler completed",
                "hashtags_processed": len(TARGET_HASHTAGS)
            })
        }

    except Exception as e:
        print(f"[HANDLER ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            "statusCode": 500,
            "body": json.dumps({
                "error": str(e)
            })
        }


# === Local Testing ===
if __name__ == "__main__":
    # For local testing
    print("[LOCAL] Testing graph crawler locally...")
    lambda_handler({}, {})
