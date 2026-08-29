import os
import re
import shutil
import tempfile
import logging
import time
import hashlib
from datetime import datetime
from urllib.parse import urlparse
from functools import wraps
from typing import Optional, Dict, Any, Tuple

import yt_dlp
from flask import (
    Flask,
    request,
    jsonify,
    send_file,
    after_this_request,
    g
)
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv
import redis
from redis import Redis

# Load environment variables
load_dotenv()

# ============================================================
# CONFIGURATION
# ============================================================

class Config:
    """Application configuration."""
    
    # Server
    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", 5000))
    DEBUG = os.getenv("DEBUG", "False").lower() == "true"
    
    # Redis (optional, fallback to in-memory cache)
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    USE_REDIS = os.getenv("USE_REDIS", "False").lower() == "true"
    
    # Cache
    CACHE_TTL = int(os.getenv("CACHE_TTL", 3600))  # 1 hour
    CACHE_MAX_SIZE = int(os.getenv("CACHE_MAX_SIZE", 1000))
    
    # Rate Limiting
    RATELIMIT_DEFAULT = os.getenv("RATELIMIT_DEFAULT", "30 per minute")
    RATELIMIT_DOWNLOAD = os.getenv("RATELIMIT_DOWNLOAD", "10 per minute")
    RATELIMIT_METADATA = os.getenv("RATELIMIT_METADATA", "20 per minute")
    
    # Download
    DOWNLOAD_TIMEOUT = int(os.getenv("DOWNLOAD_TIMEOUT", 60))
    MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE", 100 * 1024 * 1024))  # 100MB
    ALLOWED_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov"}
    
    # Security
    SECRET_KEY = os.getenv("SECRET_KEY", os.urandom(24).hex())
    ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
    
    # Logging
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
    LOG_FILE = os.getenv("LOG_FILE", "app.log")

# ============================================================
# LOGGING SETUP
# ============================================================

def setup_logging():
    """Configure logging for production."""
    
    log_level = getattr(logging, Config.LOG_LEVEL.upper(), logging.INFO)
    
    # Create formatters
    detailed_formatter = logging.Formatter(
        '[%(levelname)s] %(asctime)s - %(name)s - %(filename)s:%(lineno)d - %(message)s'
    )
    simple_formatter = logging.Formatter(
        '[%(levelname)s] %(asctime)s - %(message)s'
    )
    
    # Root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(log_level)
    console_handler.setFormatter(simple_formatter if Config.DEBUG else detailed_formatter)
    root_logger.addHandler(console_handler)
    
    # File handler
    if Config.LOG_FILE:
        try:
            file_handler = logging.FileHandler(Config.LOG_FILE, encoding='utf-8')
            file_handler.setLevel(log_level)
            file_handler.setFormatter(detailed_formatter)
            root_logger.addHandler(file_handler)
        except Exception as e:
            root_logger.warning(f"Could not create log file: {e}")
    
    return root_logger

logger = setup_logging()

# ============================================================
# CACHE SETUP
# ============================================================

class Cache:
    """Cache manager with Redis or in-memory fallback."""
    
    def __init__(self):
        self.redis_client = None
        self.memory_cache = {}
        self.use_redis = False
        
        if Config.USE_REDIS:
            try:
                self.redis_client = Redis.from_url(
                    Config.REDIS_URL,
                    decode_responses=True,
                    socket_timeout=5,
                    socket_connect_timeout=5
                )
                self.redis_client.ping()
                self.use_redis = True
                logger.info("Redis cache connected successfully")
            except Exception as e:
                logger.warning(f"Redis connection failed, using memory cache: {e}")
                self.use_redis = False
    
    def get(self, key: str) -> Optional[Any]:
        """Get value from cache."""
        try:
            if self.use_redis:
                value = self.redis_client.get(key)
                return value
            else:
                return self.memory_cache.get(key)
        except Exception as e:
            logger.error(f"Cache get error: {e}")
            return None
    
    def set(self, key: str, value: Any, ttl: int = Config.CACHE_TTL) -> bool:
        """Set value in cache with TTL."""
        try:
            if self.use_redis:
                self.redis_client.setex(key, ttl, value)
            else:
                self.memory_cache[key] = value
                # Prune if too large
                if len(self.memory_cache) > Config.CACHE_MAX_SIZE:
                    # Remove oldest entries
                    keys_to_remove = list(self.memory_cache.keys())[:Config.CACHE_MAX_SIZE // 2]
                    for k in keys_to_remove:
                        del self.memory_cache[k]
            return True
        except Exception as e:
            logger.error(f"Cache set error: {e}")
            return False
    
    def delete(self, key: str) -> bool:
        """Delete from cache."""
        try:
            if self.use_redis:
                self.redis_client.delete(key)
            else:
                self.memory_cache.pop(key, None)
            return True
        except Exception as e:
            logger.error(f"Cache delete error: {e}")
            return False
    
    def clear(self) -> bool:
        """Clear all cache."""
        try:
            if self.use_redis:
                self.redis_client.flushdb()
            else:
                self.memory_cache.clear()
            return True
        except Exception as e:
            logger.error(f"Cache clear error: {e}")
            return False

cache = Cache()

# ============================================================
# FLASK APP SETUP
# ============================================================

app = Flask(__name__)
app.config['SECRET_KEY'] = Config.SECRET_KEY
app.config['MAX_CONTENT_LENGTH'] = Config.MAX_FILE_SIZE

# CORS setup
CORS(app, origins=Config.ALLOWED_ORIGINS)

# Rate Limiter
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=[Config.RATELIMIT_DEFAULT],
    storage_uri="memory://",
)

