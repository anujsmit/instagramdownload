const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 5050);

const YTDLP_BIN =
    process.env.YTDLP_BIN ||
    (process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

const FFMPEG_BIN =
    process.env.FFMPEG_BIN ||
    (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const MAX_VIDEO_SIZE_MB = Number(
    process.env.MAX_VIDEO_SIZE_MB || 250
);

const MAX_VIDEO_SIZE_BYTES =
    MAX_VIDEO_SIZE_MB * 1024 * 1024;

const TEMP_ROOT = path.join(os.tmpdir(), "instagram-downloader");

const IS_PRODUCTION =
    process.env.NODE_ENV === "production";

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(
    cors({
        origin: true,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
    })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| Rate Limiting
|--------------------------------------------------------------------------
*/

const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,

    standardHeaders: true,
    legacyHeaders: false,

    message: {
        success: false,
        error: "Too many download requests. Please try again later.",
    },
});

const metadataLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,

    standardHeaders: true,
    legacyHeaders: false,
});

/*
|--------------------------------------------------------------------------
| Temporary directory
|--------------------------------------------------------------------------
*/

async function ensureTempRoot() {
    await fsp.mkdir(TEMP_ROOT, {
        recursive: true,
    });
}

/*
|--------------------------------------------------------------------------
| Utility: Create unique temporary directory
|--------------------------------------------------------------------------
*/

async function createJobDirectory() {
    await ensureTempRoot();

    const id = crypto.randomBytes(16).toString("hex");

    const dir = path.join(TEMP_ROOT, id);

    await fsp.mkdir(dir, {
        recursive: true,
    });

    return dir;
}

/*
|--------------------------------------------------------------------------
| Utility: Cleanup
|--------------------------------------------------------------------------
*/

async function cleanupDirectory(dir) {
    if (!dir) return;

    try {
        await fsp.rm(dir, {
            recursive: true,
            force: true,
        });
    } catch (error) {
        console.error(
            "[CLEANUP] Failed:",
            error.message
        );
    }
}

/*
|--------------------------------------------------------------------------
| Instagram URL validation
|--------------------------------------------------------------------------
*/

function isInstagramUrl(value) {
    if (!value || typeof value !== "string") {
        return false;
    }

    let url;

    try {
        url = new URL(value.trim());
    } catch {
        return false;
    }

    const hostname = url.hostname
        .toLowerCase()
        .replace(/^www\./, "");

    if (
        hostname !== "instagram.com" &&
        hostname !== "instagram.co"
    ) {
        return false;
    }

    const pathname = url.pathname.toLowerCase();

    return (
        pathname.startsWith("/reel/") ||
        pathname.startsWith("/reels/") ||
        pathname.startsWith("/p/") ||
        pathname.startsWith("/tv/")
    );
}

/*
|--------------------------------------------------------------------------
| Normalize Instagram URL
|--------------------------------------------------------------------------
*/

function normalizeInstagramUrl(value) {
    const url = new URL(value.trim());

    url.hash = "";

    return url.toString();
}

/*
|--------------------------------------------------------------------------
| Safe filename
|--------------------------------------------------------------------------
*/

function safeFilename(value) {
    if (!value) {
        return "instagram-video";
    }

    return value
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 120);
}

/*
|--------------------------------------------------------------------------
| Run yt-dlp
|--------------------------------------------------------------------------
*/

function runYtDlp(args, options = {}) {
    return new Promise((resolve, reject) => {
        console.log(
            "[yt-dlp]",
            YTDLP_BIN,
            args.join(" ")
        );

        const child = spawn(YTDLP_BIN, args, {
            cwd: options.cwd || process.cwd(),
            env: {
                ...process.env,
            },
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
            const text = data.toString();

            stderr += text;

            console.log(
                "[yt-dlp]",
                text.trim()
            );
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve({
                    stdout,
                    stderr,
                });
            } else {
                const error = new Error(
                    `yt-dlp exited with code ${code}`
                );

                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;

                reject(error);
            }
        });
    });
}

/*
|--------------------------------------------------------------------------
| Get metadata
|--------------------------------------------------------------------------
*/

async function getMetadata(url) {
    const args = [
        "--no-warnings",
        "--no-playlist",
        "--dump-single-json",
        "--skip-download",

        // Prefer browser-compatible extraction.
        "--extractor-args",
        "instagram:app_id=936619743392459",

        url,
    ];

    const result = await runYtDlp(args);

    let data;

    try {
        data = JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(
            "Could not parse yt-dlp metadata response."
        );
    }

    return data;
}

