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
USERS_PER_HASHTAG = config.get("crawler", {}).get("users_per_hashtag", 500)
RATE_LIMIT_PER_SECOND = config.get("crawler", {}).get("rate_limit_per_second", 5)
S3_BUCKET = config.get("storage", {}).get("s3_bucket", "bluesky-sigma-showcase")
S3_PREFIX = config.get("storage", {}).get("s3_prefix", "sigma-graph/")


# === Helper Functions ===
def get_jst_now():
    """Get current time in JST"""
    return datetime.now(JST)


def write_completion_marker(category: str, timestamp: int):
    """Write completion marker to S3 for Scheduler polling"""
    try:
        marker_key = f"crawler-status/{category}-{timestamp}.complete"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=marker_key,
            Body=json.dumps({
                'category': category,
                'timestamp': timestamp,
                'completed_at': get_jst_now().isoformat()
            })
        )
        print(f"[MARKER] Wrote completion marker: {marker_key}")
        return True
    except Exception as e:
        print(f"[MARKER ERROR] Failed to write completion marker: {str(e)}")
        return False


def rate_limited_call(func, *args, **kwargs):
    """Rate-limited API call wrapper"""
    time.sleep(1.0 / RATE_LIMIT_PER_SECOND)
    return func(*args, **kwargs)


# === Step 1: Search for hashtag posts and extract DIDs ===
def search_hashtag_posts(client: Client, hashtag: str, limit: int = 100) -> Tuple[List[str], Dict[str, str]]:
    """
    Search for posts with specific hashtag and extract author DIDs and their latest post times.

    Args:
        client: AT Protocol client
        hashtag: Hashtag to search (e.g., "おはようvtuber")
        limit: Number of posts to retrieve

    Returns:
        Tuple of (List of unique DIDs, Dict mapping DID -> latest post indexed_at)
    """
    print(f"[SEARCH] Searching for #{hashtag} posts...")

    dids = set()
    last_post_times = {}
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
                    did = post.author.did
                    dids.add(did)
                    # Record the latest post time (posts are in newest-first order)
                    if did not in last_post_times:
                        indexed_at = getattr(post, 'indexed_at', '')
                        last_post_times[did] = indexed_at
                    print(f"  [FOUND] {post.author.handle} ({did}) - last post: {last_post_times.get(did, 'N/A')}")

        print(f"[SEARCH] Found {len(dids)} unique DIDs for #{hashtag}")
        return list(dids), last_post_times

    except Exception as e:
        print(f"[SEARCH ERROR] Failed to search hashtag: {str(e)}")
        import traceback
        traceback.print_exc()
        return [], {}