# ============================================================
# REQUEST MIDDLEWARE
# ============================================================

@app.before_request
def before_request():
    """Log incoming requests and validate origin."""
    g.start_time = time.time()
    g.request_id = hashlib.md5(
        f"{time.time()}{request.remote_addr}".encode()
    ).hexdigest()[:16]
    
    logger.info(
        f"Request {g.request_id}: {request.method} {request.path} "
        f"from {request.remote_addr}"
    )

@app.after_request
def after_request(response):
    """Log response time and add security headers."""
    if hasattr(g, 'start_time'):
        elapsed = time.time() - g.start_time
        logger.info(
            f"Response {g.request_id}: {response.status_code} "
            f"in {elapsed:.3f}s"
        )
    
    # Security headers
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    
    return response

# ============================================================
# URL VALIDATION
# ============================================================

def is_instagram_url(url: str) -> bool:
    """Validate if URL is from Instagram."""
    if not url:
        return False
    
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return False
        
        hostname = hostname.lower()
        allowed_hosts = {
            "instagram.com",
            "www.instagram.com",
            "m.instagram.com",
            "instagr.am",
            "www.instagr.am"
        }
        
        return hostname in allowed_hosts
    except Exception:
        return False

def normalize_instagram_url(url: str) -> str:
    """Normalize Instagram URL formats."""
    url = url.strip()
    url = url.rstrip("/")
    
    # Convert /reels/ to /reel/
    url = re.sub(r'(instagram\.com)/reels/', r'\1/reel/', url, flags=re.IGNORECASE)
    url = re.sub(r'(www\.instagram\.com)/reels/', r'\1/reel/', url, flags=re.IGNORECASE)
    
    return url

def extract_shortcode(url: str) -> Optional[str]:
    """Extract shortcode from Instagram URL."""
    patterns = [
        r'instagram\.com/reel/([a-zA-Z0-9_-]+)',
        r'instagram\.com/p/([a-zA-Z0-9_-]+)',
        r'instagram\.com/tv/([a-zA-Z0-9_-]+)',
        r'instagram\.com/stories/[a-zA-Z0-9_-]+/([a-zA-Z0-9_-]+)',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, url, re.IGNORECASE)
        if match:
            return match.group(1)
    
    return None

# ============================================================
# FILE MANAGEMENT
# ============================================================

def cleanup_directory(directory: str) -> None:
    """Delete temporary download directory."""
    if not directory:
        return
    
    try:
        if os.path.exists(directory):
            shutil.rmtree(directory, ignore_errors=True)
            logger.info(f"Cleaned up: {directory}")
    except Exception as e:
        logger.error(f"Cleanup failed: {e}")

def find_video_file(directory: str) -> Optional[str]:
    """Find video file in directory."""
    if not os.path.exists(directory):
        return None
    
    video_files = []
    for filename in os.listdir(directory):
        path = os.path.join(directory, filename)
        if not os.path.isfile(path):
            continue
        
        ext = os.path.splitext(filename)[1].lower()
        if ext in Config.ALLOWED_EXTENSIONS:
            video_files.append(path)
    
    if not video_files:
        return None
    
    # Prefer MP4
    mp4_files = [f for f in video_files if f.lower().endswith(".mp4")]
    if mp4_files:
        return mp4_files[0]
    
    return video_files[0]

