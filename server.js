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

const TEMP_ROOT = path.join(
    os.tmpdir(),
    "instagram-downloader"
);

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
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

app.use(
    express.json({
        limit: "1mb",
    })
);

app.use(
    express.urlencoded({
        extended: true,
    })
);

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
        error:
            "Too many download requests. Please try again later.",
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
| Temporary Directory
|--------------------------------------------------------------------------
*/

async function ensureTempRoot() {
    await fsp.mkdir(TEMP_ROOT, {
        recursive: true,
    });
}

async function createJobDirectory() {
    await ensureTempRoot();

    const id = crypto
        .randomBytes(16)
        .toString("hex");

    const directory = path.join(
        TEMP_ROOT,
        id
    );

    await fsp.mkdir(directory, {
        recursive: true,
    });

    return directory;
}

/*
|--------------------------------------------------------------------------
| Cleanup
|--------------------------------------------------------------------------
*/

async function cleanupDirectory(directory) {
    if (!directory) {
        return;
    }

    try {
        await fsp.rm(directory, {
            recursive: true,
            force: true,
        });

        console.log(
            "[CLEANUP]",
            directory
        );
    } catch (error) {
        console.error(
            "[CLEANUP ERROR]",
            error.message
        );
    }
}

/*
|--------------------------------------------------------------------------
| Instagram URL Validation
|--------------------------------------------------------------------------
*/

function isInstagramUrl(value) {
    if (
        !value ||
        typeof value !== "string"
    ) {
        return false;
    }

    let url;

    try {
        url = new URL(value.trim());
    } catch {
        return false;
    }

    const hostname =
        url.hostname
            .toLowerCase()
            .replace(/^www\./, "");

    if (
        hostname !== "instagram.com" &&
        hostname !== "instagram.co"
    ) {
        return false;
    }

    const pathname =
        url.pathname.toLowerCase();

    return (
        pathname.startsWith("/reel/") ||
        pathname.startsWith("/reels/") ||
        pathname.startsWith("/p/") ||
        pathname.startsWith("/tv/")
    );
}

/*
|--------------------------------------------------------------------------
| Normalize URL
|--------------------------------------------------------------------------
*/

function normalizeInstagramUrl(value) {
    const url = new URL(value.trim());

    url.hash = "";

    return url.toString();
}

/*
|--------------------------------------------------------------------------
| Safe Filename
|--------------------------------------------------------------------------
*/

function safeFilename(value) {
    if (!value) {
        return "Insta-video";
    }

    return value
        .replace(
            /[<>:"/\\|?*\x00-\x1F]/g,
            ""
        )
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 120);
}

/*
|--------------------------------------------------------------------------
| Generic Command Runner
|--------------------------------------------------------------------------
*/

function runCommand(
    command,
    args,
    options = {}
) {
    return new Promise(
        (resolve, reject) => {
            console.log("");
            console.log(
                "[COMMAND]",
                command,
                args.join(" ")
            );

            const child = spawn(
                command,
                args,
                {
                    cwd:
                        options.cwd ||
                        process.cwd(),

                    env: {
                        ...process.env,
                        ...(options.env || {}),
                    },

                    windowsHide: true,
                }
            );

            let stdout = "";
            let stderr = "";

            child.stdout.on(
                "data",
                (data) => {
                    const text =
                        data.toString();

                    stdout += text;

                    console.log(
                        text.trim()
                    );
                }
            );

            child.stderr.on(
                "data",
                (data) => {
                    const text =
                        data.toString();

                    stderr += text;

                    console.log(
                        text.trim()
                    );
                }
            );

            child.on(
                "error",
                (error) => {
                    reject(error);
                }
            );

            child.on(
                "close",
                (code) => {
                    if (code === 0) {
                        resolve({
                            stdout,
                            stderr,
                            code,
                        });

                        return;
                    }

                    const error =
                        new Error(
                            `${command} exited with code ${code}`
                        );

                    error.code = code;
                    error.stdout = stdout;
                    error.stderr = stderr;

                    reject(error);
                }
            );
        }
    );
}

/*
|--------------------------------------------------------------------------
| yt-dlp
|--------------------------------------------------------------------------
*/