/*
|--------------------------------------------------------------------------
| Find downloaded video
|--------------------------------------------------------------------------
*/

async function findVideoFile(directory) {
    const entries = await fsp.readdir(directory, {
        withFileTypes: true,
    });

    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const fullPath = path.join(
            directory,
            entry.name
        );

        const stat = await fsp.stat(fullPath);

        if (stat.size > 0) {
            files.push({
                path: fullPath,
                size: stat.size,
                name: entry.name,
            });
        }
    }

    if (!files.length) {
        return null;
    }

    /*
     * Prefer MP4.
     */
    const mp4 = files.find((file) =>
        file.name.toLowerCase().endsWith(".mp4")
    );

    if (mp4) {
        return mp4;
    }

    /*
     * Otherwise return largest file.
     */
    files.sort((a, b) => b.size - a.size);

    return files[0];
}

/*
|--------------------------------------------------------------------------
| Download Instagram video
|--------------------------------------------------------------------------
*/

async function downloadVideo(url, directory) {
    const outputTemplate = path.join(
        directory,
        "%(id)s.%(ext)s"
    );

    const args = [
        "--no-warnings",
        "--no-playlist",

        /*
         * Best video + audio.
         *
         * If a combined format exists, use it.
         * Otherwise yt-dlp will download video/audio
         * separately and FFmpeg will merge them.
         */
        "-f",
        "bestvideo*+bestaudio/best",

        /*
         * MP4-compatible output.
         */
        "--merge-output-format",
        "mp4",

        /*
         * Let yt-dlp use FFmpeg.
         */
        "--ffmpeg-location",
        FFMPEG_BIN,

        /*
         * Output.
         */
        "-o",
        outputTemplate,

        /*
         * Don't keep intermediate fragments.
         */
        "--no-keep-video",

        /*
         * Instagram URL.
         */
        url,
    ];

    await runYtDlp(args, {
        cwd: directory,
    });

    const video = await findVideoFile(directory);

    if (!video) {
        throw new Error(
            "yt-dlp completed but no video file was created."
        );
    }

    if (video.size > MAX_VIDEO_SIZE_BYTES) {
        throw new Error(
            `Video is larger than the ${MAX_VIDEO_SIZE_MB} MB limit.`
        );
    }

    return video;
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (req, res) => {
    res.json({
        success: true,
        service: "Instagram Video Downloader API",
        status: "ok",
        port: PORT,
        timestamp: new Date().toISOString(),
    });
});

/*
|--------------------------------------------------------------------------
| Metadata
|--------------------------------------------------------------------------
*/