def safe_filename(title: str) -> str:
    """Create safe filename from title."""
    if not title:
        title = "instagram_video"
    
    title = str(title)
    
    # Remove invalid characters
    title = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "", title)
    title = re.sub(r'\s+', " ", title).strip()
    
    # Limit length
    title = title[:100]
    
    if not title:
        title = "instagram_video"
    
    return title

# ============================================================
# YT-DLP OPTIONS
# ============================================================

def create_ydl_options(output_directory: str) -> Dict[str, Any]:
    """Create yt-dlp configuration."""
    output_template = os.path.join(output_directory, "video.%(ext)s")
    
    return {
        "outtmpl": output_template,
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "socket_timeout": Config.DOWNLOAD_TIMEOUT,
        "retries": 3,
        "extract_flat": False,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
        "overwrites": True,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }

# ============================================================
# METADATA EXTRACTION
# ============================================================

def extract_metadata(url: str) -> Dict[str, Any]:
    """Extract Instagram metadata without downloading."""
    temp_directory = tempfile.mkdtemp(prefix="ig_metadata_")
    
    try:
        options = create_ydl_options(temp_directory)
        options["skip_download"] = True
        
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
        
        if not info:
            raise Exception("No information returned by yt-dlp")
        
        return {
            "success": True,
            "title": info.get("title", "Instagram Video"),
            "description": info.get("description", ""),
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "uploader": info.get("uploader") or info.get("channel") or "Unknown",
            "width": info.get("width"),
            "height": info.get("height"),
            "webpage_url": info.get("webpage_url"),
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
        }
    finally:
        cleanup_directory(temp_directory)

# ============================================================
# VIDEO DOWNLOAD
# ============================================================

def download_instagram_video(url: str) -> Tuple[str, str, str, Dict[str, Any]]:
    """Download Instagram video to temporary directory."""
    temp_directory = tempfile.mkdtemp(prefix="ig_download_")
    logger.info(f"Temporary directory: {temp_directory}")
    
    try:
        options = create_ydl_options(temp_directory)
        logger.info(f"Starting download: {url}")
        
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
        
        if not info:
            raise Exception("yt-dlp did not return video information")
        
        video_file = find_video_file(temp_directory)
        if not video_file:
            raise Exception("Downloaded video file was not found")
        
        logger.info(f"Video downloaded: {video_file}")
        
        title = safe_filename(info.get("title", "instagram_video"))
        return temp_directory, video_file, title, info
        
    except Exception:
        cleanup_directory(temp_directory)
        raise

# ============================================================
# API ENDPOINTS
# ============================================================

@app.route("/api/health", methods=["GET"])
def health():
    """Health check endpoint."""
    cache_status = "redis" if cache.use_redis else "memory"
    
    return jsonify({
        "success": True,
        "status": "ok",
        "service": "Instagram Video Downloader API",
        "version": "1.0.0",
        "yt_dlp_version": yt_dlp.version.__version__,
        "cache": cache_status,
        "timestamp": datetime.utcnow().isoformat()
    })

@app.route("/api/metadata", methods=["GET"])
@limiter.limit(Config.RATELIMIT_METADATA)
def metadata():
    """Get video metadata without downloading."""
    url = request.args.get("url", "").strip()
    
    if not url:
        return jsonify({
            "success": False,
            "error": "Instagram URL is required"
        }), 400
    
    if not is_instagram_url(url):
        return jsonify({
            "success": False,
            "error": "Please provide a valid Instagram URL"
        }), 400
    
    url = normalize_instagram_url(url)
    logger.info(f"Metadata request: {url}")
    
    # Check cache
    cache_key = f"metadata:{hashlib.md5(url.encode()).hexdigest()}"
    cached = cache.get(cache_key)
    if cached:
        try:
            import json
            return jsonify(json.loads(cached))
        except:
            pass
    
    try:
        result = extract_metadata(url)
        
        # Cache result
        if result.get("success"):
            import json
            cache.set(cache_key, json.dumps(result))
        
        return jsonify(result)
        
    except yt_dlp.utils.DownloadError as e:
        logger.exception("yt-dlp metadata error")
        return jsonify({
            "success": False,
            "error": "Instagram did not provide accessible video information.",
            "details": str(e)
        }), 404
        
    except Exception as e:
        logger.exception("Metadata error")
        return jsonify({
            "success": False,
            "error": "Unable to retrieve video information.",
            "details": str(e)
        }), 500