# === Step 2: Fetch user profiles ===
def fetch_user_profiles(client: Client, dids: List[str], last_post_times: Dict[str, str] = None, hashtag: str = None) -> Dict[str, Dict]:
    """
    Fetch detailed user profile information for each DID.

    Args:
        client: AT Protocol client
        dids: List of user DIDs
        last_post_times: Optional dict mapping DID -> indexed_at of latest post
        hashtag: The hashtag this profile group belongs to

    Returns:
        Dict mapping DID -> profile data
    """
    print(f"[PROFILES] Fetching profiles for {len(dids)} users from #{hashtag}...")

    if last_post_times is None:
        last_post_times = {}

    profiles = {}
    for i, did in enumerate(dids):
        try:
            # Import Params for get_profile
            from atproto_client.models.app.bsky.actor.get_profile import Params as GetProfileParams

            # Rate limiting
            profile_params = GetProfileParams(actor=did)
            profile = rate_limited_call(client.app.bsky.actor.get_profile, profile_params)

            # Extract relevant fields
            # Convert lastPostAt from UTC to JST
            last_post_at_utc = last_post_times.get(did, '')
            last_post_at_jst = ''
            if last_post_at_utc:
                try:
                    # Parse UTC timestamp and convert to JST
                    utc_time = datetime.fromisoformat(last_post_at_utc.replace('Z', '+00:00'))
                    jst_time = utc_time.astimezone(JST)
                    last_post_at_jst = jst_time.isoformat()
                except:
                    last_post_at_jst = last_post_at_utc  # Fallback to original if conversion fails

            node_data = {
                "did": profile.did,
                "handle": profile.handle,
                "displayName": getattr(profile, 'display_name', ''),
                "followersCount": getattr(profile, 'followers_count', 0),
                "followsCount": getattr(profile, 'follows_count', 0),
                "postsCount": getattr(profile, 'posts_count', 0),
                "createdAt": getattr(profile, 'created_at', ''),
                "avatar": getattr(profile, 'avatar', ''),
                "lastPostAt": last_post_at_jst,
            }

            # Add hashtags if provided
            if hashtag:
                node_data["hashtags"] = [hashtag]

            profiles[did] = node_data

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
            "lastPostAt": profile.get("lastPostAt", ""),
            "hashtags": profile.get("hashtags", [hashtag] if hashtag else []),
            "size": max(5, min(50, profile.get("followersCount", 0) / 10))  # Node size based on followers
        }
        for did, profile in profiles.items()
    ]

    node_count = len(nodes)
    edge_count = len(edges)
    density = edge_count / (node_count * (node_count - 1)) if node_count > 1 else 0
    average_degree = (edge_count * 2) / node_count if node_count > 0 else 0

    # Extract and count all unique hashtags from nodes
    hashtag_counts = {}
    hashtag_active_counts = {}
    now = get_jst_now()
    for node in nodes:
        last_post = node.get("lastPostAt", "")
        is_active = False
        if last_post:
            try:
                diff = (now - datetime.fromisoformat(last_post)).total_seconds()
                is_active = diff <= 7200
            except (ValueError, TypeError):
                pass
        for tag in node.get("hashtags", []):
            hashtag_counts[tag] = hashtag_counts.get(tag, 0) + 1
            if is_active:
                hashtag_active_counts[tag] = hashtag_active_counts.get(tag, 0) + 1

    hashtags_list = [
        {"tag": tag, "nodeCount": count, "activeCount": hashtag_active_counts.get(tag, 0)}
        for tag, count in sorted(hashtag_counts.items())
    ]

    graph_json = {
        "nodes": nodes,
        "edges": edges,
        "metadata": {
            "hashtag": hashtag,
            "timestamp": get_jst_now().isoformat(),
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "density": round(density, 6),
            "averageDegree": round(average_degree, 2),
            "generatedAt": get_jst_now().isoformat(),
            "hashtags": hashtags_list
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
        if did in previous_nodes_dict:
            # Merge hashtags: preserve existing + add new
            existing_hashtags = previous_nodes_dict[did].get('hashtags', [])
            new_hashtags = new_node.get('hashtags', [])
            merged_hashtags = list(set(existing_hashtags + new_hashtags))  # De-duplicate
            new_node['hashtags'] = merged_hashtags

        previous_nodes_dict[did] = new_node

    # Ensure all nodes have hashtags attribute (even those not in new_nodes_dict)
    for node in previous_nodes_dict.values():
        if 'hashtags' not in node or node['hashtags'] is None:
            node['hashtags'] = []

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

    merged_node_count = len(merged_nodes)
    merged_edge_count = len(merged_edges_list)
    merged_density = merged_edge_count / (merged_node_count * (merged_node_count - 1)) if merged_node_count > 1 else 0
    merged_average_degree = (merged_edge_count * 2) / merged_node_count if merged_node_count > 0 else 0

    # Recompute hashtag counts and active counts from merged nodes
    hashtag_counts = {}
    hashtag_active_counts = {}
    now = get_jst_now()
    for node in merged_nodes:
        last_post = node.get("lastPostAt", "")
        is_active = False
        if last_post:
            try:
                diff = (now - datetime.fromisoformat(last_post)).total_seconds()
                is_active = diff <= 7200
            except (ValueError, TypeError):
                pass
        for tag in node.get("hashtags", []):
            hashtag_counts[tag] = hashtag_counts.get(tag, 0) + 1
            if is_active:
                hashtag_active_counts[tag] = hashtag_active_counts.get(tag, 0) + 1

    hashtags_list = [
        {"tag": tag, "nodeCount": count, "activeCount": hashtag_active_counts.get(tag, 0)}
        for tag, count in sorted(hashtag_counts.items())
    ]

    merged_graph = {
        "nodes": merged_nodes,
        "edges": merged_edges_list,
        "metadata": {
            "hashtag": hashtag,
            "timestamp": new_graph["metadata"]["timestamp"],
            "updated_at": get_jst_now().isoformat(),
            "nodeCount": merged_node_count,
            "edgeCount": merged_edge_count,
            "density": round(merged_density, 6),
            "averageDegree": round(merged_average_degree, 2),
            "hashtags": hashtags_list
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


# === Step 6: Calculate TOP5 users by influence score ===
def calculate_top5_users(graph_json: Dict, config: Dict) -> List[Dict]:
    """
    Calculate TOP5 most influential users in the graph.

    Scoring formula:
    - 片方向フォロー: one_way_follower_weight pt per edge
    - 相互フォロー: mutual_follower_weight pt per edge (not double-counted)
    - ポスト数: log_base(postsCount) * posts_count_weight pt

    Args:
        graph_json: Graph data with nodes and edges
        config: Configuration dict with scoring parameters

    Returns:
        List of TOP5 users with scores
    """
    import math

    nodes = {node['id']: node for node in graph_json.get('nodes', [])}
    edges = graph_json.get('edges', [])

    # Load scoring parameters from config
    scoring_config = config.get('ranking', {}).get('scoring', {})
    one_way_weight = scoring_config.get('one_way_follower_weight', 1.0)
    mutual_weight = scoring_config.get('mutual_follower_weight', 1.5)
    posts_base = scoring_config.get('posts_count_base', 100)
    posts_weight = scoring_config.get('posts_count_weight', 1.0)
    top_n = config.get('ranking', {}).get('top_n', 5)

    # Count followers and mutual followers for each node
    follower_count = defaultdict(int)
    mutual_count = defaultdict(int)

    for edge in edges:
        source = edge['source']
        target = edge['target']
        is_mutual = edge.get('mutual', False)

        # target receives a follower
        follower_count[target] += 1

        # If mutual, count it separately
        if is_mutual:
            mutual_count[target] += 1

    # Calculate scores for all nodes
    scores = []
    for node_id, node_data in nodes.items():
        one_way_followers = follower_count[node_id] - mutual_count[node_id]
        mutual_followers = mutual_count[node_id]
        posts_count = node_data.get('postsCount', 1)

        # Score formula: one_way * weight1 + mutual * weight2 + log_base(posts) * weight3
        try:
            log_score = math.log(max(posts_count, 1), posts_base) * posts_weight
        except ValueError:
            log_score = 0

        score = (one_way_followers * one_way_weight) + (mutual_followers * mutual_weight) + log_score

        scores.append({
            'id': node_id,
            'displayName': node_data.get('displayName', node_data.get('label', '')),
            'avatar': node_data.get('avatar', ''),
            'score': round(score, 2),
            'stats': {
                'one_way_followers': one_way_followers,
                'mutual_followers': mutual_followers,
                'posts_count': posts_count
            }
        })

    # Sort by score descending and return all users ranked
    scores.sort(key=lambda x: x['score'], reverse=True)
    return scores


# === Step 7: Merge hashtags into category-unified graph ===
def merge_hashtags_for_category(category: str, hashtags: List[str]) -> Optional[Dict]:
    """
    Merge graphs from all hashtags in a category into a single unified graph.
    Each node tracks which hashtags it belongs to.

    Args:
        category: Category name (e.g., "unified_vtuber")
        hashtags: List of hashtags in this category

    Returns:
        Unified graph JSON with all nodes and edges, or None if no data found
    """
    print(f"[CATEGORY] Merging {len(hashtags)} hashtags for category: {category}")

    unified_nodes_dict = {}  # DID -> node
    node_hashtags_map = {}  # DID -> list of hashtags
    unified_edges_set = set()  # (source, target) pairs
    edge_mutual_map = {}  # (source, target) -> mutual flag

    # Load each hashtag's data from S3
    for hashtag in hashtags:
        safe_hashtag = hashtag.replace("#", "").replace("/", "_")
        s3_key_merged = f"{S3_PREFIX}{safe_hashtag}/users_merged.json"

        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key_merged)
            hashtag_data = json.loads(response['Body'].read().decode('utf-8'))

            # Add nodes and track hashtag membership
            for node in hashtag_data.get('nodes', []):
                node_id = node['id']

                # Initialize hashtag list if not exists
                if node_id not in node_hashtags_map:
                    node_hashtags_map[node_id] = []

                # Add this hashtag to the node's list
                if hashtag not in node_hashtags_map[node_id]:
                    node_hashtags_map[node_id].append(hashtag)

                # Store/update node
                unified_nodes_dict[node_id] = node

            # Add edges (deduplicate by (source, target) pair, preserve mutual flag)
            for edge in hashtag_data.get('edges', []):
                edge_key = (edge['source'], edge['target'])
                unified_edges_set.add(edge_key)
                # Preserve mutual flag from this edge
                edge_mutual_map[edge_key] = edge.get('mutual', False)

            print(f"[CATEGORY] Loaded {len(hashtag_data.get('nodes', []))} nodes from #{hashtag}")

        except s3_client.exceptions.NoSuchKey:
            print(f"[CATEGORY] No data found for #{hashtag}, skipping")
        except Exception as e:
            print(f"[CATEGORY ERROR] Failed to load #{hashtag}: {str(e)}")
            continue

    if not unified_nodes_dict:
        print(f"[CATEGORY] No nodes found for category {category}")
        return None

    # Add hashtags attribute to each node
    for node_id, node in unified_nodes_dict.items():
        node['hashtags'] = node_hashtags_map.get(node_id, [])

    print(f"[CATEGORY] Added hashtag tracking to {len(unified_nodes_dict)} nodes")

    # Reconstruct edges from set with mutual flags preserved
    unified_edges = [
        {
            "source": source,
            "target": target,
            "type": "follows",
            "mutual": edge_mutual_map.get((source, target), False)
        }
        for source, target in unified_edges_set
    ]

    unified_node_count = len(unified_nodes_dict)
    unified_edge_count = len(unified_edges)
    unified_density = unified_edge_count / (unified_node_count * (unified_node_count - 1)) if unified_node_count > 1 else 0
    unified_average_degree = (unified_edge_count * 2) / unified_node_count if unified_node_count > 0 else 0

    # Extract and count all unique hashtags from nodes
    unified_hashtag_counts = {}
    unified_hashtag_active_counts = {}
    now = get_jst_now()
    for node in unified_nodes_dict.values():
        last_post = node.get("lastPostAt", "")
        is_active = False
        if last_post:
            try:
                diff = (now - datetime.fromisoformat(last_post)).total_seconds()
                is_active = diff <= 7200
            except (ValueError, TypeError):
                pass
        for tag in node.get("hashtags", []):
            unified_hashtag_counts[tag] = unified_hashtag_counts.get(tag, 0) + 1
            if is_active:
                unified_hashtag_active_counts[tag] = unified_hashtag_active_counts.get(tag, 0) + 1

    unified_hashtags_list = [
        {"tag": tag, "nodeCount": count, "activeCount": unified_hashtag_active_counts.get(tag, 0)}
        for tag, count in sorted(unified_hashtag_counts.items())
    ]

    # Create a temporary graph object to calculate top users
    temp_graph_data = {
        "nodes": list(unified_nodes_dict.values()),
        "edges": unified_edges
    }

    # Calculate top users for category graph
    top_users = calculate_top5_users(temp_graph_data, {"top_k": 100})

    unified_graph = {
        "nodes": list(unified_nodes_dict.values()),
        "edges": unified_edges,
        "metadata": {
            "category": category,
            "timestamp": get_jst_now().isoformat(),
            "updated_at": get_jst_now().isoformat(),
            "nodeCount": unified_node_count,
            "edgeCount": unified_edge_count,
            "density": round(unified_density, 6),
            "averageDegree": round(unified_average_degree, 2),
            "source_hashtags": hashtags,
            "hashtags": unified_hashtags_list
        },
        "top_users": top_users
    }

    print(f"[CATEGORY] Category graph: {len(unified_nodes_dict)} total nodes, {len(unified_edges)} total edges, {len(top_users)} top users")
    return unified_graph


def save_unified_graph_to_s3(graph: Dict, category: str) -> bool:
    """
    Save unified category graph to S3.

    Args:
        graph: Unified graph dictionary
        category: Category name (e.g., "unified_vtuber")

    Returns:
        True if successful, False otherwise
    """
    try:
        s3_key = f"{S3_PREFIX}{category}/users_merged.json"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=json.dumps(graph, ensure_ascii=False),
            ContentType='application/json'
        )
        print(f"[S3] Saved unified category graph to {s3_key}")
        return True
    except Exception as e:
        print(f"[S3 ERROR] Failed to save unified graph for {category}: {str(e)}")
        return False


def generate_hashtags_list():
    """
    Generate list of available hashtags by scanning S3 sigma-graph/ prefix.
    Returns only unified_* categories (category aggregations).

    Returns:
        List of hashtag strings (e.g., ['unified_food', 'unified_anime', ...])
    """
    try:
        hashtags = []
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=S3_BUCKET, Prefix=S3_PREFIX, Delimiter='/')

        for page in pages:
            if 'CommonPrefixes' not in page:
                continue

            for prefix_info in page['CommonPrefixes']:
                prefix = prefix_info['Prefix']
                # Extract hashtag name from prefix (e.g., "sigma-graph/unified_food/" -> "unified_food")
                hashtag = prefix.replace(S3_PREFIX, '').rstrip('/')

                # Only include unified_* categories
                if hashtag.startswith('unified_'):
                    hashtags.append(hashtag)

        print(f"[HASHTAGS] Found {len(hashtags)} hashtags: {hashtags}")
        return sorted(hashtags)
    except Exception as e:
        print(f"[HASHTAGS ERROR] Failed to list hashtags: {str(e)}")
        return []


def save_hashtags_list_to_s3(hashtags: List[str]):
    """
    Save hashtags list as JSON to S3 for CloudFront delivery.

    Args:
        hashtags: List of hashtag strings
    """
    try:
        hashtags_data = {
            "hashtags": hashtags,
            "count": len(hashtags),
            "updated_at": get_jst_now().isoformat()
        }

        s3_key = f"{S3_PREFIX}hashtags.json"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=json.dumps(hashtags_data, ensure_ascii=False, indent=2),
            ContentType='application/json'
        )
        print(f"[S3] Saved hashtags list to {s3_key}")
        return True
    except Exception as e:
        print(f"[S3 ERROR] Failed to save hashtags list: {str(e)}")
        return False