app.get(
    "/api/metadata",
    metadataLimiter,
    async (req, res) => {
        const url = req.query.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing URL.",
            });
        }

        if (!isInstagramUrl(url)) {
            return res.status(400).json({
                success: false,
                error:
                    "Please provide a valid Instagram Reel, Post, or TV URL.",
            });
        }

        try {
            const normalizedUrl =
                normalizeInstagramUrl(url);

            console.log(
                "[METADATA]",
                normalizedUrl
            );

            const info =
                await getMetadata(normalizedUrl);

            return res.json({
                success: true,

                data: {
                    id: info.id || null,

                    title:
                        info.title ||
                        info.description ||
                        "Instagram Video",

                    description:
                        info.description || "",

                    uploader:
                        info.uploader ||
                        info.channel ||
                        null,

                    uploader_id:
                        info.uploader_id ||
                        null,

                    thumbnail:
                        info.thumbnail || null,

                    duration:
                        info.duration || null,

                    width:
                        info.width || null,

                    height:
                        info.height || null,

                    webpage_url:
                        info.webpage_url ||
                        normalizedUrl,
                },
            });
        } catch (error) {
            console.error(
                "[METADATA ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Could not extract Instagram metadata.",
                details:
                    IS_PRODUCTION
                        ? undefined
                        : error.message,
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| Download handler
|--------------------------------------------------------------------------
*/

async function handleDownload(req, res) {
    let tempDirectory = null;

    try {
        const url =
            req.query.url ||
            req.body?.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing Instagram URL.",
            });
        }

        if (!isInstagramUrl(url)) {
            return res.status(400).json({
                success: false,
                error:
                    "Please provide a valid Instagram Reel, Post, or TV URL.",
            });
        }

        const normalizedUrl =
            normalizeInstagramUrl(url);

        console.log(
            "=================================================="
        );

        console.log(
            "[DOWNLOAD]",
            normalizedUrl
        );

        /*
         * Create a unique temporary directory.
         *
         * Nothing is stored permanently.
         */
        tempDirectory =
            await createJobDirectory();

        /*
         * Download.
         */
        const video =
            await downloadVideo(
                normalizedUrl,
                tempDirectory
            );

        console.log(
            "[DOWNLOAD COMPLETE]",
            video.path
        );

        /*
         * Determine filename.
         */
        let filename =
            `instagram-${Date.now()}.mp4`;

        try {
            const metadata =
                await getMetadata(
                    normalizedUrl
                );

            const title =
                safeFilename(
                    metadata.title ||
                    metadata.description ||
                    "instagram-video"
                );

            filename =
                `${title}-${metadata.id || Date.now()}.mp4`;
        } catch {
            /*
             * Metadata isn't required
             * for downloading.
             */
        }

        /*
         * Force browser download.
         */
        res.setHeader(
            "Content-Type",
            "video/mp4"
        );

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
        );

        res.setHeader(
            "Content-Length",
            String(video.size)
        );

        res.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, private"
        );

        res.setHeader(
            "Pragma",
            "no-cache"
        );

        /*
         * Create read stream.
         */
        const stream =
            fs.createReadStream(video.path);

        /*
         * If the client disconnects,
         * stop reading.
         */
        req.on("close", () => {
            if (!res.writableEnded) {
                stream.destroy();
            }
        });

        /*
         * When streaming is finished,
         * remove temporary directory.
         */
        stream.on("close", async () => {
            console.log(
                "[CLEANUP]",
                tempDirectory
            );

            await cleanupDirectory(
                tempDirectory
            );

            tempDirectory = null;
        });

        stream.on("error", async (error) => {
            console.error(
                "[STREAM ERROR]",
                error
            );

            await cleanupDirectory(
                tempDirectory
            );

            tempDirectory = null;
        });

        stream.pipe(res);

    } catch (error) {
        console.error(
            "[DOWNLOAD ERROR]",
            error
        );

        /*
         * Always clean temporary files.
         */
        if (tempDirectory) {
            await cleanupDirectory(
                tempDirectory
            );

            tempDirectory = null;
        }

        if (res.headersSent) {
            try {
                res.end();
            } catch {}
            return;
        }

        let statusCode = 500;

        if (
            error.code === "ENOENT"
        ) {
            statusCode = 500;
        }

        return res.status(statusCode).json({
            success: false,
            error:
                "Unable to download this Instagram video.",

            details:
                IS_PRODUCTION
                    ? undefined
                    : error.message,
        });
    }
}

/*
|--------------------------------------------------------------------------
| GET Download
|--------------------------------------------------------------------------
*/

app.get(
    "/api/download/video",
    downloadLimiter,
    handleDownload
);

/*
|--------------------------------------------------------------------------
| POST Download
|--------------------------------------------------------------------------
*/

app.post(
    "/api/download/video",
    downloadLimiter,
    handleDownload
);

/*
|--------------------------------------------------------------------------
| Clear temporary files
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/cache/clear",
    async (req, res) => {
        try {
            await cleanupDirectory(
                TEMP_ROOT
            );

            await ensureTempRoot();

            return res.json({
                success: true,
                message:
                    "Temporary files cleared.",
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    "Could not clear temporary files.",
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found.",
    });
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
    console.error(
        "[SERVER ERROR]",
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        error: "Internal server error.",
    });
});

/*
|--------------------------------------------------------------------------
| Startup
|--------------------------------------------------------------------------
*/

async function startServer() {
    try {
        await ensureTempRoot();

        console.log(
            "============================================================"
        );

        console.log(
            "Instagram Video Downloader API - Node.js"
        );

        console.log(
            "============================================================"
        );

        console.log(
            `Server: http://0.0.0.0:${PORT}`
        );

        console.log("");
        console.log("Endpoints:");
        console.log(
            `GET  /api/health`
        );
        console.log(
            `GET  /api/metadata?url=INSTAGRAM_URL`
        );
        console.log(
            `GET  /api/download/video?url=INSTAGRAM_URL`
        );
        console.log(
            `POST /api/download/video`
        );
        console.log(
            `DELETE /api/cache/clear`
        );

        console.log("");
        console.log(
            "Temporary storage:",
            TEMP_ROOT
        );

        console.log(
            "Maximum video size:",
            `${MAX_VIDEO_SIZE_MB} MB`
        );

        console.log(
            "============================================================"
        );

        app.listen(PORT, "127.0.0.1", () => {
            console.log(
                `API running on port ${PORT}`
            );
        });

    } catch (error) {
        console.error(
            "Failed to start server:",
            error
        );

        process.exit(1);
    }
}

startServer();