@app.route("/api/download/video", methods=["POST", "GET"])
@limiter.limit(Config.RATELIMIT_DOWNLOAD)
def download_video():
    """Download Instagram video."""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        url = data.get("url", "").strip()
    else:
        url = request.args.get("url", "").strip()
    
    return process_download(url)

def process_download(url: str):
    """Process video download request."""
    if not url:
        return jsonify({
            "success": False,
            "error": "Instagram URL is required"
        }), 400
    
    if not is_instagram_url(url):
        return jsonify({
            "success": False,
            "error": "Only Instagram URLs are supported"
        }), 400
    
    url = normalize_instagram_url(url)
    logger.info(f"Download request: {url}")
    
    # Check cache for direct URL
    cache_key = f"video:{hashlib.md5(url.encode()).hexdigest()}"
    cached = cache.get(cache_key)
    
    if cached:
        try:
            import json
            data = json.loads(cached)
            if data.get("video_file") and os.path.exists(data["video_file"]):
                # Return cached video
                return send_file(
                    data["video_file"],
                    mimetype="video/mp4",
                    as_attachment=True,
                    download_name=data.get("title", "instagram_video.mp4")
                )
        except:
            pass
    
    temp_directory = None
    
    try:
        temp_directory, video_file, title, info = download_instagram_video(url)
        
        @after_this_request
        def remove_temp_files(response):
            cleanup_directory(temp_directory)
            return response
        
        # Cache metadata for future requests
        import json
        cache.set(
            cache_key,
            json.dumps({
                "video_file": video_file,
                "title": f"{title}.mp4"
            }),
            ttl=300  # 5 minutes cache for video files
        )
        
        return send_file(
            video_file,
            mimetype="video/mp4",
            as_attachment=True,
            download_name=f"{title}.mp4",
            max_age=0
        )
        
    except yt_dlp.utils.DownloadError as e:
        if temp_directory:
            cleanup_directory(temp_directory)
        logger.exception("yt-dlp download failed")
        return jsonify({
            "success": False,
            "error": "Unable to download this Instagram video.",
            "details": str(e)
        }), 404
        
    except Exception as e:
        if temp_directory:
            cleanup_directory(temp_directory)
        logger.exception("Download failed")
        return jsonify({
            "success": False,
            "error": "An error occurred while processing the video.",
            "details": str(e)
        }), 500

@app.route("/api/cache/clear", methods=["DELETE"])
def clear_cache():
    """Clear cache."""
    cache.clear()
    return jsonify({
        "success": True,
        "message": "Cache cleared successfully"
    })

@app.route("/api/cache/stats", methods=["GET"])
def cache_stats():
    """Get cache statistics."""
    return jsonify({
        "success": True,
        "type": "redis" if cache.use_redis else "memory",
        "status": "active"
    })

# ============================================================
# ERROR HANDLERS
# ============================================================

@app.errorhandler(404)
def not_found(error):
    return jsonify({
        "success": False,
        "error": "Endpoint not found"
    }), 404

@app.errorhandler(405)
def method_not_allowed(error):
    return jsonify({
        "success": False,
        "error": "HTTP method not allowed"
    }), 405

@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "success": False,
        "error": "Request too large"
    }), 413

@app.errorhandler(429)
def rate_limit_exceeded(error):
    return jsonify({
        "success": False,
        "error": "Rate limit exceeded. Please try again later."
    }), 429

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify({
        "success": False,
        "error": "Internal server error"
    }), 500

# ============================================================
# START SERVER
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("Instagram Video Downloader API (Production)")
    print("=" * 60)
    print(f"Server: http://{Config.HOST}:{Config.PORT}")
    print()
    print("Endpoints:")
    print("GET  /api/health")
    print("GET  /api/metadata?url=INSTAGRAM_URL")
    print("GET  /api/download/video?url=INSTAGRAM_URL")
    print("POST /api/download/video")
    print("DELETE /api/cache/clear")
    print("GET  /api/cache/stats")
    print("=" * 60)
    print(f"Cache: {'Redis' if cache.use_redis else 'Memory'}")
    print(f"Rate Limiting: Enabled")
    print(f"Log Level: {Config.LOG_LEVEL}")
    print("=" * 60)
    
    app.run(
        host=Config.HOST,
        port=Config.PORT,
        debug=Config.DEBUG
    )