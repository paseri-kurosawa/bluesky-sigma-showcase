import os
import json
import boto3
import base64
import requests
import time
from datetime import datetime, timedelta, timezone
from typing import Dict
from io import BytesIO
from playwright.sync_api import sync_playwright

s3_client = boto3.client('s3')
JST = timezone(timedelta(hours=9))

S3_BUCKET = os.environ.get('S3_BUCKET', 'bluesky-sigma-showcase-878311109818')
S3_PREFIX = os.environ.get('S3_PREFIX', 'sigma-graph/')

_playwright = None


def get_playwright():
    global _playwright
    if _playwright is None:
        _playwright = sync_playwright().start()
    return _playwright


def build_response(status_code: int, body: Dict) -> Dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        "body": json.dumps(body, ensure_ascii=False)
    }


def download_and_encode_image(url: str) -> str:
    try:
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        img_b64 = base64.b64encode(response.content).decode('utf-8')
        return f"data:image/png;base64,{img_b64}"
    except Exception as e:
        print(f"[WARN] Failed to download image from {url}: {str(e)}")
        return ""


def load_logo_from_file() -> str:
    try:
        logo_path = '/var/task/bluesky_media_kit_logo_transparent_2.png'
        with open(logo_path, 'rb') as f:
            img_b64 = base64.b64encode(f.read()).decode('utf-8')
        return f"data:image/png;base64,{img_b64}"
    except Exception as e:
        print(f"[WARN] Failed to load logo from file: {str(e)}")
        return ""


def generate_share_image(display_name: str, handle: str, avatar_url: str,
                        follower_count: str, follows_count: str, posts_count: str,
                        rank: str, graph_name: str, snapshot_time: str) -> bytes:
    name_bytes = len(display_name.encode('utf-8'))
    if name_bytes <= 30:
        display_name_size = 60
    elif name_bytes <= 54:
        display_name_size = 45
    else:
        display_name_size = 32

    rank_int = int(rank)
    if rank_int < 10:
        star_emoji = "⭐⭐⭐"
    elif rank_int < 100:
        star_emoji = "⭐⭐"
    elif rank_int < 1000:
        star_emoji = "⭐"
    else:
        star_emoji = ""

    avatar_data_uri = download_and_encode_image(avatar_url) if avatar_url else ""
    avatar_img_tag = f'<img class="avatar" src="{avatar_data_uri}" alt="avatar" />' if avatar_data_uri else ''

    logo_data_uri = load_logo_from_file()

    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            width: 1200px;
            height: 630px;
            background: linear-gradient(45deg, white 0%, white 70%, #0066FF 100%);
            font-family: "Noto Sans JP", "Noto Color Emoji", sans-serif;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            padding: 60px 30px 80px 30px;
            position: relative;
            box-sizing: border-box;
        }}
        .container {{
            display: flex;
            gap: 20px;
            align-items: flex-start;
        }}
        .avatar {{
            width: 180px;
            height: 180px;
            border-radius: 50%;
            object-fit: cover;
            flex-shrink: 0;
        }}
        .content {{
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }}
        .display-name {{
            font-size: {display_name_size}px;
            font-weight: 900;
            color: #000;
            word-break: break-word;
            margin-right: 200px;
            margin-bottom: 20px;
            padding-bottom: 20px;
        }}
        .handle {{
            font-size: 32px;
            font-weight: 400;
            color: #646464;
        }}
        .stats {{
            display: flex;
            flex-direction: column;
            gap: 10px;
            font-size: 40px;
            font-weight: 600;
            color: #3c3c3c;
        }}
        .rank {{
            font-size: 40px;
            font-weight: 700;
            color: #ff6b4a;
            margin-top: 10px;
        }}
        .footer {{
            position: absolute;
            bottom: 20px;
            left: 60px;
            right: 60px;
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 40px;
            font-size: 26px;
            font-weight: 400;
            color: #505050;
            box-sizing: border-box;
        }}
        .footer-left {{
            flex-shrink: 0;
            text-align: right;
            order: 3;
        }}
        .footer-right {{
            flex-shrink: 0;
            text-align: right;
            order: 2;
        }}
        .logo {{
            position: absolute;
            top: 45px;
            right: 45px;
            width: 150px;
            height: 150px;
            object-fit: contain;
        }}
    </style>
</head>
<body>
    <img class="logo" src="{logo_data_uri}" alt="logo" />
    <div class="container">
        {avatar_img_tag}
        <div class="content">
            <div class="display-name">{display_name}</div>
            <div class="handle">@{handle}</div>
            <div class="stats">
                <div>Posts: {int(float(posts_count)):,}</div>
                <div>Follows: {int(float(follows_count)):,}</div>
                <div>Followers: {int(float(follower_count)):,}</div>
            </div>
            <div class="rank">{graph_name}  Rank #{rank} {star_emoji}</div>
        </div>
    </div>
    <div class="footer">
        <div class="footer-right">✨ Generated by Sky Star Cluster</div>
        <div class="footer-left">{snapshot_time}</div>
    </div>
