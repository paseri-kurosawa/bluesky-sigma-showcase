import os
import json
import time
import boto3
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from typing import List, Dict, Set, Tuple, Optional

# AT Protocol
from atproto import Client, client_utils

# AWS Clients
s3_client = boto3.client('s3')
secrets_client = boto3.client('secretsmanager', region_name='ap-northeast-1')

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

        # Search posts using Pydantic model from atproto client
        from atproto_client.models.app.bsky.feed.search_posts import Params

        # Import Params for search_posts
        from atproto_client.models.app.bsky.feed.search_posts import Params as SearchParams

        search_params = SearchParams(
            q=search_query,
            limit=min(limit, 100)
        )
        posts = client.app.bsky.feed.search_posts(search_params)

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
            # Import Params for get_profile
            from atproto_client.models.app.bsky.actor.get_profile import Params as GetProfileParams

            # Rate limiting
            profile_params = GetProfileParams(actor=did)
            profile = rate_limited_call(client.app.bsky.actor.get_profile, profile_params)

            # Extract relevant fields
            profiles[did] = {
                "did": profile.did,
                "handle": profile.handle,
                "displayName": getattr(profile, 'display_name', ''),
                "followersCount": getattr(profile, 'followers_count', 0),
                "followsCount": getattr(profile, 'follows_count', 0),
                "postsCount": getattr(profile, 'posts_count', 0),
                "createdAt": getattr(profile, 'created_at', ''),
                "avatar": getattr(profile, 'avatar', ''),
                "updated_at": get_jst_now().isoformat()
            }

            if (i + 1) % 10 == 0:
                print(f"  [PROGRESS] {i + 1}/{len(dids)} profiles fetched")

        except Exception as e:
            print(f"[PROFILES ERROR] Failed to fetch profile for {did}: {str(e)}")
            continue

    print(f"[PROFILES] Successfully fetched {len(profiles)} profiles")
    return profiles


# === Step 3: Build graph edges (follow relationships) ===
def build_graph_edges(client: Client, new_dids: List[str], merged_profiles: Dict[str, Dict], existing_dids: List[str]) -> List[Dict]:
    """
    Build graph edges from new users only (cumulative graph, not full recomputation).

    Edge computation:
    - New users → new users (within new_dids)
    - New users → existing users

    Existing users' follow relationships are not updated (assumed unchanged from previous batch).

    Args:
        client: AT Protocol client
        new_dids: List of newly fetched user DIDs
        merged_profiles: Dict of all user profiles (new + existing)
        existing_dids: List of existing user DIDs from previous data

    Returns:
        List of edge dicts: [{"source": did1, "target": did2, "type": "follows"}]
    """
    print(f"[GRAPH] Building comprehensive follow relationships...")

    edges = []
    new_dids_set = set(new_dids)
    existing_dids_set = set(existing_dids)
    all_dids_set = new_dids_set | existing_dids_set

    from atproto_client.models.app.bsky.graph.get_follows import Params as GetFollowsParams

    # Phase 1 & 2: Process new users
    # Edges: new → new AND new → existing
    print(f"[GRAPH] Phase 1-2: Processing {len(new_dids)} new users...")
    new_edges = 0

    for i, did in enumerate(new_dids):
        try:
            follows_params = GetFollowsParams(actor=did, limit=100)
            follows = rate_limited_call(
                client.app.bsky.graph.get_follows,
                follows_params
            )

            if follows and follows.follows:
                for follow in follows.follows:
                    if follow.did in all_dids_set:  # Check against ALL users (new + existing)
                        edges.append({
                            "source": did,
                            "target": follow.did,
                            "type": "follows"
                        })
                        new_edges += 1

            if (i + 1) % 10 == 0:
                print(f"  [PROGRESS] {i + 1}/{len(new_dids)} new users processed, {new_edges} edges")

        except Exception as e:
            print(f"[GRAPH ERROR] Failed to get follows for new user {did}: {str(e)}")
            continue

    print(f"[GRAPH] Phase 1-2: Found {new_edges} edges from new users")
    print(f"[GRAPH] Total edges built: {len(edges)}")

    # Mark mutual follows
    print(f"[GRAPH] Marking mutual follows...")
    edge_pairs = set()
    for edge in edges:
        edge_pairs.add((edge['source'], edge['target']))

    mutual_count = 0
    for edge in edges:
        reverse_pair = (edge['target'], edge['source'])
        if reverse_pair in edge_pairs:
            edge['mutual'] = True
            mutual_count += 1
        else:
            edge['mutual'] = False

    print(f"[GRAPH] Found {mutual_count} mutual follows, {len(edges) - mutual_count} unilateral follows")
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