async function runYtDlp(
    args,
    options = {}
) {
    return runCommand(
        YTDLP_BIN,
        args,
        options
    );
}

/*
|--------------------------------------------------------------------------
| FFmpeg
|--------------------------------------------------------------------------
*/

async function runFFmpeg(
    args,
    options = {}
) {
    return runCommand(
        FFMPEG_BIN,
        args,
        options
    );
}

/*
|--------------------------------------------------------------------------
| Check Dependencies
|--------------------------------------------------------------------------
*/

async function checkDependencies() {
    console.log(
        "[CHECK] Checking yt-dlp..."
    );

    try {
        const result =
            await runYtDlp([
                "--version",
            ]);

        console.log(
            "[CHECK] yt-dlp:",
            result.stdout.trim()
        );
    } catch (error) {
        console.error(
            "[CHECK] yt-dlp unavailable:",
            error.message
        );
    }

    console.log(
        "[CHECK] Checking FFmpeg..."
    );

    try {
        const result =
            await runFFmpeg([
                "-version",
            ]);

        const firstLine =
            result.stdout
                .split("\n")[0]
                .trim();

        console.log(
            "[CHECK] FFmpeg:",
            firstLine
        );
    } catch (error) {
        console.error(
            "[CHECK] FFmpeg unavailable:",
            error.message
        );
    }
}

/*
|--------------------------------------------------------------------------
| Metadata
|--------------------------------------------------------------------------
*/

async function getMetadata(url) {
    const args = [
        "--no-warnings",
        "--no-playlist",

        "--dump-single-json",
        "--skip-download",

        "--extractor-args",
        "instagram:app_id=936619743392459",

        url,
    ];

    const result =
        await runYtDlp(args);

    let data;

    try {
        data = JSON.parse(
            result.stdout
        );
    } catch {
        throw new Error(
            "Could not parse yt-dlp metadata response."
        );
    }

    return data;
}

/*
|--------------------------------------------------------------------------
| File Exists
|--------------------------------------------------------------------------
*/