</body>
</html>"""

    try:
        print(f"[OGP_IMAGE] Generating image for: {display_name}")

        t0 = time.time()
        pw = get_playwright()
        browser = pw.chromium.launch(args=[
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-zygote',
            '--single-process',
        ])
        t1 = time.time()
        print(f"[TIMING] browser_launch: {t1 - t0:.2f}s")

        page = browser.new_page(viewport={'width': 1200, 'height': 630})
        page.set_content(html_content, wait_until='networkidle')
        t2 = time.time()
        print(f"[TIMING] set_content: {t2 - t1:.2f}s")

        png_data = page.screenshot(type='png', clip={'x': 0, 'y': 0, 'width': 1200, 'height': 630})
        t3 = time.time()
        print(f"[TIMING] screenshot: {t3 - t2:.2f}s")

        page.close()
        browser.close()
        t4 = time.time()
        print(f"[TIMING] Total render: {t4 - t0:.2f}s")

        print(f"[OGP_IMAGE] Generated PNG: {len(png_data)} bytes")
        return png_data

    except Exception as e:
        print(f"[ERROR] Failed: {str(e)}")
        import traceback
        traceback.print_exc()
        raise


def check_s3_exists(handle: str, network: str) -> bool:
    key = f"ogp/{handle}/{network}.png"
    try:
        s3_client.head_object(Bucket=S3_BUCKET, Key=key)
        print(f"[OGP_IMAGE] Image already exists: {key}")
        return True
    except s3_client.exceptions.NoSuchKey:
        print(f"[OGP_IMAGE] Image does not exist: {key}")
        return False
    except Exception as e:
        print(f"[OGP_IMAGE] Error checking S3: {str(e)}")
        return False


def save_to_s3(png_data: bytes, handle: str, network: str) -> str:
    key = f"ogp/{handle}/{network}.png"

    try:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=png_data,
            ContentType='image/png',
            CacheControl='public, max-age=31536000, immutable',
            Metadata={
                'generated-at': datetime.now(JST).isoformat(),
                'handle': handle,
                'network': network
            }
        )
        print(f"[OGP_IMAGE] Saved to S3: s3://{S3_BUCKET}/{key}")
        return f"/{key}"
    except Exception as e:
        print(f"[OGP_IMAGE] Failed to save to S3: {str(e)}")
        raise


def handle_generate_ogp_image(query_params: Dict) -> Dict:
    try:
        handle = query_params.get('handle', '')
        network = query_params.get('network', '')
        display_name = query_params.get('displayName', 'Unknown')
        avatar_url = query_params.get('avatarUrl', '')
        follower_count = query_params.get('followerCount', '0')
        follows_count = query_params.get('followsCount', '0')
        posts_count = query_params.get('postsCount', '0')
        rank = query_params.get('rank', 'N/A')
        graph_name = query_params.get('graphName', 'Network')
        snapshot_time = query_params.get('snapshotTime', 'Unknown')

        if not handle or not network:
            return build_response(400, {
                "error": "Missing required parameters",
                "required": ["handle", "network"]
            })

        if check_s3_exists(handle, network):
            return build_response(200, {
                "status": "exists",
                "path": f"/ogp/{handle}/{network}.png",
                "url": f"https://d1g3djqpjf3j38.cloudfront.net/ogp/{handle}/{network}.png"
            })

        png_data = generate_share_image(
            display_name=display_name,
            handle=handle,
            avatar_url=avatar_url,
            follower_count=str(follower_count),
            follows_count=str(follows_count),
            posts_count=str(posts_count),
            rank=str(rank),
            graph_name=graph_name,
            snapshot_time=snapshot_time
        )

        s3_path = save_to_s3(png_data, handle, network)

        return build_response(200, {
            "status": "created",
            "path": s3_path,
            "url": f"https://d1g3djqpjf3j38.cloudfront.net{s3_path}"
        })

    except Exception as e:
        print(f"[IMAGE ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return build_response(500, {
            "error": "Failed to generate OGP image",
            "message": str(e)
        })


def handle_options() -> Dict:
    return {
        "statusCode": 200,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        "body": ""
    }


def lambda_handler(event, context):
    print(f"[HANDLER] Event: {json.dumps(event)}")

    try:
        http_method = event.get('httpMethod', 'GET')
        path = event.get('path', '/')

        if http_method == 'OPTIONS':
            return handle_options()

        if http_method == 'POST':
            if 'ogp/generate' in path:
                query_params = event.get('queryStringParameters', {}) or {}
                return handle_generate_ogp_image(query_params)
            else:
                return build_response(404, {"error": "Not found", "path": path})

        return build_response(405, {"error": "Method not allowed", "method": http_method})

    except Exception as e:
        print(f"[HANDLER ERROR] {str(e)}")
        import traceback
        traceback.print_exc()
        return build_response(500, {"error": "Internal server error", "message": str(e)})