# === Main Lambda Handler ===
def lambda_handler(event, context):
    """
    Main Lambda handler for graph crawler.

    Fetches hashtag posts, extracts users, builds follow graph, saves to S3.
    After processing all hashtags in a category, merges them into a unified graph.
    """
    print("[HANDLER] Starting graph crawler...")

    # Get category and hashtags from event payload (from scheduler)
    category = event.get('category')
    hashtags = event.get('hashtags', [])
    print(f"[HANDLER] Processing category: {category}")
    print(f"[HANDLER] Processing hashtags: {hashtags}")

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
        for hashtag in hashtags:
            print(f"\n[HANDLER] Processing hashtag: #{hashtag}")

            # Step 1: Search for posts and extract DIDs (new users)
            new_dids, last_post_times = search_hashtag_posts(client, hashtag, limit=USERS_PER_HASHTAG)

            if not new_dids:
                print(f"[HANDLER] No DIDs found for #{hashtag}, skipping")
                continue

            # Step 2: Fetch user profiles (new users)
            new_profiles = fetch_user_profiles(client, new_dids, last_post_times, hashtag)

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

            # Step 4.6: Calculate TOP5 users and add to graph
            top_users = calculate_top5_users(merged_graph, config)
            merged_graph['top_users'] = top_users
            print(f"[TOP5] Calculated TOP5 for #{hashtag}: {[u['displayName'] for u in top_users]}")

            # Step 5: Save to S3
            save_graph_to_s3(merged_graph, hashtag)

        # === Step 6: Merge all hashtags in this category into unified graph ===
        if category and hashtags:
            print(f"[HANDLER] Merging hashtags for category: {category}")
            unified_graph = merge_hashtags_for_category(category, hashtags)
            if unified_graph:
                save_unified_graph_to_s3(unified_graph, category)
                print(f"[HANDLER] Successfully saved unified graph for {category}")

        # === Step 7: Generate and save hashtags list for CloudFront ===
        print("[HANDLER] Generating hashtags list...")
        hashtags_list = generate_hashtags_list()
        if hashtags_list:
            save_hashtags_list_to_s3(hashtags_list)
            print(f"[HANDLER] Successfully saved hashtags list ({len(hashtags_list)} items)")
        else:
            print("[HANDLER] Warning: No hashtags found or failed to generate list")

        # === Step 8: Write completion marker for Scheduler ===
        # Must use timestamp provided by Scheduler (passed in event)
        timestamp = int(event['timestamp'])
        write_completion_marker(category, timestamp)

        print("[HANDLER] Graph crawler completed successfully")
        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Graph crawler completed",
                "hashtags_processed": len(hashtags),
                "category": category
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