async function fileExists(filePath) {
    try {
        const stat =
            await fsp.stat(filePath);

        return (
            stat.isFile() &&
            stat.size > 0
        );
    } catch {
        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Find Downloaded File
|--------------------------------------------------------------------------
*/

async function findFileByPrefix(
    directory,
    prefix,
    extensions
) {
    const entries =
        await fsp.readdir(
            directory,
            {
                withFileTypes: true,
            }
        );

    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (
            !entry.name
                .toLowerCase()
                .startsWith(
                    prefix.toLowerCase() + "."
                )
        ) {
            continue;
        }

        const extension =
            path.extname(
                entry.name
            ).toLowerCase();

        if (
            !extensions.includes(
                extension
            )
        ) {
            continue;
        }

        const fullPath =
            path.join(
                directory,
                entry.name
            );

        const stat =
            await fsp.stat(
                fullPath
            );

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

    files.sort(
        (a, b) =>
            b.size - a.size
    );

    return files[0];
}

/*
|--------------------------------------------------------------------------
| Check Audio Stream
|--------------------------------------------------------------------------
*/

async function hasAudioStream(filePath) {
    try {
        const result =
            await runFFmpeg([
                "-hide_banner",
                "-i",
                filePath,
            ]);

        const output =
            `${result.stdout}\n${result.stderr}`;

        return /Audio:/i.test(output);
    } catch (error) {
        const output =
            `${error.stdout || ""}\n${error.stderr || ""}`;

        return /Audio:/i.test(output);
    }
}

/*
|--------------------------------------------------------------------------
| Check Video Stream
|--------------------------------------------------------------------------
*/

async function hasVideoStream(filePath) {
    try {
        const result =
            await runFFmpeg([
                "-hide_banner",
                "-i",
                filePath,
            ]);

        const output =
            `${result.stdout}\n${result.stderr}`;

        return /Video:/i.test(output);
    } catch (error) {
        const output =
            `${error.stdout || ""}\n${error.stderr || ""}`;

        return /Video:/i.test(output);
    }
}

/*
|--------------------------------------------------------------------------
| Merge Video + Audio
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| Input:
|   video-source.mp4
|   audio-source.m4a
|
| Output:
|   final.mp4
|
| NEVER use video-source.mp4 as the output.
|
|--------------------------------------------------------------------------
*/

async function mergeVideoAndAudio(
    videoFile,
    audioFile,
    outputFile
) {
    console.log("");
    console.log(
        "[MERGE] Video:",
        videoFile
    );

    console.log(
        "[MERGE] Audio:",
        audioFile
    );

    console.log(
        "[MERGE] Output:",
        outputFile
    );

    /*
    |--------------------------------------------------------------------------
    | Make absolutely sure output isn't one of the inputs
    |--------------------------------------------------------------------------
    */

    const normalizedVideo =
        path.resolve(videoFile);

    const normalizedAudio =
        path.resolve(audioFile);

    const normalizedOutput =
        path.resolve(outputFile);

    if (
        normalizedOutput ===
        normalizedVideo
    ) {
        throw new Error(
            "Merge output cannot be the same as the video input."
        );
    }

    if (
        normalizedOutput ===
        normalizedAudio
    ) {
        throw new Error(
            "Merge output cannot be the same as the audio input."
        );
    }

    /*
    |--------------------------------------------------------------------------
    | FFmpeg
    |--------------------------------------------------------------------------
    */

    const args = [
        "-y",

        "-i",
        videoFile,

        "-i",
        audioFile,

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        /*
        | Keep original VP9 video.
        | No unnecessary video re-encoding.
        */

        "-c:v",
        "copy",

        /*
        | Convert audio to AAC for broad MP4 compatibility.
        */

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        /*
        | Helps MP4 start playing before entire file loads.
        */

        "-movflags",
        "+faststart",

        outputFile,
    ];

    await runFFmpeg(args);

    if (
        !(await fileExists(outputFile))
    ) {
        throw new Error(
            "FFmpeg did not create the merged MP4."
        );
    }

    console.log(
        "[MERGE] Successfully created:",
        outputFile
    );
}

/*
|--------------------------------------------------------------------------
| Download Video
|--------------------------------------------------------------------------
*/

async function downloadVideo(
    url,
    directory
) {
    /*
    |--------------------------------------------------------------------------
    | Fixed temporary filenames
    |--------------------------------------------------------------------------
    */

    const videoTemplate =
        path.join(
            directory,
            "video-source.%(ext)s"
        );

    const audioTemplate =
        path.join(
            directory,
            "audio-source.%(ext)s"
        );

    /*
    |--------------------------------------------------------------------------
    | IMPORTANT:
    |
    | final.mp4 is NEVER used as a source.
    |--------------------------------------------------------------------------
    */

    const finalOutput =
        path.join(
            directory,
            "final.mp4"
        );

    /*
    |--------------------------------------------------------------------------
    | STEP 1 - Video
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[DOWNLOAD] Step 1: Downloading video..."
    );

    const videoArgs = [
        "--no-warnings",
        "--no-playlist",

        /*
        | Instagram exposes DASH video-only streams.
        */

        "-f",
        "bestvideo",

        "-o",
        videoTemplate,

        url,
    ];

    await runYtDlp(
        videoArgs,
        {
            cwd: directory,
        }
    );

    const videoFile =
        await findFileByPrefix(
            directory,
            "video-source",
            [
                ".mp4",
                ".webm",
                ".mkv",
            ]
        );

    if (!videoFile) {
        throw new Error(
            "Video stream could not be downloaded."
        );
    }

    console.log(
        "[DOWNLOAD] Video stream:",
        videoFile.path
    );

    console.log(
        "[DOWNLOAD] Video size:",
        `${(
            videoFile.size /
            1024 /
            1024
        ).toFixed(2)} MB`
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 2 - Audio
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[DOWNLOAD] Step 2: Downloading audio..."
    );

    const audioArgs = [
        "--no-warnings",
        "--no-playlist",

        "-f",
        "bestaudio",

        "-o",
        audioTemplate,

        url,
    ];

    await runYtDlp(
        audioArgs,
        {
            cwd: directory,
        }
    );

    const audioFile =
        await findFileByPrefix(
            directory,
            "audio-source",
            [
                ".m4a",
                ".aac",
                ".mp3",
                ".webm",
                ".opus",
            ]
        );

    if (!audioFile) {
        throw new Error(
            "Audio stream could not be downloaded."
        );
    }

    console.log(
        "[DOWNLOAD] Audio stream:",
        audioFile.path
    );

    console.log(
        "[DOWNLOAD] Audio size:",
        `${(
            audioFile.size /
            1024
        ).toFixed(2)} KB`
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 3 - Verify source video
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[VERIFY] Checking source video..."
    );

    const sourceHasVideo =
        await hasVideoStream(
            videoFile.path
        );

    if (!sourceHasVideo) {
        throw new Error(
            "Downloaded video stream is invalid."
        );
    }

    console.log(
        "[VERIFY] Video stream OK."
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 4 - Verify source audio
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[VERIFY] Checking source audio..."
    );

    const sourceHasAudio =
        await hasAudioStream(
            audioFile.path
        );

    if (!sourceHasAudio) {
        throw new Error(
            "Downloaded audio stream is invalid."
        );
    }

    console.log(
        "[VERIFY] Audio stream OK."
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 5 - Merge
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[DOWNLOAD] Step 3: Merging video + audio..."
    );

    await mergeVideoAndAudio(
        videoFile.path,
        audioFile.path,
        finalOutput
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 6 - Verify final file
    |--------------------------------------------------------------------------
    */

    console.log("");
    console.log(
        "[VERIFY] Checking final MP4..."
    );

    const finalHasVideo =
        await hasVideoStream(
            finalOutput
        );

    const finalHasAudio =
        await hasAudioStream(
            finalOutput
        );

    if (!finalHasVideo) {
        throw new Error(
            "Final MP4 does not contain a video stream."
        );
    }

    if (!finalHasAudio) {
        throw new Error(
            "Final MP4 does not contain an audio stream."
        );
    }

    console.log(
        "[VERIFY] Final video stream: OK"
    );

    console.log(
        "[VERIFY] Final audio stream: OK"
    );

    /*
    |--------------------------------------------------------------------------
    | Step 7 - Size check
    |--------------------------------------------------------------------------
    */

    const stat =
        await fsp.stat(
            finalOutput
        );

    if (
        stat.size >
        MAX_VIDEO_SIZE_BYTES
    ) {
        throw new Error(
            `Video is larger than ${MAX_VIDEO_SIZE_MB} MB.`
        );
    }

    console.log("");
    console.log(
        "[DOWNLOAD COMPLETE]",
        finalOutput
    );

    console.log(
        "[DOWNLOAD SIZE]",
        `${(
            stat.size /
            1024 /
            1024
        ).toFixed(2)} MB`
    );

    return {
        path: finalOutput,
        size: stat.size,
        name: "final.mp4",
    };
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
    "/api/health",
    async (req, res) => {
        res.json({
            success: true,

            service:
                "Instagram Video Downloader API",

            status: "ok",

            port: PORT,

            ytDlp:
                YTDLP_BIN,

            ffmpeg:
                FFMPEG_BIN,

            maxVideoSizeMB:
                MAX_VIDEO_SIZE_MB,

            timestamp:
                new Date().toISOString(),
        });
    }
);

/*
|--------------------------------------------------------------------------
| Metadata
|--------------------------------------------------------------------------
*/

app.get(
    "/api/metadata",
    metadataLimiter,
    async (req, res) => {
        const url =
            req.query.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing URL.",
            });
        }

        if (
            !isInstagramUrl(url)
        ) {
            return res.status(400).json({
                success: false,

                error:
                    "Please provide a valid Instagram Reel, Post, or TV URL.",
            });
        }

        try {
            const normalizedUrl =
                normalizeInstagramUrl(
                    url
                );

            console.log(
                "[METADATA]",
                normalizedUrl
            );

            const info =
                await getMetadata(
                    normalizedUrl
                );

            return res.json({
                success: true,

                data: {
                    id:
                        info.id ||
                        null,

                    title:
                        info.title ||
                        info.description ||
                        "Instagram Video",

                    description:
                        info.description ||
                        "",

                    uploader:
                        info.uploader ||
                        info.channel ||
                        null,

                    uploader_id:
                        info.uploader_id ||
                        null,

                    thumbnail:
                        info.thumbnail ||
                        null,

                    duration:
                        info.duration ||
                        null,

                    width:
                        info.width ||
                        null,

                    height:
                        info.height ||
                        null,

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
| Download Handler
|--------------------------------------------------------------------------
*/

async function handleDownload(
    req,
    res
) {
    let tempDirectory = null;
    let stream = null;

    try {
        const url =
            req.query.url ||
            req.body?.url;

        if (!url) {
            return res.status(400).json({
                success: false,

                error:
                    "Missing Instagram URL.",
            });
        }

        if (
            !isInstagramUrl(url)
        ) {
            return res.status(400).json({
                success: false,

                error:
                    "Please provide a valid Instagram Reel, Post, or TV URL.",
            });
        }

        const normalizedUrl =
            normalizeInstagramUrl(
                url
            );

        console.log("");
        console.log(
            "=================================================="
        );

        console.log(
            "[DOWNLOAD]",
            normalizedUrl
        );

        console.log(
            "=================================================="
        );

        /*
        |--------------------------------------------------------------------------
        | Create temporary directory
        |--------------------------------------------------------------------------
        */

        tempDirectory =
            await createJobDirectory();

        /*
        |--------------------------------------------------------------------------
        | Download + merge
        |--------------------------------------------------------------------------
        */

        const video =
            await downloadVideo(
                normalizedUrl,
                tempDirectory
            );

        /*
        |--------------------------------------------------------------------------
        | Generate filename
        |--------------------------------------------------------------------------
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
                    "instagram-video-downloaded-from-anujkatteldotcomnp"
                );

            filename =
                `${title}-${metadata.id || Date.now()}.mp4`;
        } catch (error) {
            console.log(
                "[FILENAME] Metadata unavailable."
            );
        }

        /*
        |--------------------------------------------------------------------------
        | Headers
        |--------------------------------------------------------------------------
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

        res.setHeader(
            "Accept-Ranges",
            "bytes"
        );

        /*
        |--------------------------------------------------------------------------
        | Stream
        |--------------------------------------------------------------------------
        */

        stream =
            fs.createReadStream(
                video.path
            );

        stream.on(
            "error",
            async (error) => {
                console.error(
                    "[STREAM ERROR]",
                    error
                );

                await cleanupDirectory(
                    tempDirectory
                );

                tempDirectory =
                    null;
            }
        );

        stream.on(
            "close",
            async () => {
                console.log(
                    "[STREAM] Closed."
                );

                await cleanupDirectory(
                    tempDirectory
                );

                tempDirectory =
                    null;
            }
        );

        req.on(
            "close",
            () => {
                if (
                    stream &&
                    !res.writableEnded
                ) {
                    console.log(
                        "[CLIENT] Disconnected."
                    );

                    stream.destroy();
                }
            }
        );

        stream.pipe(res);
    } catch (error) {
        console.error(
            "[DOWNLOAD ERROR]",
            error
        );

        if (stream) {
            try {
                stream.destroy();
            } catch {}
        }

        if (tempDirectory) {
            await cleanupDirectory(
                tempDirectory
            );

            tempDirectory =
                null;
        }

        if (res.headersSent) {
            try {
                res.end();
            } catch {}

            return;
        }

        return res.status(500).json({
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
| Clear Cache
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
            console.error(
                "[CACHE ERROR]",
                error
            );

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

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,

            error:
                "Endpoint not found.",
        });
    }
);

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "[SERVER ERROR]",
            error
        );

        if (
            res.headersSent
        ) {
            return next(error);
        }

        res.status(500).json({
            success: false,

            error:
                "Internal server error.",
        });
    }
);

/*
|--------------------------------------------------------------------------
| Start Server
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
            `Server: http://127.0.0.1:${PORT}`
        );

        console.log(
            "yt-dlp:",
            YTDLP_BIN
        );

        console.log(
            "FFmpeg:",
            FFMPEG_BIN
        );

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

        await checkDependencies();

        app.listen(
            PORT,
            "127.0.0.1",
            () => {
                console.log(
                    `API running on port ${PORT}`
                );

                console.log(
                    "=================================================="
                );
            }
        );
    } catch (error) {
        console.error(
            "Failed to start server:",
            error
        );

        process.exit(1);
    }
}

startServer();