# === Step 4.5: Merge with previous data ===
def merge_with_previous_graph(new_graph: Dict, hashtag: str) -> Dict:
    """
    Merge new graph data with previous accumulated data.

    Args:
        new_graph: Newly fetched graph data
        hashtag: Hashtag name

    Returns:
        Merged graph with accumulated users and edges
    """
    print(f"[MERGE] Merging with previous data...")

    # Try to load previous data
    safe_hashtag = hashtag.replace("#", "").replace("/", "_")
    s3_key_merged = f"{S3_PREFIX}{safe_hashtag}/users_merged.json"

    previous_data = None
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key_merged)
        previous_data = json.loads(response['Body'].read().decode('utf-8'))
        print(f"[MERGE] Loaded previous data with {len(previous_data.get('nodes', []))} users")
    except s3_client.exceptions.NoSuchKey:
        print(f"[MERGE] No previous data found (first run)")
    except Exception as e:
        print(f"[MERGE ERROR] Failed to load previous data: {str(e)}")

    if not previous_data:
        print(f"[MERGE] Using new data as baseline")
        return new_graph

    # Merge nodes: existing users UPDATE, new users ADD
    previous_nodes_dict = {node['id']: node for node in previous_data.get('nodes', [])}
    new_nodes_dict = {node['id']: node for node in new_graph.get('nodes', [])}

    # Update existing users with new profile data
    for did, new_node in new_nodes_dict.items():
        previous_nodes_dict[did] = new_node

    merged_nodes = list(previous_nodes_dict.values())

    # Merge edges: de-duplicate by (source, target) pair, preserve mutual flag
    previous_edges = previous_data.get('edges', [])
    new_edges = new_graph.get('edges', [])

    edge_dict = {}  # Use dict to deduplicate by (source, target)

    for edge in previous_edges + new_edges:
        edge_key = (edge['source'], edge['target'])
        # If edge already exists, update with new data (which may have updated mutual flag)
        if edge_key not in edge_dict:
            edge_dict[edge_key] = edge
        else:
            # Preserve mutual flag from new data if available
            if 'mutual' in edge:
                edge_dict[edge_key]['mutual'] = edge['mutual']

    merged_edges_list = list(edge_dict.values())

    merged_graph = {
        "nodes": merged_nodes,
        "edges": merged_edges_list,
        "metadata": {
            "hashtag": hashtag,
            "timestamp": new_graph["metadata"]["timestamp"],
            "updated_at": get_jst_now().isoformat(),
            "nodeCount": len(merged_nodes),
            "edgeCount": len(merged_edges_list)
        }
    }

    print(f"[MERGE] Merged result: {len(merged_nodes)} total users, {len(merged_edges_list)} total edges")
    return merged_graph


# === Step 5: Save to S3 ===
def save_graph_to_s3(graph_json: Dict, hashtag: str):
    """
    Save merged graph JSON to S3.

    Args:
        graph_json: Merged graph data structure
        hashtag: Hashtag name (for filename)
    """
    try:
        # Sanitize hashtag for filename
        safe_hashtag = hashtag.replace("#", "").replace("/", "_")
        s3_key_merged = f"{S3_PREFIX}{safe_hashtag}/users_merged.json"

        # Save to S3
        body = json.dumps(graph_json, ensure_ascii=False, indent=2)

        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key_merged,
            Body=body.encode('utf-8'),
            ContentType="application/json; charset=utf-8"
        )
        print(f"[S3] Saved merged graph to s3://{S3_BUCKET}/{s3_key_merged}")

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
        # Initialize AT Protocol client with authentication
        client = Client()

        # Get credentials from Secrets Manager
        try:
            secret = secrets_client.get_secret_value(
                SecretId='bluesky-feed-jp/credentials'
            )
            credentials = json.loads(secret['SecretString'])
            handle = credentials.get('handle')
            app_password = credentials.get('appPassword')

            # Login with correct argument names
            client.login(login=handle, password=app_password)
            print(f"[CLIENT] Logged in as {handle}")
        except Exception as e:
            print(f"[CLIENT] Warning: Could not authenticate: {str(e)}")
            print("[CLIENT] Proceeding with unauthenticated client...")

        print("[CLIENT] AT Protocol client initialized")

        # Process each hashtag
        for hashtag in TARGET_HASHTAGS:
            print(f"\n[HANDLER] Processing hashtag: #{hashtag}")

            # Step 1: Search for posts and extract DIDs (new users)
            new_dids = search_hashtag_posts(client, hashtag, limit=USERS_PER_HASHTAG)

            if not new_dids:
                print(f"[HANDLER] No DIDs found for #{hashtag}, skipping")
                continue

            # Step 2: Fetch user profiles (new users)
            new_profiles = fetch_user_profiles(client, new_dids)

            if not new_profiles:
                print(f"[HANDLER] No profiles fetched for #{hashtag}, skipping")
                continue

            # Step 2.5: Load existing data to build comprehensive edges
            safe_hashtag = hashtag.replace("#", "").replace("/", "_")
            s3_key_merged = f"{S3_PREFIX}{safe_hashtag}/users_merged.json"
            existing_data = None
            existing_dids = []
            existing_profiles = {}

            try:
                response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key_merged)
                existing_data = json.loads(response['Body'].read().decode('utf-8'))
                existing_dids = [node['id'] for node in existing_data.get('nodes', [])]
                existing_profiles = {node['id']: node for node in existing_data.get('nodes', [])}
                print(f"[HANDLER] Loaded {len(existing_dids)} existing users")
            except s3_client.exceptions.NoSuchKey:
                print(f"[HANDLER] No existing data found (first run)")
            except Exception as e:
                print(f"[HANDLER] Warning: Could not load existing data: {str(e)}")

            # Merge profiles: new + existing
            merged_profiles = {**existing_profiles, **new_profiles}

            # Step 3: Build graph edges (3 phases: new→new, new→existing, existing→new)
            edges = build_graph_edges(client, new_dids, merged_profiles, existing_dids)

            # Step 4: Generate graph JSON (new users only)
            graph_json = generate_graph_json(hashtag, new_profiles, edges)

            # Step 4.5: Merge with previous data
            merged_graph = merge_with_previous_graph(graph_json, hashtag)

            # Step 5: Save to S3
            save_graph_to_s3(merged_graph, hashtag)

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
